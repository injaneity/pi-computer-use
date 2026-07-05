use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::sync::{Mutex, OnceLock};
use std::thread::sleep;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use windows_bridge::{
    capture, input, protocol::PROTOCOL_VERSION, refs::RefStore, window, ErrorCode, ProtocolError,
    Request, Response,
};

#[derive(Clone, Debug)]
struct ElementRecord {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    text: String,
    role: String,
}

#[derive(Clone, Debug)]
struct LookRecord {
    frame_x: f64,
    frame_y: f64,
    frame_w: f64,
    frame_h: f64,
    image_w: f64,
    image_h: f64,
    has_image: bool,
    roots_before: HashMap<String, Value>,
    elements: HashMap<String, ElementRecord>,
}

#[derive(Clone)]
struct HelperState {
    store: RefStore,
    roots: HashMap<String, Value>,
    looks: HashMap<String, LookRecord>,
    next_look: u64,
}

impl Default for HelperState {
    fn default() -> Self {
        Self { store: RefStore::new(), roots: HashMap::new(), looks: HashMap::new(), next_look: 1 }
    }
}

fn helper_state() -> &'static Mutex<HelperState> {
    static STATE: OnceLock<Mutex<HelperState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HelperState::default()))
}

fn main() {
    #[cfg(windows)]
    set_dpi_awareness();

    let stdin = io::stdin();
    let stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                let resp = Response::err("unknown", ProtocolError::new(format!("Failed to read input line: {e}"), ErrorCode::InternalError));
                if let Ok(json) = serde_json::to_string(&resp) { let _ = writeln!(stdout.lock(), "{json}"); }
                return;
            }
        };
        let trimmed = line.trim().to_owned();
        if trimmed.is_empty() { continue; }
        let id = extract_id(&trimmed).unwrap_or_else(|| "unknown".to_owned());
        let request: Request = match serde_json::from_str(&trimmed) {
            Ok(req) => req,
            Err(e) => {
                emit_response(&Response::err(&id, ProtocolError::new(format!("Invalid request: {e}"), ErrorCode::InvalidRequest)));
                continue;
            }
        };
        emit_response(&handle_request(&request));
    }
}

#[cfg(windows)]
fn set_dpi_awareness() {
    use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
    let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
}

fn extract_id(line: &str) -> Option<String> {
    serde_json::from_str::<Value>(line).ok().and_then(|v| v.get("id")?.as_str().map(String::from))
}

fn handle_request(request: &Request) -> Response {
    if request.protocol_version != PROTOCOL_VERSION {
        return Response::err(&request.id, ProtocolError::new(format!("Unsupported Windows helper protocol {}; expected {}. Restart Pi to use the installed helper.", request.protocol_version, PROTOCOL_VERSION), ErrorCode::InvalidRequest));
    }

    let result = match request.cmd.as_str() {
        "diagnostics" => Ok(diagnostics()),
        "listRoots" | "listWindows" => handle_list_roots(&request.args),
        "look" | "screenshot" => handle_look(&request.args),
        "focusWindow" => handle_focus_window(&request.args),
        "act" => handle_act(&request.args),
        "uiaReadText" | "axReadText" => handle_read_text(&request.args),
        "uiaWaitFor" | "axWaitFor" => handle_wait_for(&request.args),
        "openBrowserLocation" => handle_open_browser_location(&request.args),
        other => Err(ProtocolError::new(format!("Unknown command '{other}'"), ErrorCode::UnsupportedCommand)),
    };

    match result { Ok(value) => Response::ok(&request.id, value), Err(error) => Response::err(&request.id, error) }
}

fn diagnostics() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "pid": std::process::id(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "accessibility": true,
        "screenRecording": true
    })
}

fn handle_list_roots(args: &Value) -> Result<Value, ProtocolError> {
    let filter_pid = args.get("pid").and_then(Value::as_u64);
    let mut state = helper_state().lock().map_err(|_| internal("helper state lock poisoned"))?;
    state.store = RefStore::new();
    let result = window::list_windows(&mut state.store, filter_pid)?;
    state.roots = roots_array(&result).into_iter().map(|root| (root_identity(&root), root)).collect();
    Ok(result)
}

