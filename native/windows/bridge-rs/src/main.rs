use std::cell::Cell;
use std::collections::{HashMap, VecDeque};
use std::io::{self, BufRead, Write};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread::{self, sleep};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use windows_bridge::{
    capture, input, protocol::PROTOCOL_VERSION, refs::RefStore, window, ErrorCode, ProtocolError,
    Request, Response,
};

#[derive(Clone, Debug)]
struct ElementRecord {
    hwnd: isize,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    automation_id: String,
    class_name: String,
    is_secure: bool,
    can_press: bool,
    can_set_value: bool,
    can_scroll: bool,
    runtime_id: Vec<i32>,
}

#[derive(Clone, Debug)]
struct LookRecord {
    pid: u64,
    hwnd: isize,
    frame_x: f64,
    frame_y: f64,
    frame_w: f64,
    frame_h: f64,
    image_w: f64,
    image_h: f64,
    has_image: bool,
    elements: HashMap<String, ElementRecord>,
}

#[derive(Clone, Debug)]
struct RootSnapshot {
    roots: HashMap<String, Value>,
    foreground_pid: Option<u64>,
}

struct HelperState {
    store: RefStore,
    roots: HashMap<String, Value>,
    looks: HashMap<String, LookRecord>,
    look_order: VecDeque<String>,
    next_look: u64,
}

const MAX_LOOK_RECORDS: usize = 8;
const REQUEST_WORKERS: usize = 8;

impl Default for HelperState {
    fn default() -> Self {
        Self {
            store: RefStore::new(),
            roots: HashMap::new(),
            looks: HashMap::new(),
            look_order: VecDeque::new(),
            next_look: 1,
        }
    }
}

impl HelperState {
    fn insert_look(&mut self, look_id: String, record: LookRecord) {
        self.looks.insert(look_id.clone(), record);
        self.look_order.push_back(look_id);
        while self.look_order.len() > MAX_LOOK_RECORDS {
            if let Some(expired) = self.look_order.pop_front() {
                self.looks.remove(&expired);
            }
        }
    }

    fn element_for_look(
        &self,
        look_id: &str,
        reference: &str,
    ) -> Result<ElementRecord, ProtocolError> {
        self.looks
            .get(look_id)
            .ok_or_else(|| {
                ProtocolError::new("Owning look is no longer available", ErrorCode::StaleLook)
            })?
            .elements
            .get(reference)
            .cloned()
            .ok_or_else(|| ProtocolError::new("Element reference is stale", ErrorCode::StaleRef))
    }
}

fn helper_state() -> &'static Mutex<HelperState> {
    static STATE: OnceLock<Mutex<HelperState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HelperState::default()))
}

fn physical_input_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

thread_local! { static IN_PHYSICAL_TRANSACTION: Cell<bool> = const { Cell::new(false) }; }

fn with_physical_input<T>(
    work: impl FnOnce() -> Result<T, ProtocolError>,
) -> Result<T, ProtocolError> {
    if IN_PHYSICAL_TRANSACTION.with(Cell::get) {
        return work();
    }
    let _guard = physical_input_lock()
        .lock()
        .map_err(|_| internal("physical input lock poisoned"))?;
    IN_PHYSICAL_TRANSACTION.with(|flag| flag.set(true));
    let result = work();
    IN_PHYSICAL_TRANSACTION.with(|flag| flag.set(false));
    result
}

fn main() {
    #[cfg(windows)]
    set_dpi_awareness();
    window::start_root_event_journal();

    let stdin = io::stdin();
    let stdout = io::stdout();
    let (sender, receiver) = mpsc::channel::<Request>();
    let receiver = Arc::new(Mutex::new(receiver));
    let workers = (0..REQUEST_WORKERS)
        .map(|_| {
            let receiver = Arc::clone(&receiver);
            thread::spawn(move || loop {
                let request = match receiver.lock() {
                    Ok(receiver) => receiver.recv(),
                    Err(_) => return,
                };
                match request {
                    Ok(request) => emit_response(&handle_request(&request)),
                    Err(_) => return,
                }
            })
        })
        .collect::<Vec<_>>();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                let resp = Response::err(
                    "unknown",
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
        let id = extract_id(&trimmed).unwrap_or_else(|| "unknown".to_owned());
        let request: Request = match serde_json::from_str(&trimmed) {
            Ok(req) => req,
            Err(e) => {
                emit_response(&Response::err(
                    &id,
                    ProtocolError::new(format!("Invalid request: {e}"), ErrorCode::InvalidRequest),
                ));
                continue;
            }
        };
        if sender.send(request).is_err() {
            break;
        }
    }
    drop(sender);
    for worker in workers {
        let _ = worker.join();
    }
}

#[cfg(windows)]
fn set_dpi_awareness() {
    use windows::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
}

fn extract_id(line: &str) -> Option<String> {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|v| v.get("id")?.as_str().map(String::from))
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
        "actBatch" => handle_act_batch(&request.args),
        "uiaReadText" | "axReadText" => handle_read_text(&request.args),
        "uiaWaitFor" | "axWaitFor" => handle_wait_for(&request.args),
        "openBrowserLocation" => handle_open_browser_location(&request.args),
        other => Err(ProtocolError::new(
            format!("Unknown command '{other}'"),
            ErrorCode::UnsupportedCommand,
        )),
    };

    match result {
        Ok(value) => Response::ok(&request.id, value),
        Err(error) => Response::err(&request.id, error),
    }
}

fn diagnostics() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "architectureVersion": 1,
        "invariants": ["state-scoped-observations", "bounded-observation-history", "multi-root-forest", "progressive-disclosure", "atomic-physical-input", "concurrent-requests", "transactional-batching"],
        "pid": std::process::id(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "accessibility": true,
        "screenRecording": true
    })
}

fn handle_list_roots(args: &Value) -> Result<Value, ProtocolError> {
    let filter_pid = args.get("pid").and_then(Value::as_u64);
    let mut state = helper_state()
        .lock()
        .map_err(|_| internal("helper state lock poisoned"))?;
    let result = window::list_windows(&mut state.store, filter_pid)?;
    let discovered = roots_array(&result);
    if filter_pid.is_none() {
        state.store.retain_window_refs(
            discovered
                .iter()
                .filter_map(|root| root.get("rootRef").and_then(Value::as_str)),
        );
        state.roots.clear();
    } else if let Some(pid) = filter_pid {
        state
            .roots
            .retain(|_, root| root.get("pid").and_then(Value::as_u64) != Some(pid));
    }
    state.roots.extend(
        discovered
            .into_iter()
            .map(|root| (root_identity(&root), root)),
    );
    Ok(result)
}

