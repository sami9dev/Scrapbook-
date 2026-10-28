use axum::{
    extract::{Path, State},
    response::{Html, IntoResponse},
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use std::sync::Arc;
use tracing::{error, info, warn};

use crate::config::Config;
use crate::error::AppError;
use crate::http_client::HttpClient;
use crate::models::*;
use crate::parser::*;
use crate::queue::{chrono_or_simple_timestamp, AppState};
use crate::security::validate_url;

#[derive(Clone)]
pub struct ServerContext {
    pub state: AppState,
    pub http_client: HttpClient,
    pub config: Config,
}

pub fn create_router(ctx: ServerContext) -> Router {
    Router::new()
        .route("/", get(serve_index))
        .route("/health", get(health_check))
        .route("/api/scrape", post(handle_scrape))
        .route("/api/reset", post(handle_reset))
        .route("/api/jobs/:id", get(handle_get_job))
        .route("/api/jobs", get(handle_list_jobs))
        .route("/api/links", get(handle_list_links))
        .route("/api/parse-html", post(handle_parse_html))
        .route("/api/resolve-link", post(handle_resolve_link))
        .route("/api/stats", get(handle_get_stats))
        .with_state(Arc::new(ctx))
}

async fn serve_index() -> impl IntoResponse {
    // Read the existing frontend file from ../src/public/index.html
    match tokio::fs::read_to_string("../src/public/index.html").await {
        Ok(html) => Html(html).into_response(),
        Err(_) => match tokio::fs::read_to_string("src/public/index.html").await {
            Ok(html) => Html(html).into_response(),
            Err(e) => (
                axum::http::StatusCode::NOT_FOUND,
                format!("Frontend index.html not found: {}", e),
            )
                .into_response(),
        },
    }
}

async fn health_check(State(ctx): State<Arc<ServerContext>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        uptime_secs: ctx.state.start_time.elapsed().as_secs(),
    })
}

async fn handle_reset(State(ctx): State<Arc<ServerContext>>) -> Result<Json<ResetResponse>, AppError> {
    let (deleted_links, deleted_jobs) = ctx.state.clear_all().await;
    info!(
        category = "DATABASE",
        "Reset in-memory storage: cleared {} links and {} jobs", deleted_links, deleted_jobs
    );

    Ok(Json(ResetResponse {
        success: true,
        message: "All scraped records and jobs have been reset.",
        deleted_links,
        deleted_jobs,
    }))
}

async fn handle_scrape(
    State(ctx): State<Arc<ServerContext>>,
    Json(req): Json<ScrapeRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let raw_url = req.url.trim();
    if raw_url.is_empty() {
        return Err(AppError::InvalidUrl("Field 'url' is required.".to_string()));
    }

    // SSRF protection
    let validated = validate_url(raw_url).map_err(AppError::SsrfBlocked)?;

    if req.reset.unwrap_or(false) || req.auto_reset.unwrap_or(false) {
        ctx.state.clear_all().await;
    }

    let job_id = format!("job_{}", chrono_or_simple_timestamp());
    let target_quality = req.quality.or(req.target_quality).unwrap_or_else(|| "all".to_string());
    let target_scope = req.scope.or(req.target_scope).unwrap_or_else(|| "all".to_string());

    let job = Job {
        id: job_id.clone(),
        url: validated.to_string(),
        status: "PENDING".to_string(),
        target_quality: target_quality.clone(),
        target_scope: target_scope.clone(),
        extracted_count: 0,
        created_at: chrono_or_simple_timestamp(),
        updated_at: chrono_or_simple_timestamp(),
        error: None,
    };

    ctx.state.add_job(job.clone()).await;

    // Spawn background task to process the scrape job
    let ctx_clone = ctx.clone();
    let job_url = validated.to_string();
    let j_id = job_id.clone();
    let t_quality = target_quality.clone();

    tokio::spawn(async move {
        ctx_clone.state.update_job_status(&j_id, "PARSING", 0, None).await;

        match ctx_clone.http_client.fetch_html(&job_url).await {
            Ok((body, final_url)) => {
                let parse_res = parse_4khdhub_html(&body, &final_url);

                let mut saved_count = 0;
                for item in parse_res.links {
                    if matches_quality(item.quality.as_deref(), &t_quality) {
                        saved_count += 1;
                        let record = ScrapedRecord {
                            id: format!("rec_{}_{}", j_id, saved_count),
                            source_url: job_url.clone(),
                            source_domain: final_url.clone(),
                            title: item.title,
                            quality: item.quality,
                            scope: item.scope,
                            season: item.season,
                            episode: item.episode,
                            codec: item.codec,
                            size_display: item.size_display,
                            provider: item.provider,
                            provider_url: None,
                            mediator_url: Some(item.mediator_url),
                            file_id: None,
                            filename: None,
                            status: "DISCOVERED".to_string(),
                            created_at: chrono_or_simple_timestamp(),
                            duration_ms: None,
                        };
                        ctx_clone.state.save_link(record).await;
                    }
                }

                ctx_clone
                    .state
                    .update_job_status(&j_id, "RESOLVED", saved_count, None)
                    .await;
            }
            Err(e) => {
                error!(category = "ERROR", "Scrape job failed: {}", e);
                ctx_clone
                    .state
                    .update_job_status(&j_id, "ERROR", 0, Some(e.to_string()))
                    .await;
            }
        }
    });

    Ok(Json(json!({
        "jobId": job.id,
        "status": job.status,
        "url": job.url,
        "targetQuality": job.target_quality,
        "targetScope": job.target_scope,
        "createdAt": job.created_at
    })))
}