fn handle_focus_window(args: &Value) -> Result<Value, ProtocolError> {
    let root_ref = args.get("rootRef").or_else(|| args.get("windowRef")).and_then(Value::as_str).ok_or_else(|| invalid("focusWindow requires rootRef"))?;
    let wref = windows_bridge::refs::WindowRef::parse(root_ref).ok_or_else(|| invalid(format!("Invalid root ref '{root_ref}'")))?;
    let state = helper_state().lock().map_err(|_| internal("helper state lock poisoned"))?;
    window::focus_window(&state.store, &wref)
}

fn handle_look(args: &Value) -> Result<Value, ProtocolError> {
    let root_ref = args.get("rootRef").or_else(|| args.get("windowRef")).and_then(Value::as_str).map(str::to_owned);
    let window_id = args.get("windowId").and_then(Value::as_i64);
    let include_image = args.get("includeImage").and_then(Value::as_bool).unwrap_or(true);

    if root_ref.is_none() && window_id.is_none() {
        return Err(invalid("look requires rootRef or windowId"));
    }

    let mut state = helper_state().lock().map_err(|_| internal("helper state lock poisoned"))?;
    if state.roots.is_empty() { drop(state); let _ = handle_list_roots(&json!({})); state = helper_state().lock().map_err(|_| internal("helper state lock poisoned"))?; }

    let (identity, root) = state.roots.iter().find(|(_, root)| {
        root_ref.as_deref().is_some_and(|r| root.get("rootRef").and_then(Value::as_str) == Some(r) || root.get("windowRef").and_then(Value::as_str) == Some(r))
            || window_id.is_some_and(|id| root.get("windowId").and_then(Value::as_i64) == Some(id))
    }).map(|(id, root)| (id.clone(), root.clone())).ok_or_else(|| ProtocolError::new("Root not found", ErrorCode::TargetNotFound))?;

    let root_ref = root.get("rootRef").and_then(Value::as_str).unwrap_or(&identity).to_owned();
    let kind = root.get("kind").and_then(Value::as_str).unwrap_or("window");
    let is_outline_only = kind == "menu" || !include_image;
    let frame = root.get("framePoints").cloned().unwrap_or_else(|| json!({"x":0,"y":0,"w":1,"h":1}));
    let fx = number_at(&frame, "x", 0.0);
    let fy = number_at(&frame, "y", 0.0);
    let fw = number_at(&frame, "w", number_at(&frame, "width", 1.0)).max(1.0);
    let fh = number_at(&frame, "h", number_at(&frame, "height", 1.0)).max(1.0);

    let mut image_payload = None;
    let mut elements = Vec::new();
    let mut image_w = fw;
    let mut image_h = fh;

    if !is_outline_only {
        let wref = windows_bridge::refs::WindowRef::parse(&root_ref).ok_or_else(|| invalid(format!("Invalid root ref '{root_ref}'")))?;
        let shot = capture::screenshot(&mut state.store, &wref, true)?;
        if let Some(capture) = shot.get("capture") {
            image_w = number_at(capture, "width", fw).max(1.0);
            image_h = number_at(capture, "height", fh).max(1.0);
            if let Some(encoded) = capture.get("imageBase64").and_then(Value::as_str) {
                image_payload = Some(json!({ "jpegBase64": encoded, "width": image_w, "height": image_h }));
            }
        }
        elements = shot.get("axTargets").and_then(Value::as_array).cloned().unwrap_or_default();
    } else {
        #[cfg(windows)]
        {
            if let Some(wref) = windows_bridge::refs::WindowRef::parse(&root_ref) {
                if let Some(native) = state.store.get_window(&wref) {
                    elements = windows_bridge::uia::extract_elements(&mut state.store, native.raw()).into_iter().collect();
                }
            }
        }
    }

    let look_id = format!("look_{}", state.next_look);
    state.next_look += 1;
    let (outline, element_records) = outline_from_elements(&root_ref, kind, &root, &elements, fx, fy, image_w, image_h, fw, fh);
    let record = LookRecord { frame_x: fx, frame_y: fy, frame_w: fw, frame_h: fh, image_w, image_h, has_image: image_payload.is_some(), roots_before: state.roots.clone(), elements: element_records };
    state.looks.insert(look_id.clone(), record);

    let mut response = json!({
        "lookId": look_id,
        "capturedAt": now_seconds(),
        "window": {
            "windowId": root.get("windowId").and_then(Value::as_i64).unwrap_or(0),
            "rootRef": root_ref,
            "kind": kind,
            "framePoints": { "x": fx, "y": fy, "w": fw, "h": fh },
            "scaleFactor": root.get("scaleFactor").and_then(Value::as_f64).unwrap_or(1.0),
            "pairing": { "confidence": "exact", "score": 100 },
            "isModal": root.get("isModal").and_then(Value::as_bool).unwrap_or(false),
            "sheetCount": 0,
            "role": root.get("role").and_then(Value::as_str).unwrap_or("Window"),
            "subrole": root.get("subrole").and_then(Value::as_str).unwrap_or("")
        },
        "outline": outline,
        "timings": { "captureMs": 0, "describeMs": 0, "readTextMs": 0 }
    });
    if let Some(image) = image_payload { response["image"] = image; }
    Ok(response)
}

