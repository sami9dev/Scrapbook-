use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScrapedRecord {
    pub id: String,
    #[serde(rename = "sourceUrl")]
    pub source_url: String,
    #[serde(rename = "sourceDomain")]
    pub source_domain: String,
    pub title: String,
    pub quality: Option<String>,
    pub scope: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub codec: Option<String>,
    #[serde(rename = "sizeDisplay")]
    pub size_display: Option<String>,
    pub provider: String,
    #[serde(rename = "providerUrl")]
    pub provider_url: Option<String>,
    #[serde(rename = "mediatorUrl")]
    pub mediator_url: Option<String>,
    #[serde(rename = "fileId")]
    pub file_id: Option<String>,
    pub filename: Option<String>,
    pub status: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub url: String,
    pub status: String,
    #[serde(rename = "targetQuality")]
    pub target_quality: String,
    #[serde(rename = "targetScope")]
    pub target_scope: String,
    #[serde(rename = "extractedCount")]
    pub extracted_count: usize,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ScrapeRequest {
    pub url: String,
    pub quality: Option<String>,
    #[serde(rename = "targetQuality")]
    pub target_quality: Option<String>,
    pub scope: Option<String>,
    #[serde(rename = "targetScope")]
    pub target_scope: Option<String>,
    pub reset: Option<bool>,
    #[serde(rename = "autoReset")]
    pub auto_reset: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct ParseHtmlRequest {
    pub html: String,
    #[serde(rename = "sourceUrl")]
    pub source_url: Option<String>,
    pub quality: Option<String>,
    pub scope: Option<String>,
    pub reset: Option<bool>,
    #[serde(rename = "autoReset")]
    pub auto_reset: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct ResolveLinkRequest {
    pub url: String,
    #[serde(rename = "mediatorUrl")]
    pub mediator_url: Option<String>,
    pub quality: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub version: &'static str,
    pub uptime_secs: u64,
}

#[derive(Debug, Serialize)]
pub struct ResetResponse {
    pub success: bool,
    pub message: &'static str,
    #[serde(rename = "deletedLinks")]
    pub deleted_links: usize,
    #[serde(rename = "deletedJobs")]
    pub deleted_jobs: usize,
}
