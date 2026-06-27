use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;
use windows_bridge::{
    capture, input, refs::RefStore, window, ErrorCode, ProtocolError, Request, Response,
};

/// Global store of RefStores keyed by stateId so that screenshot and future
/// commands can look up native handles that were discovered by listWindows.
fn state_store() -> &'static Mutex<HashMap<String, RefStore>> {
    static STORE: OnceLock<Mutex<HashMap<String, RefStore>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                // Cannot parse input line; emit internal error and exit.
                let fallback_id = "unknown";
                let resp = Response::err(
                    fallback_id,
                    ProtocolError::new(
                        format!("Failed to read input line: {e}"),
                        ErrorCode::InternalError,
                    ),
                );
                if let Ok(json) = serde_json::to_string(&resp) {
                    let _ = writeln!(stdout.lock(), "{json}");
                }
                return;
            }
        };

        let trimmed = line.trim().to_owned();
        if trimmed.is_empty() {
            continue;
        }

        let id = match extract_id(&trimmed) {
            Some(id) => id,
            None => "unknown".to_owned(),
        };

        let request: Request = match serde_json::from_str(&trimmed) {
            Ok(req) => req,
            Err(e) => {
                let resp = Response::err(
                    &id,
                    ProtocolError::new(format!("Invalid request: {e}"), ErrorCode::InvalidRequest),
                );
                emit_response(&resp);
                continue;
            }
        };

        let response = handle_request(&request);
        emit_response(&response);
    }
}

/// Extract the `id` field from a JSON line before full parsing, so we can
/// respond with the same id even on parse failures.
fn extract_id(line: &str) -> Option<String> {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|v| v.get("id")?.as_str().map(String::from))
}

/// Dispatch a validated request and return a response.
fn handle_request(request: &Request) -> Response {
    let cmd = request.cmd.as_str();

    // -- listWindows -------------------------------------------------------
    if cmd == "listWindows" {
        let mut store = RefStore::new();
        let filter_pid = request.args.get("pid").and_then(|v| v.as_u64());
        return match window::list_windows(&mut store, filter_pid) {
            Ok(result) => {
                // Persist the ref store so screenshot and future commands
                // can look up native handles by window/ element ref.
                if let Some(sid) = result.get("stateId").and_then(|v| v.as_str()) {
                    state_store()
                        .lock()
                        .expect("state_store lock should not be poisoned")
                        .insert(sid.to_owned(), store);
                }
                Response::ok(&request.id, result)
            }
            Err(e) => Response::err(&request.id, e),
        };
    }

    // -- screenshot --------------------------------------------------------
    if cmd == "screenshot" {
        return handle_screenshot(request);
    }

    // -- focusWindow -------------------------------------------------------
    if cmd == "focusWindow" {
        return handle_focus_window(request);
    }

    // -- act ---------------------------------------------------------------
    if cmd == "act" {
        return match input::act(&request.args) {
            Ok(result) => Response::ok(&request.id, result),
            Err(e) => Response::err(&request.id, e),
        };
    }

    // Remaining legacy helper commands are not part of the backend command surface.
    const DEFERRED_READONLY: &[&str] = &[
        "checkPermissions",
        "listApps",
        "getFrontmost",
        "axListTargets",
    ];

    if DEFERRED_READONLY.contains(&cmd) {
        return Response::err(
            &request.id,
            ProtocolError::new(
                "This command is not part of the Windows backend command surface. Use listWindows, screenshot, focusWindow, or act.",
                ErrorCode::CapabilityDeferred,
            ),
        );
    }

    // Legacy per-action commands are folded into the backend-level act command.
    const DEFERRED_ACTIONS: &[&str] = &[
        "mouseClick",
        "mouseMove",
        "mouseDrag",
        "scrollWheel",
        "keyPress",
        "typeText",
        "setValue",
        "axPressElement",
        "axScrollElement",
        "navigateBrowser",
        "evaluateBrowser",
        "launchBrowserContext",
        "computerActions",
        "axWaitFor",
    ];

    if DEFERRED_ACTIONS.contains(&cmd) {
        return Response::err(
            &request.id,
            ProtocolError::new(
                "This command is not part of the Windows backend command surface. Use the backend-level act command.",
                ErrorCode::CapabilityDeferred,
            ),
        );
    }

    Response::err(
        &request.id,
        ProtocolError::new(
            format!("Unknown command '{cmd}'"),
            ErrorCode::UnsupportedCommand,
        ),
    )
}