#[allow(clippy::too_many_arguments)]
fn outline_from_elements(root_ref: &str, kind: &str, root: &Value, elements: &[Value], fx: f64, fy: f64, image_w: f64, image_h: f64, fw: f64, fh: f64) -> (Value, HashMap<String, ElementRecord>) {
    let mut records = HashMap::new();
    let sx = image_w / fw.max(1.0);
    let sy = image_h / fh.max(1.0);
    let children = elements.iter().map(|raw| {
        let bounds = raw.get("bounds").unwrap_or(&Value::Null);
        let screen_x = number_at(bounds, "x", 0.0);
        let screen_y = number_at(bounds, "y", 0.0);
        let screen_w = number_at(bounds, "width", number_at(bounds, "w", 1.0)).max(1.0);
        let screen_h = number_at(bounds, "height", number_at(bounds, "h", 1.0)).max(1.0);
        // Windows UIA and HWND geometry are in DPI-aware screen points. Look images
        // are pixels; every element rect below is converted by the window-image scale
        // so coordinate acts can invert through the stored LookRecord without TS state.
        let rect = json!({ "x": (screen_x - fx) * sx, "y": (screen_y - fy) * sy, "w": screen_w * sx, "h": screen_h * sy });
        let reference = raw.get("ref").and_then(Value::as_str).unwrap_or("").to_owned();
        let role = raw.get("role").and_then(Value::as_str).unwrap_or("unknown").to_owned();
        let text = raw.get("value").or_else(|| raw.get("label")).and_then(Value::as_str).unwrap_or("").to_owned();
        if !reference.is_empty() { records.insert(reference.clone(), ElementRecord { x: screen_x, y: screen_y, w: screen_w, h: screen_h, text: text.clone(), role: role.clone() }); }
        let caps = raw.get("capabilities").unwrap_or(&Value::Null);
        json!({
            "ref": reference,
            "role": role,
            "subrole": raw.get("className").and_then(Value::as_str).unwrap_or(""),
            "identifier": raw.get("automationId").and_then(Value::as_str).unwrap_or(""),
            "title": raw.get("label").and_then(Value::as_str).unwrap_or(""),
            "description": raw.get("className").and_then(Value::as_str).unwrap_or(""),
            "value": raw.get("value").and_then(Value::as_str).unwrap_or(""),
            "actions": [],
            "canPress": caps.get("canInvoke").and_then(Value::as_bool).unwrap_or(false),
            "canFocus": caps.get("isKeyboardFocusable").and_then(Value::as_bool).unwrap_or(false),
            "canSetValue": caps.get("canSetValue").and_then(Value::as_bool).unwrap_or(false),
            "canScroll": caps.get("canScroll").and_then(Value::as_bool).unwrap_or(false),
            "canIncrement": false,
            "canDecrement": false,
            "isTextInput": matches!(raw.get("role").and_then(Value::as_str), Some("edit" | "document")),
            "rect": rect,
            "focused": false,
            "offscreen": caps.get("isOffscreen").and_then(Value::as_bool).unwrap_or(false),
            "pictureOnly": false,
            "truncated": false,
            "text": if text.is_empty() { json!([]) } else { json!([{ "string": text, "confidence": 1, "rect": rect }]) },
            "children": []
        })
    }).collect::<Vec<_>>();
    (json!({
        "ref": root_ref,
        "role": root.get("role").and_then(Value::as_str).unwrap_or("Window"),
        "subrole": root.get("subrole").and_then(Value::as_str).unwrap_or(""),
        "identifier": "",
        "title": root.get("title").and_then(Value::as_str).unwrap_or(if kind == "menu" { "Menu" } else { "Window" }),
        "description": "",
        "value": "",
        "actions": [],
        "canPress": false,
        "canFocus": false,
        "canSetValue": false,
        "canScroll": false,
        "canIncrement": false,
        "canDecrement": false,
        "isTextInput": false,
        "rect": { "x": 0, "y": 0, "w": image_w, "h": image_h },
        "focused": root.get("isFocused").and_then(Value::as_bool).unwrap_or(false),
        "offscreen": false,
        "pictureOnly": false,
        "truncated": false,
        "text": [],
        "children": children
    }), records)
}