fn handle_focus_window(args: &Value) -> Result<Value, ProtocolError> {
    let root_ref = args
        .get("rootRef")
        .or_else(|| args.get("windowRef"))
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("focusWindow requires rootRef"))?;
    let wref = windows_bridge::refs::WindowRef::parse(root_ref)
        .ok_or_else(|| invalid(format!("Invalid root ref '{root_ref}'")))?;
    let state = helper_state()
        .lock()
        .map_err(|_| internal("helper state lock poisoned"))?;
    window::focus_window(&state.store, &wref)
}

fn handle_look(args: &Value) -> Result<Value, ProtocolError> {
    let started_at = Instant::now();
    let root_ref = args
        .get("rootRef")
        .or_else(|| args.get("windowRef"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let window_id = args.get("windowId").and_then(Value::as_i64);
    let include_image = args
        .get("includeImage")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let max_dimension = args
        .get("maxDimension")
        .and_then(Value::as_u64)
        .map(|value| value.clamp(1, 16_384) as u32);
    let read_text = args
        .get("readText")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    if !matches!(read_text, "auto" | "always" | "never") {
        return Err(invalid("readText must be auto, always, or never"));
    }
    let scope_ref = args
        .get("scopeRef")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let base_look_id = args.get("baseLookId").and_then(Value::as_str);

    if root_ref.is_none() && window_id.is_none() {
        return Err(invalid("look requires rootRef or windowId"));
    }

    let roots_missing = helper_state()
        .lock()
        .map_err(|_| internal("helper state lock poisoned"))?
        .roots
        .is_empty();
    if roots_missing {
        let _ = handle_list_roots(&json!({}));
    }
    let (mut store, roots) = {
        let state = helper_state()
            .lock()
            .map_err(|_| internal("helper state lock poisoned"))?;
        (state.store.clone(), state.roots.clone())
    };

    let (identity, root) = roots
        .iter()
        .find(|(_, root)| {
            root_ref.as_deref().is_some_and(|r| {
                root.get("rootRef").and_then(Value::as_str) == Some(r)
                    || root.get("windowRef").and_then(Value::as_str) == Some(r)
            }) || window_id
                .is_some_and(|id| root.get("windowId").and_then(Value::as_i64) == Some(id))
        })
        .map(|(id, root)| (id.clone(), root.clone()))
        .ok_or_else(|| ProtocolError::new("Root not found", ErrorCode::TargetNotFound))?;

    let root_ref = root
        .get("rootRef")
        .and_then(Value::as_str)
        .unwrap_or(&identity)
        .to_owned();
    let kind = root.get("kind").and_then(Value::as_str).unwrap_or("window");
    let is_outline_only = kind == "menu" || !include_image;
    let frame = root
        .get("framePoints")
        .cloned()
        .unwrap_or_else(|| json!({"x":0,"y":0,"w":1,"h":1}));
    let fx = number_at(&frame, "x", 0.0);
    let fy = number_at(&frame, "y", 0.0);
    let fw = number_at(&frame, "w", number_at(&frame, "width", 1.0)).max(1.0);
    let fh = number_at(&frame, "h", number_at(&frame, "height", 1.0)).max(1.0);

    let mut image_payload = None;
    let mut elements = Vec::new();
    let mut image_w = fw;
    let mut image_h = fh;

    let capture_started = Instant::now();
    if !is_outline_only {
        let wref = windows_bridge::refs::WindowRef::parse(&root_ref)
            .ok_or_else(|| invalid(format!("Invalid root ref '{root_ref}'")))?;
        let shot = capture::screenshot(&mut store, &wref, scope_ref.is_none(), max_dimension)?;
        if let Some(capture) = shot.get("capture") {
            image_w = number_at(capture, "width", fw).max(1.0);
            image_h = number_at(capture, "height", fh).max(1.0);
            if let Some(encoded) = capture.get("imageBase64").and_then(Value::as_str) {
                image_payload = Some(
                    json!({ "jpegBase64": encoded, "mimeType": "image/png", "width": image_w, "height": image_h }),
                );
            }
        }
        elements = shot
            .get("axTargets")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
    } else {
        #[cfg(windows)]
        {
            if let Some(wref) = windows_bridge::refs::WindowRef::parse(&root_ref) {
                if let Some(native) = store.get_window(&wref) {
                    elements = windows_bridge::uia::extract_elements(&mut store, native.raw())
                        .into_iter()
                        .collect();
                }
            }
        }
    }

    let capture_ms = capture_started.elapsed().as_millis() as u64;
    let root_hwnd = root.get("windowId").and_then(Value::as_i64).unwrap_or(0) as isize;
    let mut base_look = None;
    if let Some(scope_ref) = scope_ref.as_deref() {
        let (owning_look, scope) =
            look_record_for_element(scope_ref, base_look_id).ok_or_else(|| {
                ProtocolError::new(
                    "Scope ref is stale or outside the target root",
                    ErrorCode::StaleRef,
                )
            })?;
        if scope.hwnd != root_hwnd {
            return Err(ProtocolError::new(
                "Scope ref is stale or outside the target root",
                ErrorCode::StaleRef,
            ));
        }
        elements = windows_bridge::uia::extract_elements_from(
            &mut store,
            scope.hwnd,
            &scope.runtime_id,
            &scope.automation_id,
        )
        .map_err(stale_ref_from_uia)?;
        base_look = Some(owning_look);
    }

    let look_id = fresh_look_id()?;
    let describe_started = Instant::now();
    let (mut outline, mut element_records) = outline_from_elements(
        scope_ref.as_deref().unwrap_or(&root_ref),
        &look_id,
        kind,
        &root,
        &elements,
        fx,
        fy,
        image_w,
        image_h,
        fw,
        fh,
    );
    if let Some(scope_ref) = scope_ref.as_deref() {
        outline = scoped_outline_root(outline, scope_ref);
    }
    if let Some(base) = base_look.as_ref() {
        element_records.extend(base.elements.clone());
    }
    let describe_ms = describe_started.elapsed().as_millis() as u64;
    let record = LookRecord {
        pid: root.get("pid").and_then(Value::as_u64).unwrap_or(0),
        hwnd: root_hwnd,
        frame_x: base_look.as_ref().map(|look| look.frame_x).unwrap_or(fx),
        frame_y: base_look.as_ref().map(|look| look.frame_y).unwrap_or(fy),
        frame_w: base_look.as_ref().map(|look| look.frame_w).unwrap_or(fw),
        frame_h: base_look.as_ref().map(|look| look.frame_h).unwrap_or(fh),
        image_w: base_look
            .as_ref()
            .map(|look| look.image_w)
            .unwrap_or(image_w),
        image_h: base_look
            .as_ref()
            .map(|look| look.image_h)
            .unwrap_or(image_h),
        has_image: base_look
            .as_ref()
            .map(|look| look.has_image)
            .unwrap_or_else(|| image_payload.is_some()),
        elements: element_records,
    };
    store_look_record(look_id.clone(), record)?;

    let mut response = json!({
        "lookId": look_id,
        "capturedAt": now_seconds(),
        "window": {
            "windowId": root.get("windowId").and_then(Value::as_i64).unwrap_or(0),
            "rootRef": root_ref,
            "kind": kind,
            "framePoints": { "x": fx, "y": fy, "w": fw, "h": fh },
            "scaleFactor": root.get("scaleFactor").and_then(Value::as_f64).unwrap_or(1.0),
            "isModal": root.get("isModal").and_then(Value::as_bool).unwrap_or(false),
            "role": root.get("role").and_then(Value::as_str).unwrap_or("Window"),
            "subrole": root.get("subrole").and_then(Value::as_str).unwrap_or("")
        },
        "outline": outline,
        "timings": { "captureMs": capture_ms, "describeMs": describe_ms, "readTextMs": 0, "totalMs": started_at.elapsed().as_millis() as u64 },
        "readText": { "requested": read_text, "executed": false }
    });
    if let Some(metadata) = root.get("metadata") {
        response["window"]["metadata"] = metadata.clone();
    }
    if let Some(image) = image_payload {
        response["image"] = image;
    }
    Ok(response)
}

#[allow(clippy::too_many_arguments)]
fn outline_from_elements(
    root_ref: &str,
    look_id: &str,
    kind: &str,
    root: &Value,
    elements: &[Value],
    fx: f64,
    fy: f64,
    image_w: f64,
    image_h: f64,
    fw: f64,
    fh: f64,
) -> (Value, HashMap<String, ElementRecord>) {
    let mut records = HashMap::new();
    let sx = image_w / fw.max(1.0);
    let sy = image_h / fh.max(1.0);
    let nodes = elements.iter().map(|raw| {
        let bounds = raw.get("bounds").unwrap_or(&Value::Null);
        let screen_x = number_at(bounds, "x", 0.0);
        let screen_y = number_at(bounds, "y", 0.0);
        let screen_w = number_at(bounds, "width", number_at(bounds, "w", 1.0)).max(1.0);
        let screen_h = number_at(bounds, "height", number_at(bounds, "h", 1.0)).max(1.0);
        // Windows UIA and HWND geometry are in DPI-aware screen points. Look images
        // are pixels; every element rect below is converted by the window-image scale
        // so coordinate acts can invert through the stored LookRecord without TS state.
        let rect = json!({ "x": (screen_x - fx) * sx, "y": (screen_y - fy) * sy, "w": screen_w * sx, "h": screen_h * sy });
        let native_reference = raw.get("ref").and_then(Value::as_str).unwrap_or("");
        let reference = if native_reference.is_empty() { String::new() } else { format!("win:{look_id}:{native_reference}") };
        let role = raw.get("role").and_then(Value::as_str).unwrap_or("unknown").to_owned();
        let automation_id = raw.get("automationId").and_then(Value::as_str).unwrap_or("").to_owned();
        let class_name = format!(
            "{} {}",
            raw.get("className").and_then(Value::as_str).unwrap_or(""),
            root.get("subrole").and_then(Value::as_str).unwrap_or("")
        );
        let runtime_id: Vec<i32> = raw.get("runtimeId").and_then(Value::as_array).map(|items| items.iter().filter_map(|item| item.as_i64().map(|n| n as i32)).collect()).unwrap_or_default();
        let parent_runtime_id: Vec<i32> = raw.get("parentRuntimeId").and_then(Value::as_array).map(|items| items.iter().filter_map(|item| item.as_i64().map(|n| n as i32)).collect()).unwrap_or_default();
        let is_secure = raw.get("isPassword").and_then(Value::as_bool).unwrap_or(false);
        let displayed_value = if is_secure { "" } else { raw.get("value").and_then(Value::as_str).unwrap_or("") };
        let text = if displayed_value.is_empty() { raw.get("label").and_then(Value::as_str).unwrap_or("") } else { displayed_value }.to_owned();
        let hwnd = root.get("windowId").and_then(Value::as_i64).unwrap_or(0) as isize;
        let caps = raw.get("capabilities").unwrap_or(&Value::Null);
        let can_press = caps.get("canPress").or_else(|| caps.get("canInvoke")).and_then(Value::as_bool).unwrap_or(false);
        let can_set_value = caps.get("canSetValue").or_else(|| caps.get("canEditText")).and_then(Value::as_bool).unwrap_or(false);
        let can_scroll = caps.get("canScroll").and_then(Value::as_bool).unwrap_or(false);
        if !reference.is_empty() { records.insert(reference.clone(), ElementRecord { hwnd, x: screen_x, y: screen_y, w: screen_w, h: screen_h, automation_id: automation_id.clone(), class_name, is_secure, can_press, can_set_value, can_scroll, runtime_id: runtime_id.clone() }); }
        let node = json!({
            "ref": reference,
            "role": role,
            "subrole": raw.get("className").and_then(Value::as_str).unwrap_or(""),
            "identifier": raw.get("automationId").and_then(Value::as_str).unwrap_or(""),
            "title": raw.get("label").and_then(Value::as_str).unwrap_or(""),
            "description": raw.get("className").and_then(Value::as_str).unwrap_or(""),
            "value": displayed_value,
            "actions": [],
            "canPress": can_press,
            "canFocus": caps.get("isKeyboardFocusable").and_then(Value::as_bool).unwrap_or(false),
            "canSetValue": can_set_value,
            "canScroll": can_scroll,
            "canIncrement": false,
            "canDecrement": false,
            "isTextInput": matches!(raw.get("role").and_then(Value::as_str), Some("edit" | "document")),
            "rect": rect,
            "focused": false,
            "offscreen": caps.get("isOffscreen").and_then(Value::as_bool).unwrap_or(false),
            "pictureOnly": false,
            "truncated": raw.get("truncated").and_then(Value::as_bool).unwrap_or(false),
            "text": if text.is_empty() { json!([]) } else { json!([{ "string": text, "confidence": 1, "rect": rect }]) },
            "children": []
        });
        (runtime_key(&runtime_id), runtime_key(&parent_runtime_id), node)
    }).collect::<Vec<_>>();
    let children = nest_outline_nodes(&nodes);
    (
        json!({
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
        }),
        records,
    )
}

fn runtime_key(runtime_id: &[i32]) -> String {
    runtime_id
        .iter()
        .map(i32::to_string)
        .collect::<Vec<_>>()
        .join(".")
}

fn nest_outline_nodes(nodes: &[(String, String, Value)]) -> Vec<Value> {
    let index = nodes
        .iter()
        .enumerate()
        .filter(|(_, (key, _, _))| !key.is_empty())
        .map(|(index, (key, _, _))| (key.as_str(), index))
        .collect::<HashMap<_, _>>();
    let mut children = vec![Vec::<usize>::new(); nodes.len()];
    let mut roots = Vec::new();
    for (node_index, (_, parent, _)) in nodes.iter().enumerate() {
        match index.get(parent.as_str()).copied() {
            Some(parent_index) if parent_index != node_index => {
                children[parent_index].push(node_index)
            }
            _ => roots.push(node_index),
        }
    }
    fn materialize(
        node_index: usize,
        nodes: &[(String, String, Value)],
        children: &[Vec<usize>],
        path: &mut Vec<usize>,
    ) -> Value {
        let mut node = nodes[node_index].2.clone();
        if path.len() >= 64 || path.contains(&node_index) {
            node["truncated"] = json!(true);
            return node;
        }
        path.push(node_index);
        node["children"] = Value::Array(
            children[node_index]
                .iter()
                .map(|child| materialize(*child, nodes, children, path))
                .collect(),
        );
        path.pop();
        node
    }
    roots
        .into_iter()
        .map(|root| materialize(root, nodes, &children, &mut Vec::new()))
        .collect()
}

fn fresh_look_id() -> Result<String, ProtocolError> {
    let mut state = helper_state()
        .lock()
        .map_err(|_| internal("helper state lock poisoned"))?;
    let look_id = format!("look_{}", state.next_look);
    state.next_look += 1;
    Ok(look_id)
}

fn store_look_record(look_id: String, record: LookRecord) -> Result<(), ProtocolError> {
    let mut state = helper_state()
        .lock()
        .map_err(|_| internal("helper state lock poisoned"))?;
    state.insert_look(look_id, record);
    Ok(())
}

fn look_record_for_element(
    reference: &str,
    base_look_id: Option<&str>,
) -> Option<(LookRecord, ElementRecord)> {
    let state = helper_state().lock().ok()?;
    if let Some(look_id) = base_look_id {
        let look = state.looks.get(look_id)?;
        return look
            .elements
            .get(reference)
            .cloned()
            .map(|element| (look.clone(), element));
    }
    state
        .look_order
        .iter()
        .rev()
        .filter_map(|look_id| state.looks.get(look_id))
        .find_map(|look| {
            look.elements
                .get(reference)
                .cloned()
                .map(|element| (look.clone(), element))
        })
}

fn scoped_outline_root(mut outline: Value, scope_ref: &str) -> Value {
    let mut roots = outline["children"]
        .as_array_mut()
        .map(std::mem::take)
        .unwrap_or_default();
    if roots.is_empty() {
        outline["ref"] = json!(scope_ref);
        outline["truncated"] = json!(false);
        return outline;
    }
    let mut scoped = roots.remove(0);
    scoped["ref"] = json!(scope_ref);
    if !roots.is_empty() {
        if let Some(children) = scoped["children"].as_array_mut() {
            children.extend(roots);
        }
    }
    scoped
}

fn handle_act(args: &Value) -> Result<Value, ProtocolError> {
    let parsed = input::parse_act_request(args)?;
    let record = {
        let state = helper_state()
            .lock()
            .map_err(|_| internal("helper state lock poisoned"))?;
        state.looks.get(&parsed.look_id).cloned().ok_or_else(|| {
            ProtocolError::new(
                format!("Look id '{}' is no longer available", parsed.look_id),
                ErrorCode::StaleLook,
            )
        })?
    };
    let target_pid = parsed
        .pid
        .or((record.pid != 0).then_some(record.pid))
        .ok_or_else(|| invalid("act requires pid or observed root pid for root deltas"))?;
    let defer_root_delta = args
        .get("deferRootDelta")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let event_cursor = window::root_event_cursor();
    let before = if defer_root_delta {
        None
    } else {
        Some(snapshot_roots(target_pid)?)
    };

    let mut response = match &parsed.target {
        input::ActTarget::Ref(reference) => act_on_ref(args, &parsed, &record, reference)?,
        input::ActTarget::Point { x, y } => {
            if !record.has_image {
                return Err(ProtocolError::new(
                    "Coordinate targeting is unavailable for this outline-only root",
                    ErrorCode::CoordinateUnavailableForRoot,
                ));
            }
            let mut executable = args.clone();
            executable["resolvedPoint"] = json!(screen_point(&record, *x, *y));
            if parsed.action == "drag" {
                if let Some(path) = parsed.params.get("path").and_then(Value::as_array) {
                    executable["resolvedPath"] = Value::Array(
                        path.iter()
                            .filter_map(|point| {
                                Some(json!(screen_point(
                                    &record,
                                    point.get("x")?.as_f64()?,
                                    point.get("y")?.as_f64()?
                                )))
                            })
                            .collect(),
                    );
                }
            }
            with_physical_input(|| {
                let preserve_focus = parsed
                    .params
                    .get("preserveFocus")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if !preserve_focus {
                    window::ensure_foreground(record.hwnd)?;
                }
                input::act(&executable)
            })?
        }
    };

    if let Some(before) = before {
        let (after, source, events) = await_delta_snapshot(target_pid, &before, event_cursor)?;
        response = input::response_with_delta(
            response,
            source,
            combined_root_delta(&before, &after, target_pid, events),
        );
    }
    Ok(response)
}

fn handle_act_batch(args: &Value) -> Result<Value, ProtocolError> {
    let actions = args
        .get("actions")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("actBatch requires actions"))?;
    if actions.is_empty() || actions.len() > 20 {
        return Err(invalid("actBatch requires 1...20 actions"));
    }
    let first = input::parse_act_request(&actions[0])?;
    let target_pid = first
        .pid
        .ok_or_else(|| invalid("actBatch actions require pid"))?;
    for action in actions {
        let parsed = input::parse_act_request(action)?;
        if parsed.pid != Some(target_pid) {
            return Err(invalid("actBatch actions must target one pid"));
        }
        if parsed.look_id != first.look_id {
            return Err(invalid("actBatch actions must belong to one look"));
        }
    }
    let before = snapshot_roots(target_pid)?;
    let event_cursor = window::root_event_cursor();
    let record = {
        let state = helper_state()
            .lock()
            .map_err(|_| internal("helper state lock poisoned"))?;
        state.looks.get(&first.look_id).cloned().ok_or_else(|| {
            ProtocolError::new("Owning look is no longer available", ErrorCode::StaleLook)
        })?
    };
    let requires_physical = actions
        .iter()
        .any(|action| action_may_use_physical_input(action, &record));
    let execute = || -> Result<(Vec<Value>, Option<usize>), ProtocolError> {
        let mut steps = Vec::new();
        let mut stopped_at = None;
        for (index, action) in actions.iter().enumerate() {
            let mut deferred = action.clone();
            deferred["deferRootDelta"] = json!(true);
            let step = match handle_act(&deferred) {
                Ok(step) => step,
                Err(error) => {
                    steps.push(json!({ "outcome": "didnt", "error": { "code": error.code.to_string(), "message": error.message } }));
                    stopped_at = Some(index);
                    break;
                }
            };
            let didnt = step.get("outcome").and_then(Value::as_str) == Some("didnt");
            steps.push(step);
            if didnt {
                stopped_at = Some(index);
                break;
            }
        }
        Ok((steps, stopped_at))
    };
    let executed = if requires_physical {
        let _physical_guard = physical_input_lock()
            .lock()
            .map_err(|_| internal("physical input lock poisoned"))?;
        IN_PHYSICAL_TRANSACTION.with(|flag| flag.set(true));
        let result = execute();
        IN_PHYSICAL_TRANSACTION.with(|flag| flag.set(false));
        result
    } else {
        execute()
    };
    let (steps, stopped_at) = executed?;
    let outcome = if steps
        .iter()
        .any(|step| step.get("outcome").and_then(Value::as_str) == Some("didnt"))
    {
        "didnt"
    } else if steps
        .iter()
        .any(|step| step.get("outcome").and_then(Value::as_str) == Some("unknown"))
    {
        "unknown"
    } else {
        "worked"
    };
    let mut response = json!({ "outcome": outcome, "performed": { "transaction": true, "actionCount": steps.len() }, "steps": steps });
    if let Some(index) = stopped_at {
        response["stoppedAt"] = json!(index);
    }
    let (after, source, events) = await_delta_snapshot(target_pid, &before, event_cursor)?;
    response = input::response_with_delta(
        response,
        source,
        combined_root_delta(&before, &after, target_pid, events),
    );
    Ok(response)
}

fn action_may_use_physical_input(action: &Value, record: &LookRecord) -> bool {
    let Ok(parsed) = input::parse_act_request(action) else {
        return false;
    };
    if parsed.policy != "foreground" {
        return false;
    }
    let input::ActTarget::Ref(reference) = &parsed.target else {
        return true;
    };
    let Some(element) = record.elements.get(reference) else {
        return false;
    };
    match parsed.action.as_str() {
        "press" | "click" => is_web_backed(element) || !element.can_press,
        "setText" => is_web_backed(element) || !element.can_set_value,
        "scroll" => !element.can_scroll,
        _ => true,
    }
}

fn act_on_ref(
    args: &Value,
    parsed: &input::ParsedActRequest,
    record: &LookRecord,
    reference: &str,
) -> Result<Value, ProtocolError> {
    let element = record
        .elements
        .get(reference)
        .cloned()
        .ok_or_else(|| ProtocolError::new("Element reference is stale", ErrorCode::StaleRef))?;
    if parsed.policy != "ax_only"
        && is_web_backed(&element)
        && matches!(parsed.action.as_str(), "press" | "click" | "setText")
    {
        return coordinate_fallback(args, parsed, &element);
    }
    match parsed.action.as_str() {
        "press" | "click" => match windows_bridge::uia::press(
            element.hwnd,
            &element.runtime_id,
            &element.automation_id,
        )
        .map_err(stale_ref_from_uia)?
        {
            windows_bridge::uia::PressResult::Invoked => Ok(
                json!({ "outcome": "worked", "performed": { "grounding": "description", "delivery": "ax" } }),
            ),
            windows_bridge::uia::PressResult::Toggled(state) => Ok(
                json!({ "outcome": "worked", "performed": { "grounding": "description", "delivery": "ax" }, "evidence": { "toggleState": state } }),
            ),
            windows_bridge::uia::PressResult::Selected(selected) => Ok(
                json!({ "outcome": if selected { "worked" } else { "didnt" }, "performed": { "grounding": "description", "delivery": "ax" }, "evidence": { "selected": selected } }),
            ),
            windows_bridge::uia::PressResult::Expanded => Ok(
                json!({ "outcome": "worked", "performed": { "grounding": "description", "delivery": "ax" } }),
            ),
            windows_bridge::uia::PressResult::LegacyDefaultAction => Ok(
                json!({ "outcome": "worked", "performed": { "grounding": "description", "delivery": "ax" } }),
            ),
            windows_bridge::uia::PressResult::NoPattern => {
                coordinate_fallback(args, parsed, &element)
            }
        },
        "setText" => {
            let text = parsed
                .params
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("");
            match windows_bridge::uia::set_text(
                element.hwnd,
                &element.runtime_id,
                &element.automation_id,
                text,
            )
            .map_err(stale_ref_from_uia)?
            {
                windows_bridge::uia::SetTextResult::Set { value } => {
                    if value != text && parsed.policy != "foreground" {
                        return Err(ProtocolError::new(
                            "The background UIA value write was accepted but did not take effect",
                            ErrorCode::ForegroundRequired,
                        ));
                    }
                    Ok(
                        json!({ "outcome": if value == text { "worked" } else { "didnt" }, "performed": { "grounding": "description", "delivery": "ax" }, "evidence": { "value": value } }),
                    )
                }
                windows_bridge::uia::SetTextResult::NoPattern => {
                    input::policy_allows_raw_input(parsed)?;
                    let _ = windows_bridge::uia::focus(
                        element.hwnd,
                        &element.runtime_id,
                        &element.automation_id,
                    );
                    coordinate_fallback(args, parsed, &element)
                }
            }
        }
        "scroll" => {
            let sx = parsed
                .params
                .get("scrollX")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let sy = parsed
                .params
                .get("scrollY")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            match windows_bridge::uia::scroll(
                element.hwnd,
                &element.runtime_id,
                &element.automation_id,
                sx,
                sy,
            )
            .map_err(stale_ref_from_uia)?
            {
                windows_bridge::uia::ScrollResult::Scrolled => Ok(
                    json!({ "outcome": "unknown", "performed": { "grounding": "description", "delivery": "ax" } }),
                ),
                windows_bridge::uia::ScrollResult::NoPattern => {
                    coordinate_fallback(args, parsed, &element)
                }
            }
        }
        _ => coordinate_fallback(args, parsed, &element),
    }
}

fn coordinate_fallback(
    args: &Value,
    parsed: &input::ParsedActRequest,
    element: &ElementRecord,
) -> Result<Value, ProtocolError> {
    input::policy_allows_raw_input(parsed)?;
    with_physical_input(|| {
        window::ensure_foreground(element.hwnd)?;
        let snapshot = windows_bridge::uia::snapshot(
            element.hwnd,
            &element.runtime_id,
            &element.automation_id,
        )
        .map_err(stale_ref_from_uia)
        .unwrap_or(windows_bridge::uia::ElementSnapshot {
            rect: (element.x, element.y, element.w, element.h),
            runtime_id: element.runtime_id.clone(),
        });
        let x = snapshot.rect.0 + snapshot.rect.2 / 2.0;
        let y = snapshot.rect.1 + snapshot.rect.3 / 2.0;
        let mut occlusion_unknown = false;
        let mut clear = false;
        for attempt in 0..3 {
            match windows_bridge::uia::occlusion_ok(
                element.hwnd,
                &snapshot.runtime_id,
                &element.automation_id,
                x,
                y,
            ) {
                Ok(true) => {
                    clear = true;
                    break;
                }
                Ok(false) if attempt < 2 => sleep(Duration::from_millis(20)),
                Ok(false) => break,
                Err(_) => {
                    occlusion_unknown = true;
                    clear = true;
                    break;
                }
            }
        }
        if !clear {
            return Err(ProtocolError::new(
                "Target is occluded",
                ErrorCode::OccludedTarget,
            ));
        }
        let mut executable = args.clone();
        executable["resolvedPoint"] = json!({ "x": x, "y": y });
        let mut response = input::act(&executable)?;
        if occlusion_unknown {
            response["outcome"] = json!("unknown");
            response["evidence"]["preflight"] = json!("unknown");
        }
        Ok(response)
    })
}

fn is_web_backed(element: &ElementRecord) -> bool {
    let class = element.class_name.to_ascii_lowercase();
    class.contains("chrome")
        || class.contains("chromium")
        || class.contains("webview")
        || class.contains("electron")
}

fn stale_ref_from_uia(message: String) -> ProtocolError {
    if message.contains("stale") || message.contains("Element reference") {
        ProtocolError::new("Element reference is stale", ErrorCode::StaleRef)
    } else {
        ProtocolError::new(message, ErrorCode::InternalError)
    }
}

fn screen_point(record: &LookRecord, x: f64, y: f64) -> Value {
    json!({
        "x": record.frame_x + record.frame_w * (x / record.image_w.max(1.0)).clamp(0.0, 1.0),
        "y": record.frame_y + record.frame_h * (y / record.image_h.max(1.0)).clamp(0.0, 1.0)
    })
}

fn snapshot_roots(pid: u64) -> Result<RootSnapshot, ProtocolError> {
    let mut store = RefStore::new();
    let value = window::list_windows(&mut store, Some(pid))?;
    Ok(RootSnapshot {
        roots: roots_array(&value)
            .into_iter()
            .map(|root| (root_identity(&root), root))
            .collect(),
        foreground_pid: window::foreground_pid(),
    })
}

fn root_signature(snapshot: &RootSnapshot) -> (Vec<String>, Option<u64>) {
    let mut keys = snapshot.roots.keys().cloned().collect::<Vec<_>>();
    keys.sort();
    (keys, snapshot.foreground_pid)
}

fn await_delta_snapshot(
    pid: u64,
    before: &RootSnapshot,
    event_cursor: u64,
) -> Result<(RootSnapshot, &'static str, Vec<Value>), ProtocolError> {
    let before_sig = root_signature(before);
    let deadline = Instant::now() + Duration::from_millis(300);
    let mut signaled = false;
    let mut after = snapshot_roots(pid)?;
    while Instant::now() < deadline {
        after = snapshot_roots(pid)?;
        if root_signature(&after) != before_sig
            || !window::root_events_since(event_cursor, pid).is_empty()
        {
            signaled = true;
            break;
        }
        sleep(Duration::from_millis(30));
    }
    if signaled {
        // Signals accelerate the settle window, but the reported delta is always
        // a full before/after snapshot diff.  Keep re-diffing briefly so a
        // close-then-open transition (menus/popups) does not report only the
        // first observed close.
        for _ in 0..3 {
            sleep(Duration::from_millis(60));
            after = snapshot_roots(pid)?;
        }
        let events = window::root_events_since(event_cursor, pid);
        let source = if events.is_empty() {
            "win-poll"
        } else {
            "win-event+snapshot"
        };
        Ok((after, source, events))
    } else {
        Ok((after, "snapshot", Vec::new()))
    }
}

fn combined_root_delta(
    before: &RootSnapshot,
    after: &RootSnapshot,
    target_pid: u64,
    events: Vec<Value>,
) -> Vec<Value> {
    let mut delta = root_delta(before, after, target_pid);
    for event in events {
        let duplicate = delta.iter().any(|item| {
            item.get("change") == event.get("change")
                && item.get("kind") == event.get("kind")
                && item.get("title") == event.get("title")
                && item.get("pid") == event.get("pid")
        });
        if !duplicate {
            delta.push(event);
        }
    }
    delta
}

fn root_delta(before: &RootSnapshot, after: &RootSnapshot, target_pid: u64) -> Vec<Value> {
    let mut delta = Vec::new();
    for (key, root) in &after.roots {
        if !before.roots.contains_key(key) {
            delta.push(delta_item("appeared", root));
        }
    }
    for (key, root) in &before.roots {
        if !after.roots.contains_key(key) {
            delta.push(delta_item("closed", root));
        }
    }
    for (key, root) in &after.roots {
        if root.get("isFocused").and_then(Value::as_bool) == Some(true)
            && before
                .roots
                .get(key)
                .and_then(|r| r.get("isFocused"))
                .and_then(Value::as_bool)
                != Some(true)
        {
            delta.push(delta_item("focused", root));
        }
    }
    if before.foreground_pid != after.foreground_pid && after.foreground_pid != Some(target_pid) {
        delta.push(json!({ "change": "focused", "kind": "app", "title": "Foreground app", "pid": after.foreground_pid.unwrap_or(0) }));
    }
    delta
}

fn delta_item(change: &str, root: &Value) -> Value {
    let mut item = json!({
        "change": change,
        "kind": root.get("kind").and_then(Value::as_str).unwrap_or("window"),
        "ref": root.get("rootRef").and_then(Value::as_str).unwrap_or(""),
        "title": root.get("title").and_then(Value::as_str).unwrap_or(""),
        "pid": root.get("pid").and_then(Value::as_u64).unwrap_or(0)
    });
    if let Some(is_modal) = root.get("isModal").and_then(Value::as_bool) {
        item["isModal"] = json!(is_modal);
    }
    if let Some(metadata) = root.get("metadata") {
        item["metadata"] = metadata.clone();
    }
    item
}

fn handle_read_text(args: &Value) -> Result<Value, ProtocolError> {
    let look_id = args
        .get("lookId")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("uiaReadText requires lookId"))?;
    let element_ref = args
        .get("elementRef")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("uiaReadText requires elementRef"))?;
    let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(4096) as usize;
    let element = {
        let state = helper_state()
            .lock()
            .map_err(|_| internal("helper state lock poisoned"))?;
        state.element_for_look(look_id, element_ref)?
    };
    if element.is_secure {
        return Err(ProtocolError::new(
            "Refers to a secure text field; refusing to read its value",
            ErrorCode::SecureTextUnreadable,
        ));
    }
    let text = windows_bridge::uia::read_live_text(
        element.hwnd,
        &element.runtime_id,
        &element.automation_id,
    )
    .map_err(stale_ref_from_uia)?;
    let characters = text.chars().collect::<Vec<_>>();
    let end = offset.saturating_add(limit).min(characters.len());
    let slice = if offset >= characters.len() {
        String::new()
    } else {
        characters[offset..end].iter().collect()
    };
    Ok(
        json!({ "text": slice, "offset": offset, "limit": limit, "totalChars": characters.len(), "hasMore": end < characters.len() }),
    )
}