/// Handle the `screenshot` command: parse args, look up the ref store,
/// resolve the window ref, capture, and return the result.
///
/// When `includeElements` is true, also extracts UIA accessibility elements
/// from the target window and includes them in the response as `axTargets`.
fn handle_screenshot(request: &Request) -> Response {
    let args = &request.args;

    // Parse the target window ref.
    let target_str = match args.get("ref").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => {
            return Response::err(
                &request.id,
                ProtocolError::new(
                    "Missing required 'ref' argument for screenshot",
                    ErrorCode::InvalidRequest,
                ),
            );
        }
    };

    let wref = match windows_bridge::refs::WindowRef::parse(target_str) {
        Some(r) => r,
        None => {
            return Response::err(
                &request.id,
                ProtocolError::new(
                    format!("Invalid window ref '{}' — expected @wN format", target_str),
                    ErrorCode::InvalidRequest,
                ),
            );
        }
    };

    // Parse the optional includeElements flag.
    let include_elements = args
        .get("includeElements")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // Look up the ref store by optional stateId.
    let state_id = args.get("stateId").and_then(|v| v.as_str());
    let mut store = match state_id.and_then(|sid| {
        state_store()
            .lock()
            .ok()
            .and_then(|guard| guard.get(sid).cloned())
    }) {
        Some(s) => s,
        None => {
            return Response::err(
                &request.id,
                ProtocolError::new(
                    format!(
                        "No window state found for stateId '{:?}'. \
                         Call listWindows first to discover windows.",
                        state_id
                    ),
                    ErrorCode::TargetNotFound,
                ),
            );
        }
    };

    let result = match capture::screenshot(&mut store, &wref, include_elements) {
        Ok(r) => r,
        Err(e) => return Response::err(&request.id, e),
    };

    // If elements were extracted, persist the updated store (element refs)
    // under the same stateId so that future commands can look them up.
    if include_elements {
        if let Some(sid) = state_id {
            if let Ok(mut guard) = state_store().lock() {
                guard.insert(sid.to_owned(), store);
            }
        }
    }

    Response::ok(&request.id, result)
}

fn handle_focus_window(request: &Request) -> Response {
    let args = &request.args;
    let target_str = match args.get("ref").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => {
            return Response::err(
                &request.id,
                ProtocolError::new(
                    "Missing required 'ref' argument for focusWindow",
                    ErrorCode::InvalidRequest,
                ),
            );
        }
    };
    let wref = match windows_bridge::refs::WindowRef::parse(target_str) {
        Some(r) => r,
        None => {
            return Response::err(
                &request.id,
                ProtocolError::new(
                    format!("Invalid window ref '{}' — expected @wN format", target_str),
                    ErrorCode::InvalidRequest,
                ),
            );
        }
    };
    let state_id = args.get("stateId").and_then(|v| v.as_str());
    let store = match state_id.and_then(|sid| {
        state_store()
            .lock()
            .ok()
            .and_then(|guard| guard.get(sid).cloned())
    }) {
        Some(s) => s,
        None => {
            return Response::err(
                &request.id,
                ProtocolError::new(
                    format!("No window state found for stateId '{:?}'. Call listWindows first to discover windows.", state_id),
                    ErrorCode::TargetNotFound,
                ),
            );
        }
    };
    match window::focus_window(&store, &wref) {
        Ok(result) => Response::ok(&request.id, result),
        Err(e) => Response::err(&request.id, e),
    }
}

fn emit_response(response: &Response) {
    let json = serde_json::to_string(response).expect("Response serialization should not fail");
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{json}");
}