fn handle_act(args: &Value) -> Result<Value, ProtocolError> {
    let parsed = input::parse_act_request(args)?;
    let (record, before) = {
        let state = helper_state().lock().map_err(|_| internal("helper state lock poisoned"))?;
        let record = state.looks.get(&parsed.look_id).cloned().ok_or_else(|| ProtocolError::new(format!("Look id '{}' is no longer available", parsed.look_id), ErrorCode::StaleLook))?;
        (record.clone(), record.roots_before.clone())
    };

    let mut executable = args.clone();
    match &parsed.target {
        input::ActTarget::Ref(reference) => {
            let element = record.elements.get(reference).ok_or_else(|| ProtocolError::new("Element reference is stale", ErrorCode::StaleRef))?;
            executable["resolvedPoint"] = json!({ "x": element.x + element.w / 2.0, "y": element.y + element.h / 2.0 });
        }
        input::ActTarget::Point { x, y } => {
            if !record.has_image { return Err(ProtocolError::new("Coordinate targeting is unavailable for this outline-only root", ErrorCode::CoordinateUnavailableForRoot)); }
            executable["resolvedPoint"] = json!(screen_point(&record, *x, *y));
        }
    }
    if parsed.action == "drag" {
        if let Some(path) = parsed.params.get("path").and_then(Value::as_array) {
            executable["resolvedPath"] = Value::Array(path.iter().filter_map(|point| Some(json!(screen_point(&record, point.get("x")?.as_f64()?, point.get("y")?.as_f64()?)))).collect());
        }
    }

    let mut response = input::act(&executable)?;
    sleep(Duration::from_millis(150));
    let after = snapshot_roots()?;
    let delta = root_delta(&before, &after);
    response = input::response_with_delta(response, "snapshot", delta);
    Ok(response)
}

fn screen_point(record: &LookRecord, x: f64, y: f64) -> Value {
    json!({
        "x": record.frame_x + record.frame_w * (x / record.image_w.max(1.0)).clamp(0.0, 1.0),
        "y": record.frame_y + record.frame_h * (y / record.image_h.max(1.0)).clamp(0.0, 1.0)
    })
}

fn snapshot_roots() -> Result<HashMap<String, Value>, ProtocolError> {
    let mut store = RefStore::new();
    let value = window::list_windows(&mut store, None)?;
    Ok(roots_array(&value).into_iter().map(|root| (root_identity(&root), root)).collect())
}

fn root_delta(before: &HashMap<String, Value>, after: &HashMap<String, Value>) -> Vec<Value> {
    let mut delta = Vec::new();
    for (key, root) in after { if !before.contains_key(key) { delta.push(delta_item("appeared", root)); } }
    for (key, root) in before { if !after.contains_key(key) { delta.push(delta_item("closed", root)); } }
    for (key, root) in after {
        if root.get("isFocused").and_then(Value::as_bool) == Some(true) && before.get(key).and_then(|r| r.get("isFocused")).and_then(Value::as_bool) != Some(true) {
            delta.push(delta_item("focused", root));
        }
    }
    delta
}

fn delta_item(change: &str, root: &Value) -> Value {
    json!({
        "change": change,
        "kind": root.get("kind").and_then(Value::as_str).unwrap_or("window"),
        "ref": root.get("rootRef").and_then(Value::as_str).unwrap_or(""),
        "title": root.get("title").and_then(Value::as_str).unwrap_or(""),
        "pid": root.get("pid").and_then(Value::as_u64).unwrap_or(0)
    })
}

