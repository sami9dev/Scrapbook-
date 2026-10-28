use std::time::Duration;
use reqwest::redirect::Policy;
use reqwest::Client;
use crate::config::Config;
use crate::error::AppError;

#[derive(Clone)]
pub struct HttpClient {
    client: Client,
    max_retries: usize,
}

impl HttpClient {
    pub fn new(cfg: &Config) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_millis(cfg.request_timeout_ms))
            .connect_timeout(Duration::from_secs(5))
            .redirect(Policy::limited(cfg.max_redirects))
            .user_agent(&cfg.user_agent)
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(10)
            .gzip(true)
            .build()
            .expect("Failed to initialize reqwest HTTP client");

        Self {
            client,
            max_retries: cfg.max_retries,
        }
    }

    /// Fetches HTML from a validated URL with automatic retries and exponential backoff.
    pub async fn fetch_html(&self, url: &str) -> Result<(String, String), AppError> {
        let mut last_err = String::new();

        for attempt in 0..=self.max_retries {
            if attempt > 0 {
                let delay = Duration::from_millis(1000 * (1 << (attempt - 1)));
                tokio::time::sleep(delay).await;
            }

            match self.client.get(url).send().await {
                Ok(resp) => {
                    let final_url = resp.url().to_string();
                    let status = resp.status();
                    if !status.is_success() {
                        last_err = format!("HTTP error status: {}", status);
                        continue;
                    }

                    match resp.text().await {
                        Ok(body) => return Ok((body, final_url)),
                        Err(e) => {
                            last_err = format!("Failed to read response body: {}", e);
                            continue;
                        }
                    }
                }
                Err(e) => {
                    if e.is_timeout() {
                        last_err = format!("Request timed out: {}", e);
                    } else {
                        last_err = format!("Request error: {}", e);
                    }
                }
            }
        }

        Err(AppError::HttpError(format!("Failed after {} attempts: {}", self.max_retries + 1, last_err)))
    }
}
