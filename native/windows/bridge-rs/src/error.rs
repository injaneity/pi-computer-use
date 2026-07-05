use serde::Serialize;
use std::fmt;

/// Error code strings sent in JSON error responses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ErrorCode {
    #[serde(rename = "capability_deferred")]
    CapabilityDeferred,
    #[serde(rename = "unsupported_command")]
    UnsupportedCommand,
    #[serde(rename = "invalid_request")]
    InvalidRequest,
    #[serde(rename = "target_not_found")]
    TargetNotFound,
    #[serde(rename = "internal_error")]
    InternalError,
    #[serde(rename = "unsupported_platform")]
    UnsupportedPlatform,
    #[serde(rename = "capture_failed")]
    CaptureFailed,
    #[serde(rename = "stale_look")]
    StaleLook,
    #[serde(rename = "stale_ref")]
    StaleRef,
    #[serde(rename = "coordinate_unavailable_for_root")]
    CoordinateUnavailableForRoot,
    #[serde(rename = "coordinate_blocked")]
    CoordinateBlocked,
    #[serde(rename = "occluded_target")]
    OccludedTarget,
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            ErrorCode::CapabilityDeferred => "capability_deferred",
            ErrorCode::UnsupportedCommand => "unsupported_command",
            ErrorCode::InvalidRequest => "invalid_request",
            ErrorCode::TargetNotFound => "target_not_found",
            ErrorCode::InternalError => "internal_error",
            ErrorCode::UnsupportedPlatform => "unsupported_platform",
            ErrorCode::CaptureFailed => "capture_failed",
            ErrorCode::StaleLook => "stale_look",
            ErrorCode::StaleRef => "stale_ref",
            ErrorCode::CoordinateUnavailableForRoot => "coordinate_unavailable_for_root",
            ErrorCode::CoordinateBlocked => "coordinate_blocked",
            ErrorCode::OccludedTarget => "occluded_target",
        };
        write!(f, "{s}")
    }
}

/// A typed protocol error with a human-readable message and a machine-readable code.
#[derive(Debug, Clone, Serialize)]
pub struct ProtocolError {
    pub message: String,
    pub code: ErrorCode,
}

impl ProtocolError {
    pub fn new(message: impl Into<String>, code: ErrorCode) -> Self {
        Self {
            message: message.into(),
            code,
        }
    }
}

impl std::error::Error for ProtocolError {}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}
