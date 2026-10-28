mod config;
mod error;
mod http_client;
mod models;
mod parser;
mod queue;
mod routes;
mod security;

use std::net::SocketAddr;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::config::Config;
use crate::http_client::HttpClient;
use crate::queue::AppState;
use crate::routes::{create_router, ServerContext};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Initialize tracing logger with structured formatting and env filter
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "rust_backend=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // 2. Load configuration from environment with defaults
    let cfg = Config::from_env();
    info!(
        category = "CONFIG",
        port = cfg.port,
        concurrency = cfg.concurrency,
        mediator_concurrency = cfg.mediator_concurrency,
        timeout_ms = cfg.request_timeout_ms,
        "Loaded localhost scraper configuration"
    );

    // 3. Initialize reusable components
    let http_client = HttpClient::new(&cfg);
    let state = AppState::new(cfg.mediator_concurrency);

    let ctx = ServerContext {
        state,
        http_client,
        config: cfg.clone(),
    };

    // 4. Build Axum router
    let app = create_router(ctx);

    // 5. Bind and start localhost server
    let addr = SocketAddr::from(([127, 0, 0, 1], cfg.port));
    info!(
        category = "SERVER",
        "Rust Axum localhost scraper server running at http://{}:{}",
        cfg.host,
        cfg.port
    );

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
