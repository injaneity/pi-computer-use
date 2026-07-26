use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ProtocolError;

pub const PROTOCOL_VERSION: u32 = 4;

#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub id: String,
    pub cmd: String,
    pub args: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct Response {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ProtocolError>,
}

impl Response {
    pub fn ok(id: &str, result: Value) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            id: id.to_owned(),
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: &str, error: ProtocolError) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            id: id.to_owned(),
            ok: false,
            result: None,
            error: Some(error),
        }
    }
}
