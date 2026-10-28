use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub host: String,
    pub request_timeout_ms: u64,
    pub max_redirects: usize,
    pub max_retries: usize,
    pub concurrency: usize,
    pub mediator_concurrency: usize,
    pub user_agent: String,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            port: env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3000),
            host: env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
            request_timeout_ms: env::var("REQUEST_TIMEOUT").ok().and_then(|p| p.parse().ok()).unwrap_or(15000),
            max_redirects: env::var("MAX_REDIRECTS").ok().and_then(|p| p.parse().ok()).unwrap_or(10),
            max_retries: env::var("MAX_RETRIES").ok().and_then(|p| p.parse().ok()).unwrap_or(2),
            concurrency: env::var("CONCURRENCY").ok().and_then(|p| p.parse().ok()).unwrap_or(4),
            mediator_concurrency: env::var("MEDIATOR_CONCURRENCY").ok().and_then(|p| p.parse().ok()).unwrap_or(4),
            user_agent: env::var("USER_AGENT").unwrap_or_else(|_| "AuthorizedMetadataScraper/1.0 (Rust; localhost)".to_string()),
        }
    }
}