fn handle_wait_for(args: &Value) -> Result<Value, ProtocolError> {
    let timeout_ms = args
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(10_000)
        .clamp(100, 60_000);
    let text = args
        .get("text")
        .and_then(Value::as_str)
        .map(|s| s.to_lowercase());
    let role = args.get("role").and_then(Value::as_str).map(str::to_owned);
    let expected_value = args
        .get("value")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_lowercase());
    let gone = args.get("gone").and_then(Value::as_bool).unwrap_or(false);
    if text.is_none() && role.is_none() && expected_value.is_none() {
        return Err(invalid("uiaWaitFor requires text, role, or value"));
    }
    let hwnd = wait_target_hwnd(args)?;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut node_count = 0;
    while Instant::now() < deadline {
        let elements = windows_bridge::uia::live_elements(hwnd).map_err(internal)?;
        node_count = elements.len();
        let found = elements.iter().any(|element| {
            let candidate_text = ["value", "label", "name", "title"]
                .iter()
                .filter_map(|key| element.get(*key).and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();
            let candidate_role = element.get("role").and_then(Value::as_str).unwrap_or("");
            let candidate_value = element
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_lowercase();
            text.as_ref()
                .map(|needle| candidate_text.contains(needle))
                .unwrap_or(true)
                && role.as_ref().map(|r| candidate_role == r).unwrap_or(true)
                && expected_value
                    .as_ref()
                    .map(|value| candidate_value == *value)
                    .unwrap_or(true)
        });
        if found != gone {
            return Ok(
                json!({ "found": true, "gone": if gone { Some(true) } else { None::<bool> }, "nodeCount": node_count }),
            );
        }
        sleep(Duration::from_millis(150));
    }
    Ok(json!({ "found": false, "timedOut": true, "nodeCount": node_count }))
}