fn handle_read_text(args: &Value) -> Result<Value, ProtocolError> {
    let element_ref = args.get("elementRef").and_then(Value::as_str).ok_or_else(|| invalid("uiaReadText requires elementRef"))?;
    let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(4096) as usize;
    let state = helper_state().lock().map_err(|_| internal("helper state lock poisoned"))?;
    let text = state.looks.values().find_map(|look| look.elements.get(element_ref).map(|element| element.text.clone())).unwrap_or_default();
    let end = (offset + limit).min(text.len());
    Ok(json!({ "text": text.get(offset..end).unwrap_or(""), "offset": offset, "limit": limit, "totalChars": text.len(), "hasMore": end < text.len() }))
}

fn handle_wait_for(args: &Value) -> Result<Value, ProtocolError> {
    let timeout_ms = args.get("timeoutMs").and_then(Value::as_u64).unwrap_or(10_000).clamp(100, 60_000);
    let text = args.get("text").and_then(Value::as_str).map(|s| s.to_lowercase());
    let role = args.get("role").and_then(Value::as_str).map(str::to_owned);
    let gone = args.get("gone").and_then(Value::as_bool).unwrap_or(false);
    if text.is_none() && role.is_none() { return Err(invalid("uiaWaitFor requires text or role")); }
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut node_count = 0;
    while Instant::now() < deadline {
        let state = helper_state().lock().map_err(|_| internal("helper state lock poisoned"))?;
        node_count = state.looks.values().map(|look| look.elements.len()).sum::<usize>();
        let found = state.looks.values().flat_map(|look| look.elements.values()).any(|element| {
            text.as_ref().map(|needle| element.text.to_lowercase().contains(needle)).unwrap_or(true) && role.as_ref().map(|r| &element.role == r).unwrap_or(true)
        });
        drop(state);
        if found != gone { return Ok(json!({ "found": found, "gone": if gone { Some(true) } else { None::<bool> }, "nodeCount": node_count })); }
        sleep(Duration::from_millis(100));
    }
    Ok(json!({ "found": false, "timedOut": true, "nodeCount": node_count }))
}

fn handle_open_browser_location(args: &Value) -> Result<Value, ProtocolError> {
    let app_name = args.get("appName").and_then(Value::as_str).unwrap_or("").to_lowercase();
    let roots = handle_list_roots(&json!({}))?;
    let root = roots_array(&roots).into_iter().find(|root| root.get("appName").and_then(Value::as_str).unwrap_or("").to_lowercase().contains(&app_name));
    if let Some(root) = root {
        if let Some(root_ref) = root.get("rootRef").and_then(Value::as_str) { handle_focus_window(&json!({"rootRef": root_ref}))?; }
        let url = args.get("url").and_then(Value::as_str).ok_or_else(|| invalid("openBrowserLocation requires url"))?;
        input::open_browser_location(url)?;
        Ok(json!({ "opened": true }))
    } else {
        Err(ProtocolError::new("Target browser window was not found; refusing to type into the currently focused window", ErrorCode::TargetNotFound))
    }
}

fn roots_array(value: &Value) -> Vec<Value> {
    value.get("roots").or_else(|| value.get("windows")).and_then(Value::as_array).cloned().unwrap_or_default()
}

fn root_identity(root: &Value) -> String {
    if let Some(id) = root.get("windowId").and_then(Value::as_i64) { return format!("window:{id}"); }
    format!("meta:{}:{}:{}", root.get("kind").and_then(Value::as_str).unwrap_or("window"), root.get("title").and_then(Value::as_str).unwrap_or(""), root.get("rootRef").and_then(Value::as_str).unwrap_or(""))
}

fn number_at(value: &Value, key: &str, fallback: f64) -> f64 { value.get(key).and_then(Value::as_f64).unwrap_or(fallback) }
fn invalid(message: impl Into<String>) -> ProtocolError { ProtocolError::new(message.into(), ErrorCode::InvalidRequest) }
fn internal(message: impl Into<String>) -> ProtocolError { ProtocolError::new(message.into(), ErrorCode::InternalError) }
fn now_seconds() -> f64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0) }

fn emit_response(response: &Response) {
    let json = serde_json::to_string(response).expect("Response serialization should not fail");
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{json}");
}
