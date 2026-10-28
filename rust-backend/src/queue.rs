use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{RwLock, Semaphore};
use crate::models::{Job, ScrapedRecord};

#[derive(Clone)]
pub struct AppState {
    pub jobs: Arc<RwLock<HashMap<String, Job>>>,
    pub links: Arc<RwLock<Vec<ScrapedRecord>>>,
    pub mediator_semaphore: Arc<Semaphore>,
    pub start_time: std::time::Instant,
}

impl AppState {
    pub fn new(concurrency_limit: usize) -> Self {
        Self {
            jobs: Arc::new(RwLock::new(HashMap::new())),
            links: Arc::new(RwLock::new(Vec::new())),
            mediator_semaphore: Arc::new(Semaphore::new(concurrency_limit)),
            start_time: std::time::Instant::now(),
        }
    }

    pub async fn add_job(&self, mut job: Job) {
        let mut jobs = self.jobs.write().await;
        jobs.insert(job.id.clone(), job);
    }

    pub async fn get_job(&self, id: &str) -> Option<Job> {
        let jobs = self.jobs.read().await;
        jobs.get(id).cloned()
    }

    pub async fn list_jobs(&self) -> Vec<Job> {
        let jobs = self.jobs.read().await;
        jobs.values().cloned().collect()
    }

    pub async fn update_job_status(&self, id: &str, status: &str, extracted_count: usize, error: Option<String>) {
        let mut jobs = self.jobs.write().await;
        if let Some(job) = jobs.get_mut(id) {
            job.status = status.to_string();
            job.extracted_count = extracted_count;
            job.updated_at = chrono_or_simple_timestamp();
            job.error = error;
        }
    }

    pub async fn save_link(&self, record: ScrapedRecord) {
        let mut links = self.links.write().await;
        // In-place deduplication by mediator_url or id
        if let Some(pos) = links.iter().position(|l| {
            (!record.id.is_empty() && l.id == record.id)
                || (record.mediator_url.is_some() && l.mediator_url == record.mediator_url)
        }) {
            links[pos] = record;
        } else {
            links.push(record);
        }
    }

    pub async fn list_links(&self) -> Vec<ScrapedRecord> {
        let links = self.links.read().await;
        links.clone()
    }

    pub async fn clear_all(&self) -> (usize, usize) {
        let mut links = self.links.write().await;
        let mut jobs = self.jobs.write().await;
        let deleted_links = links.len();
        let deleted_jobs = jobs.len();
        links.clear();
        jobs.clear();
        (deleted_links, deleted_jobs)
    }
}

pub fn chrono_or_simple_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{}", now)
}