async fn handle_get_job(
    Path(id): Path<String>,
    State(ctx): State<Arc<ServerContext>>,
) -> Result<Json<Job>, AppError> {
    match ctx.state.get_job(&id).await {
        Some(job) => Ok(Json(job)),
        None => Err(AppError::InvalidUrl(format!("Job with ID '{}' not found.", id))),
    }
}

async fn handle_list_jobs(State(ctx): State<Arc<ServerContext>>) -> Json<Vec<Job>> {
    Json(ctx.state.list_jobs().await)
}

async fn handle_list_links(State(ctx): State<Arc<ServerContext>>) -> Json<Vec<ScrapedRecord>> {
    Json(ctx.state.list_links().await)
}

async fn handle_parse_html(
    State(ctx): State<Arc<ServerContext>>,
    Json(req): Json<ParseHtmlRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    if req.html.trim().is_empty() {
        return Err(AppError::ParserError("HTML content cannot be empty.".to_string()));
    }

    if req.reset.unwrap_or(false) || req.auto_reset.unwrap_or(false) {
        ctx.state.clear_all().await;
    }

    let source_url = req.source_url.unwrap_or_else(|| "direct-pasted-html".to_string());
    let parse_res = parse_4khdhub_html(&req.html, &source_url);

    let target_quality = req.quality.unwrap_or_else(|| "all".to_string());
    let mut saved_records = Vec::new();

    for (idx, item) in parse_res.links.into_iter().enumerate() {
        if matches_quality(item.quality.as_deref(), &target_quality) {
            let record = ScrapedRecord {
                id: format!("html_rec_{}", idx + 1),
                source_url: source_url.clone(),
                source_domain: "direct".to_string(),
                title: item.title,
                quality: item.quality,
                scope: item.scope,
                season: item.season,
                episode: item.episode,
                codec: item.codec,
                size_display: item.size_display,
                provider: item.provider,
                provider_url: None,
                mediator_url: Some(item.mediator_url),
                file_id: None,
                filename: None,
                status: "DISCOVERED".to_string(),
                created_at: chrono_or_simple_timestamp(),
                duration_ms: None,
            };
            ctx.state.save_link(record.clone()).await;
            saved_records.push(record);
        }
    }

    Ok(Json(json!({
        "success": true,
        "count": saved_records.len(),
        "records": saved_records
    })))
}

async fn handle_resolve_link(
    State(_ctx): State<Arc<ServerContext>>,
    Json(req): Json<ResolveLinkRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let mediator_url = req.mediator_url.or(Some(req.url)).unwrap_or_default();
    if is_hubcloud_url(&mediator_url) {
        let file_id = extract_hubcloud_drive_id(&mediator_url);
        return Ok(Json(json!({
            "success": true,
            "destination": mediator_url,
            "fileId": file_id,
            "status": "HUBCLOUD_DETECTED"
        })));
    }

    Ok(Json(json!({
        "success": false,
        "mediatorUrl": mediator_url,
        "status": "REQUIRES_BROWSER_AUTOMATION"
    })))
}

async fn handle_get_stats(State(ctx): State<Arc<ServerContext>>) -> Json<serde_json::Value> {
    let jobs = ctx.state.list_jobs().await;
    let links = ctx.state.list_links().await;
    let uptime = ctx.state.start_time.elapsed().as_secs();

    Json(json!({
        "jobsCount": jobs.len(),
        "linksCount": links.len(),
        "uptimeSecs": uptime,
        "memory": "In-memory Rust store (zero DB)"
    }))
}