fn wait_target_hwnd(args: &Value) -> Result<isize, ProtocolError> {
    if let Some(window_id) = args.get("windowId").and_then(Value::as_i64) {
        return Ok(window_id as isize);
    }
    if let Some(root_ref) = args
        .get("rootRef")
        .or_else(|| args.get("windowRef"))
        .and_then(Value::as_str)
    {
        let state = helper_state()
            .lock()
            .map_err(|_| internal("helper state lock poisoned"))?;
        for root in state.roots.values() {
            if root.get("rootRef").and_then(Value::as_str) == Some(root_ref)
                || root.get("windowRef").and_then(Value::as_str) == Some(root_ref)
            {
                return Ok(root.get("windowId").and_then(Value::as_i64).unwrap_or(0) as isize);
            }
        }
    }
    if let Some(pid) = args.get("pid").and_then(Value::as_u64) {
        let roots = snapshot_roots(pid)?;
        if let Some(root) = roots
            .roots
            .values()
            .find(|root| root.get("pid").and_then(Value::as_u64) == Some(pid))
        {
            return Ok(root.get("windowId").and_then(Value::as_i64).unwrap_or(0) as isize);
        }
    }
    Err(ProtocolError::new(
        "waitFor target root was not found",
        ErrorCode::TargetNotFound,
    ))
}

