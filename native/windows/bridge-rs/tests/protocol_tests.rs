use serde_json::json;

/// The protocol types under test are expected to be exported from the library crate.
use windows_bridge::{ErrorCode, ProtocolError, Request, Response};

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

#[test]
fn test_parse_valid_request() {
    let raw = json!({
        "protocolVersion": 1,
        "id": "req-001",
        "cmd": "checkPermissions",
        "args": {}
    });
    let req: Request = serde_json::from_value(raw).expect("valid request");
    assert_eq!(req.protocol_version, 1);
    assert_eq!(req.id, "req-001");
    assert_eq!(req.cmd, "checkPermissions");
}

#[test]
fn test_parse_request_with_args() {
    let raw = json!({
        "protocolVersion": 1,
        "id": "req-002",
        "cmd": "listWindows",
        "args": { "pid": 1234 }
    });
    let req: Request = serde_json::from_value(raw).expect("valid request with args");
    assert_eq!(req.protocol_version, 1);
    assert_eq!(req.id, "req-002");
    assert_eq!(req.cmd, "listWindows");
    assert!(req.args.is_object());
    assert_eq!(req.args["pid"], 1234);
}

#[test]
fn test_parse_request_missing_id() {
    let raw = json!({
        "protocolVersion": 1,
        "cmd": "checkPermissions",
        "args": {}
    });
    let result: Result<Request, _> = serde_json::from_value(raw);
    assert!(result.is_err(), "missing id should be rejected");
}

#[test]
fn test_parse_request_missing_cmd() {
    let raw = json!({
        "protocolVersion": 1,
        "id": "req-003",
        "args": {}
    });
    let result: Result<Request, _> = serde_json::from_value(raw);
    assert!(result.is_err(), "missing cmd should be rejected");
}

#[test]
fn test_parse_request_wrong_types() {
    // id must be a string
    let raw = json!({
        "protocolVersion": 1,
        "id": 42,
        "cmd": "test",
        "args": {}
    });
    let result: Result<Request, _> = serde_json::from_value(raw);
    assert!(result.is_err(), "non-string id should be rejected");
}

// ---------------------------------------------------------------------------
// Success response serialization
// ---------------------------------------------------------------------------

#[test]
fn test_serialize_success_response() {
    let resp = Response::ok("req-001", json!({ "ready": true }));
    let json_str = serde_json::to_string(&resp).expect("serialize success");
    let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();

    assert_eq!(parsed["protocolVersion"], 1);
    assert_eq!(parsed["id"], "req-001");
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["result"]["ready"], true);
}

#[test]
fn test_serialize_success_with_null_result() {
    let resp = Response::ok("req-002", json!(null));
    let json_str = serde_json::to_string(&resp).expect("serialize success null");
    let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();

    assert_eq!(parsed["protocolVersion"], 1);
    assert_eq!(parsed["id"], "req-002");
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["result"], serde_json::Value::Null);
}

// ---------------------------------------------------------------------------
// Error response serialization
// ---------------------------------------------------------------------------

#[test]
fn test_serialize_capability_deferred_error() {
    let err = ProtocolError::new(
        "Window ref-backed actions are deferred in PR #1. \
         This PR supports window discovery, screenshots, state IDs, \
         and read-only UIA element discovery.",
        ErrorCode::CapabilityDeferred,
    );
    let resp = Response::err("req-003", err);
    let json_str = serde_json::to_string(&resp).expect("serialize error");
    let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();

    assert_eq!(parsed["protocolVersion"], 1);
    assert_eq!(parsed["id"], "req-003");
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["error"]["code"], "capability_deferred");
    assert!(parsed["error"]["message"]
        .as_str()
        .unwrap()
        .contains("deferred"));
}

