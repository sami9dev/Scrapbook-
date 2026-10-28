use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Invalid URL: {0}")]
    InvalidUrl(String),

    #[error("SSRF blocked: {0}")]
    SsrfBlocked(String),

    #[error("Network timeout: {0}")]
    NetworkTimeout(String),

    #[error("HTTP request error: {0}")]
    HttpError(String),

    #[error("HTML parsing error: {0}")]
    ParserError(String),

    #[error("Browser automation error: {0}")]
    BrowserError(String),

    #[error("Human verification required: {0}")]
    VerificationRequired(String),

    #[error("Operation cancelled")]
    Cancelled,

    #[error("Internal server error: {0}")]
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, error_code, message) = match &self {
            AppError::InvalidUrl(msg) => (StatusCode::BAD_REQUEST, "INVALID_URL", msg.clone()),
            AppError::SsrfBlocked(msg) => (StatusCode::FORBIDDEN, "SSRF_BLOCKED", msg.clone()),
            AppError::NetworkTimeout(msg) => (StatusCode::GATEWAY_TIMEOUT, "NETWORK_TIMEOUT", msg.clone()),
            AppError::HttpError(msg) => (StatusCode::BAD_GATEWAY, "HTTP_ERROR", msg.clone()),
            AppError::ParserError(msg) => (StatusCode::UNPROCESSABLE_ENTITY, "PARSER_ERROR", msg.clone()),
            AppError::BrowserError(msg) => (StatusCode::INTERNAL_SERVER_ERROR, "BROWSER_ERROR", msg.clone()),
            AppError::VerificationRequired(msg) => (StatusCode::FORBIDDEN, "VERIFICATION_REQUIRED", msg.clone()),
            AppError::Cancelled => (StatusCode::BAD_REQUEST, "CANCELLED", "Operation was cancelled".to_string()),
            AppError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", msg.clone()),
        };

        let body = Json(json!({
            "error": message,
            "code": error_code,
            "success": false
        }));

        (status, body).into_response()
    }
}