fn handle_open_browser_location(args: &Value) -> Result<Value, ProtocolError> {
    let app_name = args
        .get("appName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    let roots = handle_list_roots(&json!({}))?;
    let root = roots_array(&roots).into_iter().find(|root| {
        root.get("appName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase()
            .contains(&app_name)
    });
    if let Some(root) = root {
        let hwnd = root.get("windowId").and_then(Value::as_i64).unwrap_or(0) as isize;
        let url = args
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("openBrowserLocation requires url"))?;
        with_physical_input(|| {
            window::ensure_foreground(hwnd)?;
            input::open_browser_location(url)
        })?;
        Ok(json!({ "opened": true }))
    } else {
        Err(ProtocolError::new("Target browser window was not found; refusing to type into the currently focused window", ErrorCode::TargetNotFound))
    }
}

fn roots_array(value: &Value) -> Vec<Value> {
    value
        .get("roots")
        .or_else(|| value.get("windows"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn root_identity(root: &Value) -> String {
    if let Some(id) = root.get("windowId").and_then(Value::as_i64) {
        return format!("window:{id}");
    }
    format!(
        "meta:{}:{}:{}",
        root.get("kind").and_then(Value::as_str).unwrap_or("window"),
        root.get("title").and_then(Value::as_str).unwrap_or(""),
        root.get("rootRef").and_then(Value::as_str).unwrap_or("")
    )
}

fn number_at(value: &Value, key: &str, fallback: f64) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(fallback)
}
fn invalid(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(message.into(), ErrorCode::InvalidRequest)
}
fn internal(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(message.into(), ErrorCode::InternalError)
}
fn now_seconds() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn emit_response(response: &Response) {
    let json = serde_json::to_string(response).expect("Response serialization should not fail");
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{json}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(id: i64, pid: u64, title: &str, focused: bool) -> Value {
        json!({ "windowId": id, "kind": "window", "title": title, "pid": pid, "rootRef": format!("@w{id}"), "isFocused": focused })
    }

    fn snap(roots: Vec<Value>, foreground_pid: Option<u64>) -> RootSnapshot {
        RootSnapshot {
            roots: roots
                .into_iter()
                .map(|root| (root_identity(&root), root))
                .collect(),
            foreground_pid,
        }
    }

    #[test]
    fn root_delta_uses_act_time_baseline_for_two_acts_one_look() {
        let look_time = snap(vec![root(1, 1, "A", true)], Some(1));
        let after_first = snap(vec![root(1, 1, "A", false), root(2, 1, "B", true)], Some(1));
        let after_second = snap(
            vec![
                root(1, 1, "A", false),
                root(2, 1, "B", false),
                root(3, 1, "C", true),
            ],
            Some(1),
        );
        let first = root_delta(&look_time, &after_first, 1);
        assert!(first
            .iter()
            .any(|item| item["title"] == "B" && item["change"] == "appeared"));
        let second = root_delta(&after_first, &after_second, 1);
        assert!(
            !second
                .iter()
                .any(|item| item["title"] == "B" && item["change"] == "appeared"),
            "second act must not re-report first act delta"
        );
        assert!(second
            .iter()
            .any(|item| item["title"] == "C" && item["change"] == "appeared"));
    }

    #[test]
    fn root_delta_scopes_to_target_pid_and_foreground_flip() {
        let before = snap(vec![root(1, 1, "Target", true)], Some(1));
        let after_same_pid = snap(
            vec![root(1, 1, "Target", false), root(2, 1, "Dialog", true)],
            Some(1),
        );
        assert!(root_delta(&before, &after_same_pid, 1)
            .iter()
            .any(|item| item["title"] == "Dialog" && item["change"] == "appeared"));

        let after_other_pid_filtered = snap(vec![root(1, 1, "Target", true)], Some(1));
        assert!(
            root_delta(&before, &after_other_pid_filtered, 1).is_empty(),
            "other-pid window churn is excluded before diffing"
        );

        let foreground_flip = snap(vec![root(1, 1, "Target", true)], Some(2));
        let delta = root_delta(&before, &foreground_flip, 1);
        assert!(delta
            .iter()
            .any(|item| item["change"] == "focused" && item["kind"] == "app" && item["pid"] == 2));
    }

    #[test]
    fn root_delta_coalesces_close_then_open_from_final_snapshot() {
        let before = snap(
            vec![root(1, 1, "Editor", false), root(2, 1, "Old menu", true)],
            Some(1),
        );
        let after = snap(
            vec![root(1, 1, "Editor", false), root(3, 1, "File menu", true)],
            Some(1),
        );
        let delta = root_delta(&before, &after, 1);
        assert!(delta
            .iter()
            .any(|item| item["title"] == "Old menu" && item["change"] == "closed"));
        assert!(delta
            .iter()
            .any(|item| item["title"] == "File menu" && item["change"] == "appeared"));
    }

    #[test]
    fn action_batch_rejects_empty_transactions() {
        let error = handle_act_batch(&json!({ "actions": [] })).expect_err("empty batch must fail");
        assert_eq!(error.code, ErrorCode::InvalidRequest);
    }

    fn look_with_element(x: f64) -> LookRecord {
        LookRecord {
            pid: 1,
            hwnd: 1,
            frame_x: 0.0,
            frame_y: 0.0,
            frame_w: 100.0,
            frame_h: 100.0,
            image_w: 100.0,
            image_h: 100.0,
            has_image: false,
            elements: HashMap::from([(
                "same-ref".to_owned(),
                ElementRecord {
                    hwnd: 1,
                    x,
                    y: 0.0,
                    w: 1.0,
                    h: 1.0,
                    automation_id: String::new(),
                    class_name: String::new(),
                    is_secure: false,
                    can_press: true,
                    can_set_value: true,
                    can_scroll: true,
                    runtime_id: vec![],
                },
            )]),
        }
    }

    #[test]
    fn observation_ownership_is_explicit_and_bounded() {
        let mut state = HelperState::default();
        state.insert_look("look-a".to_owned(), look_with_element(1.0));
        state.insert_look("look-b".to_owned(), look_with_element(2.0));
        assert_eq!(state.element_for_look("look-a", "same-ref").unwrap().x, 1.0);
        assert_eq!(state.element_for_look("look-b", "same-ref").unwrap().x, 2.0);
        for index in 0..MAX_LOOK_RECORDS {
            state.insert_look(format!("new-{index}"), look_with_element(index as f64));
        }
        assert_eq!(state.looks.len(), MAX_LOOK_RECORDS);
        assert_eq!(
            state
                .element_for_look("look-a", "same-ref")
                .unwrap_err()
                .code,
            ErrorCode::StaleLook
        );
    }

    #[test]
    fn outline_nesting_uses_native_parentage() {
        let nodes = vec![
            (
                "1".to_owned(),
                String::new(),
                json!({"title":"parent","children":[]}),
            ),
            (
                "2".to_owned(),
                "1".to_owned(),
                json!({"title":"child","children":[]}),
            ),
        ];
        let nested = nest_outline_nodes(&nodes);
        assert_eq!(nested.len(), 1);
        assert_eq!(nested[0]["children"][0]["title"], "child");
    }

    #[test]
    fn scoped_outline_preserves_the_parent_wire_ref() {
        let outline = json!({
            "ref": "@w1",
            "children": [{ "ref": "win:look-2:@e1", "title": "scope", "children": [{ "ref": "win:look-2:@e2" }] }]
        });
        let scoped = scoped_outline_root(outline, "win:look-1:@e9");
        assert_eq!(scoped["ref"], "win:look-1:@e9");
        assert_eq!(scoped["children"][0]["ref"], "win:look-2:@e2");
    }

    #[test]
    fn batch_locking_is_capability_driven() {
        let mut record = look_with_element(1.0);
        let native_press = json!({"lookId":"look","action":"press","policy":"default","target":{"ref":"same-ref"},"params":{}});
        assert!(!action_may_use_physical_input(&native_press, &record));
        record.elements.get_mut("same-ref").unwrap().class_name = "Chrome_WidgetWin_1".to_owned();
        assert!(!action_may_use_physical_input(&native_press, &record));
        let foreground_press = json!({"lookId":"look","action":"press","policy":"foreground","target":{"ref":"same-ref"},"params":{}});
        assert!(action_may_use_physical_input(&foreground_press, &record));
        let ax_only = json!({"lookId":"look","action":"press","policy":"ax_only","target":{"ref":"same-ref"},"params":{}});
        assert!(!action_may_use_physical_input(&ax_only, &record));
        let coordinates = json!({"lookId":"look","action":"click","policy":"foreground","target":{"x":1,"y":2},"params":{}});
        assert!(action_may_use_physical_input(&coordinates, &record));
    }

    #[test]
    fn event_journal_preserves_transient_roots_absent_from_final_snapshot() {
        let before = snap(vec![root(1, 1, "Editor", true)], Some(1));
        let after = before.clone();
        let events = vec![
            json!({"change":"appeared","kind":"menu","title":"File","pid":1}),
            json!({"change":"closed","kind":"menu","title":"File","pid":1}),
        ];
        let delta = combined_root_delta(&before, &after, 1, events);
        assert_eq!(delta.len(), 2);
        assert_eq!(delta[0]["change"], "appeared");
        assert_eq!(delta[1]["change"], "closed");
    }
}