#[test]
fn test_serialize_unsupported_command_error() {
    let err = ProtocolError::new("Unknown command 'fooBar'", ErrorCode::UnsupportedCommand);
    let resp = Response::err("req-004", err);
    let json_str = serde_json::to_string(&resp).expect("serialize error");
    let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();

    assert_eq!(parsed["protocolVersion"], 1);
    assert_eq!(parsed["id"], "req-004");
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["error"]["code"], "unsupported_command");
    assert_eq!(parsed["error"]["message"], "Unknown command 'fooBar'");
}

#[test]
fn test_serialize_invalid_request_error() {
    let err = ProtocolError::new(
        "Request must be a valid JSON object with protocolVersion, id, and cmd",
        ErrorCode::InvalidRequest,
    );
    let resp = Response::err("req-005", err);
    let json_str = serde_json::to_string(&resp).expect("serialize error");
    let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();

    assert_eq!(parsed["protocolVersion"], 1);
    assert_eq!(parsed["id"], "req-005");
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["error"]["code"], "invalid_request");
}

#[test]
fn test_serialize_internal_error() {
    let err = ProtocolError::new("Unexpected internal failure", ErrorCode::InternalError);
    let resp = Response::err("req-006", err);
    let json_str = serde_json::to_string(&resp).expect("serialize error");
    let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();

    assert_eq!(parsed["protocolVersion"], 1);
    assert_eq!(parsed["id"], "req-006");
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["error"]["code"], "internal_error");
}

#[test]
fn test_serialize_target_not_found_error() {
    let err = ProtocolError::new("Window with id 42 not found", ErrorCode::TargetNotFound);
    let resp = Response::err("req-007", err);
    let json_str = serde_json::to_string(&resp).expect("serialize error");
    let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();

    assert_eq!(parsed["protocolVersion"], 1);
    assert_eq!(parsed["id"], "req-007");
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["error"]["code"], "target_not_found");
}

// ---------------------------------------------------------------------------
// ErrorCode Display
// ---------------------------------------------------------------------------

#[test]
fn test_error_code_display() {
    assert_eq!(
        ErrorCode::CapabilityDeferred.to_string(),
        "capability_deferred"
    );
    assert_eq!(
        ErrorCode::UnsupportedCommand.to_string(),
        "unsupported_command"
    );
    assert_eq!(ErrorCode::InvalidRequest.to_string(), "invalid_request");
    assert_eq!(ErrorCode::TargetNotFound.to_string(), "target_not_found");
    assert_eq!(ErrorCode::InternalError.to_string(), "internal_error");
}

// ---------------------------------------------------------------------------
// Integration: round-trip request + response
// ---------------------------------------------------------------------------

#[test]
fn test_round_trip_request_response() {
    // Simulate: parse a request, produce a success response, serialize it
    let raw = json!({
        "protocolVersion": 1,
        "id": "rt-001",
        "cmd": "checkPermissions",
        "args": {}
    });
    let req: Request = serde_json::from_value(raw).unwrap();
    assert_eq!(req.cmd, "checkPermissions");

    let resp = Response::ok(req.id.as_str(), json!({ "accessibility": false }));
    let out = serde_json::to_string(&resp).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["protocolVersion"], 1);
    assert_eq!(parsed["id"], "rt-001");
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["result"]["accessibility"], false);
}

#[test]
fn test_round_trip_request_error() {
    // Simulate: parse request, produce an error response, serialize it
    let raw = json!({
        "protocolVersion": 1,
        "id": "rt-002",
        "cmd": "mouseClick",
        "args": {}
    });
    let req: Request = serde_json::from_value(raw).unwrap();
    assert_eq!(req.cmd, "mouseClick");

    let err = ProtocolError::new(
        "Windows ref-backed actions are deferred in PR #1",
        ErrorCode::CapabilityDeferred,
    );
    let resp = Response::err(req.id.as_str(), err);
    let out = serde_json::to_string(&resp).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["protocolVersion"], 1);
    assert_eq!(parsed["id"], "rt-002");
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["error"]["code"], "capability_deferred");
}
