use linux_bridge::protocol::PROTOCOL_VERSION;
use linux_bridge::{ErrorCode, ProtocolError, Request, Response};
use serde_json::json;
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn protocol_round_trip_matches_other_helpers() {
    let request: Request = serde_json::from_value(json!({
        "protocolVersion": PROTOCOL_VERSION,
        "id": "linux-1",
        "cmd": "diagnostics",
        "args": {}
    }))
    .unwrap();
    let response = Response::ok(&request.id, json!({"backend":"at-spi2"}));
    let value = serde_json::to_value(response).unwrap();
    assert_eq!(value["protocolVersion"], 4);
    assert_eq!(value["id"], "linux-1");
    assert_eq!(value["result"]["backend"], "at-spi2");
}

#[test]
fn errors_have_stable_machine_codes() {
    let response = Response::err(
        "linux-2",
        ProtocolError::new("no screenshot", ErrorCode::CaptureFailed),
    );
    let value = serde_json::to_value(response).unwrap();
    assert_eq!(value["ok"], false);
    assert_eq!(value["error"]["code"], "capture_failed");
}

#[test]
fn diagnostics_response_is_flushed_after_stdin_eof() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_linux-bridge"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn linux helper");
    let request = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "id": "eof-1",
        "cmd": "diagnostics",
        "args": {}
    });
    writeln!(
        child.stdin.as_mut().expect("piped stdin"),
        "{}",
        serde_json::to_string(&request).unwrap()
    )
    .expect("write diagnostics request");
    drop(child.stdin.take());

    let output = child.wait_with_output().expect("helper exits after EOF");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "helper failed: {stderr}");
    assert!(
        !stderr.contains("panicked"),
        "helper panicked during shutdown: {stderr}"
    );
    let lines = String::from_utf8(output.stdout)
        .expect("UTF-8 stdout")
        .lines()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), 1, "expected one response: {lines:?}");
    let response: serde_json::Value = serde_json::from_str(&lines[0]).expect("valid JSON response");
    assert_eq!(response["id"], "eof-1");
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["protocolVersion"], PROTOCOL_VERSION);
}
