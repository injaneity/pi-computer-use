use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use linux_bridge::atspi::{outline_json, root_json, AtspiClient, NodeSnapshot, Rect, RootSnapshot};
use linux_bridge::protocol::PROTOCOL_VERSION;
use linux_bridge::state::{fresh_state_id, HelperState};
use linux_bridge::wayland::{PortalCapabilities, PortalClient, PortalError};
use linux_bridge::x11::{self, PhysicalPolicy, SessionKind};
use linux_bridge::{ErrorCode, ProtocolError, Request, Response};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

const REQUEST_WORKERS: usize = 8;
const DEFAULT_MAX_NODES: usize = 512;

#[tokio::main(flavor = "multi_thread", worker_threads = 8)]
async fn main() {
    let state = Arc::new(Mutex::new(HelperState::default()));
    let (output, mut responses) = mpsc::unbounded_channel::<Response>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(response) = responses.recv().await {
            if let Ok(mut line) = serde_json::to_vec(&response) {
                line.push(b'\n');
                if stdout.write_all(&line).await.is_err() {
                    return;
                }
                let _ = stdout.flush().await;
            }
        }
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let semaphore = Arc::new(tokio::sync::Semaphore::new(REQUEST_WORKERS));
    let mut requests = tokio::task::JoinSet::new();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let id = extract_id(&line).unwrap_or_else(|| "unknown".to_owned());
        let request = match serde_json::from_str::<Request>(&line) {
            Ok(request) => request,
            Err(error) => {
                let _ = output.send(Response::err(
                    &id,
                    ProtocolError::new(
                        format!("Invalid request: {error}"),
                        ErrorCode::InvalidRequest,
                    ),
                ));
                continue;
            }
        };
        let Ok(permit) = semaphore.clone().acquire_owned().await else {
            break;
        };
        let state = Arc::clone(&state);
        let output = output.clone();
        requests.spawn(async move {
            let _permit = permit;
            let response = handle_request(&state, &request).await;
            let _ = output.send(response);
        });
    }
    while requests.join_next().await.is_some() {}
    drop(output);
    let _ = writer.await;
}

fn action_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn extract_id(line: &str) -> Option<String> {
    serde_json::from_str::<Value>(line)
        .ok()?
        .get("id")?
        .as_str()
        .map(str::to_owned)
}

async fn handle_request(state: &Arc<Mutex<HelperState>>, request: &Request) -> Response {
    if request.protocol_version != PROTOCOL_VERSION {
        return Response::err(
            &request.id,
            invalid(format!(
                "Unsupported Linux helper protocol {}; expected {}. Restart Pi to use the installed helper.",
                request.protocol_version, PROTOCOL_VERSION
            )),
        );
    }
    let result = match request.cmd.as_str() {
        "diagnostics" => Ok(diagnostics().await),
        "listRoots" | "listWindows" => list_roots(state, &request.args).await,
        "look" | "screenshot" => look(state, &request.args).await,
        "act" => {
            let _transaction = action_lock().lock().await;
            act(state, &request.args).await
        }
        "actBatch" => {
            let _transaction = action_lock().lock().await;
            act_batch(state, &request.args).await
        }
        "atspiReadText" | "uiaReadText" | "axReadText" => read_text(state, &request.args).await,
        "atspiWaitFor" | "uiaWaitFor" | "axWaitFor" => wait_for(state, &request.args).await,
        "focusWindow" => focus_window(state, &request.args),
        "openBrowserLocation" => open_browser_location(&request.args),
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

async fn diagnostics() -> Value {
    let accessibility = AtspiClient::available().await;
    let session = SessionKind::detect();
    let x11_available = x11::available();
    let wayland_portal = if session == SessionKind::Wayland {
        let probe = match PortalClient::connect().await {
            Ok(client) => client.probe().await,
            Err(error) => Err(error),
        };
        portal_diagnostics(Some(probe))
    } else {
        portal_diagnostics(None)
    };
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "architectureVersion": 1,
        "invariants": [
            "state-scoped-observations",
            "bounded-observation-history",
            "multi-root-forest",
            "progressive-disclosure",
            "atomic-physical-input",
            "concurrent-requests",
            "transactional-batching"
        ],
        "pid": std::process::id(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "backend": if x11_available { "at-spi2+x11" } else { "at-spi2" },
        "sessionType": session.as_str(),
        "x11": x11_available,
        "accessibility": accessibility,
        "screenRecording": x11_available,
        "coordinateInput": x11_available,
        "waylandPortal": wayland_portal,
        "capabilities": {
            "roots": accessibility,
            "outline": accessibility,
            "readText": accessibility,
            "waitFor": accessibility,
            "semanticPress": accessibility,
            "semanticSetText": accessibility,
            "screenshots": x11_available,
            "coordinates": x11_available,
            "forceFocus": x11_available
        }
    })
}

fn portal_diagnostics(probe: Option<Result<PortalCapabilities, PortalError>>) -> Value {
    match probe {
        Some(Ok(capabilities)) => json!({
            "probed": true,
            "available": true,
            "interactiveUseEnabled": false,
            "readOnlyProbe": true,
            "remoteDesktopVersion": capabilities.remote_desktop_version,
            "screenCastVersion": capabilities.screen_cast_version,
            "availableDeviceTypes": capabilities.available_device_types,
            "availableSourceTypes": capabilities.available_source_types,
            "availableCursorModes": capabilities.available_cursor_modes,
        }),
        Some(Err(error)) => json!({
            "probed": true,
            "available": false,
            "interactiveUseEnabled": false,
            "readOnlyProbe": true,
            "error": {
                "kind": "portal_unavailable",
                "message": error.to_string(),
            },
        }),
        None => json!({
            "probed": false,
            "available": false,
            "interactiveUseEnabled": false,
            "readOnlyProbe": true,
            "reason": "not_wayland",
        }),
    }
}

async fn list_roots(state: &Arc<Mutex<HelperState>>, args: &Value) -> Result<Value, ProtocolError> {
    let client = AtspiClient::connect().await?;
    let mut roots = client
        .list_roots(args.get("pid").and_then(Value::as_u64))
        .await?;
    if let Ok(windows) = x11::list_windows() {
        x11::enrich_roots(&mut roots, &windows);
    }
    let stored = lock(state)?.replace_roots(roots);
    let windows = stored
        .iter()
        .enumerate()
        .map(|(index, (reference, root))| root_json(reference, root, index))
        .collect::<Vec<_>>();
    Ok(json!({
        "stateId": fresh_state_id(),
        "windows": windows,
        "roots": windows
    }))
}

async fn resolve_root(
    state: &Arc<Mutex<HelperState>>,
    args: &Value,
) -> Result<(String, RootSnapshot), ProtocolError> {
    let requested = args
        .get("rootRef")
        .or_else(|| args.get("windowRef"))
        .and_then(Value::as_str);
    if let Some(reference) = requested {
        if let Some(root) = lock(state)?.root(reference) {
            return Ok((reference.to_owned(), root));
        }
    }
    if lock(state)?.roots().is_empty() {
        list_roots(state, &json!({})).await?;
    }
    let roots = lock(state)?.roots();
    let requested_pid = args.get("pid").and_then(Value::as_u64);
    roots
        .into_iter()
        .find(|(_, root)| {
            requested.is_none() && requested_pid.map(|pid| root.pid == pid).unwrap_or(true)
        })
        .ok_or_else(|| ProtocolError::new("Root not found", ErrorCode::TargetNotFound))
}

fn initial_image_size(root: &RootSnapshot, base_size: Option<(u16, u16)>) -> (u16, u16) {
    base_size.unwrap_or_else(|| {
        root.frame
            .as_ref()
            .map(|frame| {
                (
                    frame.width.max(1).min(i32::from(u16::MAX)) as u16,
                    frame.height.max(1).min(i32::from(u16::MAX)) as u16,
                )
            })
            .unwrap_or((1, 1))
    })
}

async fn look(state: &Arc<Mutex<HelperState>>, args: &Value) -> Result<Value, ProtocolError> {
    let started = Instant::now();
    let (root_ref, root) = resolve_root(state, args).await?;
    let read_text = args
        .get("readText")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    if !matches!(read_text, "auto" | "always" | "never") {
        return Err(invalid("readText must be auto, always, or never"));
    }
    let max_nodes = args
        .get("maxNodes")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_MAX_NODES as u64)
        .clamp(1, 4096) as usize;
    let max_depth = args
        .get("maxDepth")
        .and_then(Value::as_u64)
        .unwrap_or(20)
        .clamp(1, 64) as usize;
    let max_dimension = args
        .get("maxDimension")
        .and_then(Value::as_u64)
        .map(|value| value.clamp(1, 16_384) as u32);
    let client = AtspiClient::connect().await?;
    let scope_ref = args.get("scopeRef").and_then(Value::as_str);
    let base_look_id = args.get("baseLookId").and_then(Value::as_str);
    let (nodes, base) = if let Some(scope_ref) = scope_ref {
        let (base, scope) = lock(state)?.scope(scope_ref, base_look_id)?;
        if base.root.accessible != root.accessible {
            return Err(ProtocolError::new(
                "Scope ref is outside the target root",
                ErrorCode::StaleRef,
            ));
        }
        (
            client
                .snapshot_from(&scope.accessible, max_nodes, max_depth)
                .await?,
            Some(base),
        )
    } else {
        (client.snapshot(&root, max_nodes, max_depth).await?, None)
    };
    let (look_id, nodes) = lock(state)?.insert_look(root.clone(), nodes, base.as_ref());
    let mut outline = outline_json(&root, &nodes, max_nodes);
    let elapsed = started.elapsed().as_millis() as u64;
    let frame = root
        .frame
        .as_ref()
        .map(|r| json!({"x":r.x,"y":r.y,"w":r.width,"h":r.height}))
        .unwrap_or_else(|| json!({"x":0,"y":0,"w":0,"h":0}));
    let mut image_size = initial_image_size(
        &root,
        base.as_ref()
            .map(|record| (record.image_width, record.image_height)),
    );
    let image = if args
        .get("includeImage")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        match root.x11_window {
            Some(window) => {
                let shot = x11::capture_window(window, max_dimension)?;
                image_size = (shot.width, shot.height);
                Some(json!({
                    "jpegBase64": shot.png_base64, "mimeType":"image/png", "width":shot.width, "height":shot.height,
                    "metadata":{"source":shot.source,"warnings":shot.warnings}
                }))
            }
            None => None,
        }
    } else {
        None
    };
    lock(state)?.set_look_image_size(&look_id, image_size.0, image_size.1)?;
    let (scale_x, scale_y) = root
        .frame
        .as_ref()
        .map(|frame| {
            (
                f64::from(image_size.0) / f64::from(frame.width.max(1)),
                f64::from(image_size.1) / f64::from(frame.height.max(1)),
            )
        })
        .unwrap_or((1.0, 1.0));
    scale_outline_rects(&mut outline, scale_x, scale_y);
    let mut response = json!({
        "lookId": look_id,
        "capturedAt": now_seconds(),
        "window": {
            "windowId": root.x11_window,
            "rootRef": root_ref,
            "kind": "window",
            "framePoints": frame,
            "scaleFactor": scale_x,
            "isModal": root.role.to_lowercase().contains("dialog"),
            "role": root.role,
            "subrole": "",
            "metadata": {"backend":"at-spi2","imageScaleX":scale_x,"imageScaleY":scale_y}
        },
        "outline": outline,
        "timings": {"captureMs":0,"describeMs":elapsed,"readTextMs":0,"totalMs":elapsed},
        "readText": {"requested":read_text,"executed":false}
    });
    if let Some(image) = image {
        response["image"] = image;
    }
    Ok(response)
}

fn focus_window(state: &Arc<Mutex<HelperState>>, args: &Value) -> Result<Value, ProtocolError> {
    let reference = args
        .get("rootRef")
        .or_else(|| args.get("windowRef"))
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("focusWindow requires rootRef"))?;
    let root = lock(state)?
        .root(reference)
        .ok_or_else(|| ProtocolError::new("Root not found", ErrorCode::TargetNotFound))?;
    let window = root
        .x11_window
        .ok_or_else(|| capability("Root is not correlated with an X11 window"))?;
    let policy = if args.get("policy").is_some() {
        PhysicalPolicy::parse(args.get("policy").and_then(Value::as_str))?
    } else {
        PhysicalPolicy::Foreground
    };
    x11::focus_window(window, policy)
}

fn open_browser_location(args: &Value) -> Result<Value, ProtocolError> {
    let url = required_str(args, "url", "openBrowserLocation requires a non-empty url")?;
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map_err(|error| {
            ProtocolError::new(
                format!("Failed to launch xdg-open: {error}"),
                ErrorCode::CapabilityDeferred,
            )
        })?;
    Ok(json!({"opened": true, "delivery": "xdg-open"}))
}

async fn act(state: &Arc<Mutex<HelperState>>, args: &Value) -> Result<Value, ProtocolError> {
    let look_id = required_str(args, "lookId", "act requires lookId")?;
    let action = required_str(args, "action", "act requires action")?;
    let target = args
        .get("target")
        .ok_or_else(|| invalid("act requires target"))?;
    let params = args.get("params").cloned().unwrap_or_else(|| json!({}));
    let policy = PhysicalPolicy::parse(args.get("policy").and_then(Value::as_str))?;
    let record = lock(state)?.look(look_id)?;
    let client = AtspiClient::connect().await?;

    if let Some(reference) = target.get("ref").and_then(Value::as_str) {
        let node = lock(state)?.element(look_id, reference)?;
        match action {
            "press" | "click" => {
                if let Ok(worked) = client.press(&node).await {
                    return Ok(
                        json!({"outcome":if worked{"worked"}else{"didnt"},"performed":semantic_performed()}),
                    );
                }
            }
            "setText" | "typeText" => {
                let text = params.get("text").and_then(Value::as_str).unwrap_or("");
                if let Ok(worked) = client.set_text(&node, text).await {
                    return Ok(
                        json!({"outcome":if worked{"worked"}else{"didnt"},"performed":semantic_performed(),"evidence":{"value":text}}),
                    );
                }
            }
            _ => {}
        }
        // Semantic delivery was attempted first. Only an explicitly physical-capable
        // policy may fall back to the element centre.
        let bounds = node.bounds.ok_or_else(|| {
            ProtocolError::new(
                "Element has no coordinate fallback",
                ErrorCode::CoordinateUnavailableForRoot,
            )
        })?;
        let frame = record.root.frame.clone().ok_or_else(|| {
            ProtocolError::new(
                "Root has no coordinate geometry",
                ErrorCode::CoordinateUnavailableForRoot,
            )
        })?;
        let owning_window = record.root.x11_window.ok_or_else(|| {
            capability("Observed root is not correlated with an owning X11 window")
        })?;
        return physical_act(
            action,
            &params,
            policy,
            owning_window,
            (bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
            ActionGeometry {
                frame,
                image_width: record.image_width,
                image_height: record.image_height,
            },
        );
    }
    let x = target
        .get("x")
        .and_then(Value::as_f64)
        .ok_or_else(|| invalid("coordinate target requires x"))?;
    let y = target
        .get("y")
        .and_then(Value::as_f64)
        .ok_or_else(|| invalid("coordinate target requires y"))?;
    let owning_window = record
        .root
        .x11_window
        .ok_or_else(|| capability("Observed root is not correlated with an owning X11 window"))?;
    let frame = record.root.frame.ok_or_else(|| {
        ProtocolError::new(
            "Root has no coordinate geometry",
            ErrorCode::CoordinateUnavailableForRoot,
        )
    })?;
    let (screen_x, screen_y) =
        image_point_to_screen(&frame, record.image_width, record.image_height, x, y)?;
    physical_act(
        action,
        &params,
        policy,
        owning_window,
        (screen_x, screen_y),
        ActionGeometry {
            frame,
            image_width: record.image_width,
            image_height: record.image_height,
        },
    )
}

#[derive(Debug, Clone)]
struct ActionGeometry {
    frame: Rect,
    image_width: u16,
    image_height: u16,
}

fn image_point_to_screen(
    frame: &Rect,
    image_width: u16,
    image_height: u16,
    x: f64,
    y: f64,
) -> Result<(i32, i32), ProtocolError> {
    if !x.is_finite()
        || !y.is_finite()
        || x < 0.0
        || y < 0.0
        || x >= f64::from(image_width)
        || y >= f64::from(image_height)
    {
        return Err(invalid("Coordinates are outside the owning look image"));
    }
    Ok((
        frame.x + (x * f64::from(frame.width) / f64::from(image_width.max(1))).round() as i32,
        frame.y + (y * f64::from(frame.height) / f64::from(image_height.max(1))).round() as i32,
    ))
}

fn scale_outline_rects(value: &mut Value, scale_x: f64, scale_y: f64) {
    match value {
        Value::Object(object) => {
            if let Some(Value::Object(rect)) = object.get_mut("rect") {
                for (key, scale) in [
                    ("x", scale_x),
                    ("w", scale_x),
                    ("y", scale_y),
                    ("h", scale_y),
                ] {
                    if let Some(number) = rect.get(key).and_then(Value::as_f64) {
                        rect.insert(key.to_owned(), json!(number * scale));
                    }
                }
            }
            for child in object.values_mut() {
                scale_outline_rects(child, scale_x, scale_y);
            }
        }
        Value::Array(items) => {
            for child in items {
                scale_outline_rects(child, scale_x, scale_y);
            }
        }
        _ => {}
    }
}

fn physical_act(
    action: &str,
    params: &Value,
    policy: PhysicalPolicy,
    owning_window: u32,
    point: (i32, i32),
    geometry: ActionGeometry,
) -> Result<Value, ProtocolError> {
    let (x, y) = point;
    let input = x11::Input::connect(policy, owning_window)?;
    let button = params
        .get("button")
        .and_then(Value::as_str)
        .unwrap_or("left");
    match action {
        "press" | "click" => input.click(
            x,
            y,
            button,
            params
                .get("clickCount")
                .and_then(Value::as_u64)
                .unwrap_or(1),
        )?,
        "moveMouse" => input.move_pointer(x, y)?,
        "scroll" => input.scroll(
            x,
            y,
            params.get("scrollX").and_then(Value::as_f64).unwrap_or(0.0),
            params.get("scrollY").and_then(Value::as_f64).unwrap_or(0.0),
        )?,
        "drag" => {
            let path = params
                .get("path")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid("drag requires path"))?;
            let points = path
                .iter()
                .map(|p| {
                    image_point_to_screen(
                        &geometry.frame,
                        geometry.image_width,
                        geometry.image_height,
                        p.get("x")
                            .and_then(Value::as_f64)
                            .ok_or_else(|| invalid("drag point requires x"))?,
                        p.get("y")
                            .and_then(Value::as_f64)
                            .ok_or_else(|| invalid("drag point requires y"))?,
                    )
                })
                .collect::<Result<Vec<_>, ProtocolError>>()?;
            input.drag(&points, button)?;
        }
        "typeText" => input.type_text(params.get("text").and_then(Value::as_str).unwrap_or(""))?,
        "setText" => {
            input.click(x, y, button, 1)?;
            input.keypress(&["control", "a"])?;
            input.type_text(params.get("text").and_then(Value::as_str).unwrap_or(""))?;
        }
        "keypress" => {
            let keys = params
                .get("keys")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid("keypress requires keys"))?
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            input.keypress(&keys)?;
        }
        other => {
            return Err(ProtocolError::new(
                format!("Unsupported Linux action '{other}'"),
                ErrorCode::UnsupportedCommand,
            ))
        }
    }
    Ok(
        json!({"outcome":"unknown","performed":{"grounding":"coordinates","delivery":"hid","mechanism":"xtest","deltaSource":"snapshot","windowId":owning_window},"evidence":{"mechanism":"xtest","windowId":owning_window}}),
    )
}

async fn act_batch(state: &Arc<Mutex<HelperState>>, args: &Value) -> Result<Value, ProtocolError> {
    let actions = args
        .get("actions")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("actBatch requires actions"))?;
    if actions.is_empty() || actions.len() > 20 {
        return Err(invalid("actBatch requires 1...20 actions"));
    }
    let first_look = required_str(&actions[0], "lookId", "actBatch actions require lookId")?;
    if actions
        .iter()
        .any(|action| action.get("lookId").and_then(Value::as_str) != Some(first_look))
    {
        return Err(invalid("actBatch actions must belong to one look"));
    }
    let mut steps = Vec::new();
    let mut stopped_at = None;
    for (index, action) in actions.iter().enumerate() {
        match act(state, action).await {
            Ok(step) => {
                let stopped = step.get("outcome").and_then(Value::as_str) == Some("didnt");
                steps.push(step);
                if stopped {
                    stopped_at = Some(index);
                    break;
                }
            }
            Err(error) => {
                steps.push(json!({"outcome":"didnt","error":{"code":error.code.to_string(),"message":error.message}}));
                stopped_at = Some(index);
                break;
            }
        }
    }
    let outcome = batch_outcome(&steps, stopped_at.is_some());
    let mut response = json!({
        "outcome": outcome,
        "performed":{"transaction":true,"actionCount":steps.len(),"deltaSource":"snapshot"},
        "steps":steps
    });
    if let Some(index) = stopped_at {
        response["stoppedAt"] = json!(index);
    }
    Ok(response)
}

fn batch_outcome(steps: &[Value], stopped: bool) -> &'static str {
    if stopped {
        "didnt"
    } else if steps
        .iter()
        .any(|step| step.get("outcome").and_then(Value::as_str) == Some("unknown"))
    {
        "unknown"
    } else {
        "worked"
    }
}

async fn read_text(state: &Arc<Mutex<HelperState>>, args: &Value) -> Result<Value, ProtocolError> {
    let look_id = required_str(args, "lookId", "atspiReadText requires lookId")?;
    let element_ref = required_str(args, "elementRef", "atspiReadText requires elementRef")?;
    let node = lock(state)?.element(look_id, element_ref)?;
    if node.is_secure {
        return Err(ProtocolError::new(
            "Refers to a secure text field; refusing to read its value",
            ErrorCode::SecureTextUnreadable,
        ));
    }
    let text = AtspiClient::connect()
        .await?
        .read_text(&node.accessible)
        .await?;
    let characters = text.chars().collect::<Vec<_>>();
    let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(4096) as usize;
    let end = offset.saturating_add(limit).min(characters.len());
    let slice = if offset >= characters.len() {
        String::new()
    } else {
        characters[offset..end].iter().collect()
    };
    Ok(
        json!({"text":slice,"offset":offset,"limit":limit,"totalChars":characters.len(),"hasMore":end<characters.len()}),
    )
}

async fn wait_for(state: &Arc<Mutex<HelperState>>, args: &Value) -> Result<Value, ProtocolError> {
    let text = args
        .get("text")
        .and_then(Value::as_str)
        .map(|s| s.to_lowercase());
    let role = args
        .get("role")
        .and_then(Value::as_str)
        .map(|s| s.to_lowercase());
    let value = args
        .get("value")
        .and_then(Value::as_str)
        .map(|s| s.to_lowercase());
    if text.is_none() && role.is_none() && value.is_none() {
        return Err(invalid("atspiWaitFor requires text, role, or value"));
    }
    let (_, root) = resolve_root(state, args).await?;
    let scope_exact = args
        .get("scopeExact")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let scope = match (
        args.get("lookId").and_then(Value::as_str),
        args.get("scopeRef").and_then(Value::as_str),
    ) {
        (Some(look_id), Some(scope_ref)) => {
            let record = lock(state)?.look(look_id)?;
            if record.root.accessible != root.accessible {
                return Err(ProtocolError::new(
                    "Scope ref is outside the target root",
                    ErrorCode::StaleRef,
                ));
            }
            Some(lock(state)?.element(look_id, scope_ref)?)
        }
        (None, Some(_)) => return Err(invalid("scopeRef requires lookId")),
        _ => None,
    };
    let gone = args.get("gone").and_then(Value::as_bool).unwrap_or(false);
    let timeout = args
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(10_000)
        .clamp(100, 60_000);
    let deadline = Instant::now() + Duration::from_millis(timeout);
    let client = AtspiClient::connect().await?;
    let mut node_count = 0;
    while Instant::now() < deadline {
        let nodes = match &scope {
            Some(scope) => {
                client
                    .snapshot_from(&scope.accessible, DEFAULT_MAX_NODES, 20)
                    .await?
            }
            None => client.snapshot(&root, DEFAULT_MAX_NODES, 20).await?,
        };
        node_count = nodes.len();
        let found = nodes
            .iter()
            .any(|node| matches_scoped_node(node, scope_exact, &text, &role, &value));
        if found != gone {
            return Ok(
                json!({"found":true,"gone":if gone {Some(true)} else {None::<bool>},"nodeCount":node_count}),
            );
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    Ok(json!({"found":false,"timedOut":true,"nodeCount":node_count}))
}

fn semantic_performed() -> Value {
    json!({"grounding":"description","delivery":"ax","deltaSource":"snapshot"})
}

fn matches_scoped_node(
    node: &NodeSnapshot,
    scope_exact: bool,
    text: &Option<String>,
    role: &Option<String>,
    value: &Option<String>,
) -> bool {
    (!scope_exact || node.depth == 0) && matches_node(node, text, role, value)
}

fn matches_node(
    node: &NodeSnapshot,
    text: &Option<String>,
    role: &Option<String>,
    value: &Option<String>,
) -> bool {
    text.as_ref()
        .map(|needle| node.searchable_text().contains(needle))
        .unwrap_or(true)
        && role
            .as_ref()
            .map(|expected| node.role.to_lowercase() == *expected)
            .unwrap_or(true)
        && value
            .as_ref()
            .map(|expected| node.value.trim().to_lowercase() == *expected)
            .unwrap_or(true)
}

fn required_str<'a>(value: &'a Value, key: &str, message: &str) -> Result<&'a str, ProtocolError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| invalid(message))
}

fn lock(
    state: &Arc<Mutex<HelperState>>,
) -> Result<std::sync::MutexGuard<'_, HelperState>, ProtocolError> {
    state
        .lock()
        .map_err(|_| ProtocolError::new("helper state lock poisoned", ErrorCode::InternalError))
}

fn now_seconds() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

fn invalid(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(message, ErrorCode::InvalidRequest)
}

fn capability(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(message, ErrorCode::CapabilityDeferred)
}

#[cfg(test)]
mod tests {
    use super::*;
    use linux_bridge::atspi::AccessibleRef;
    use std::collections::HashSet;

    fn node() -> NodeSnapshot {
        NodeSnapshot {
            reference: "linux:look_1:@e1".into(),
            accessible: AccessibleRef {
                destination: ":1.1".into(),
                path: "/node".into(),
            },
            parent: None,
            name: "Save document".into(),
            role: "push button".into(),
            description: "Writes changes".into(),
            value: String::new(),
            interfaces: HashSet::new(),
            bounds: None,
            is_secure: false,
            depth: 0,
        }
    }

    #[test]
    fn scoped_matching_includes_descendants_unless_exact() {
        let mut descendant = node();
        descendant.depth = 1;
        assert!(matches_scoped_node(
            &descendant,
            false,
            &Some("save".into()),
            &None,
            &None
        ));
        assert!(!matches_scoped_node(
            &descendant,
            true,
            &Some("save".into()),
            &None,
            &None
        ));
    }

    #[test]
    fn semantic_delivery_uses_shared_ax_label() {
        assert_eq!(semantic_performed()["delivery"], "ax");
        assert_eq!(semantic_performed()["grounding"], "description");
    }

    #[test]
    fn matching_is_case_insensitive_and_conjunctive() {
        let node = node();
        assert!(matches_node(
            &node,
            &Some("SAVE".to_lowercase()),
            &Some("push button".into()),
            &None
        ));
        assert!(!matches_node(
            &node,
            &Some("save".into()),
            &Some("checkbox".into()),
            &None
        ));
    }

    #[test]
    fn request_id_is_recovered_from_invalid_envelope() {
        assert_eq!(
            extract_id(r#"{"id":"abc","oops":1}"#).as_deref(),
            Some("abc")
        );
    }

    #[test]
    fn successful_portal_diagnostics_are_capabilities_only() {
        let value = portal_diagnostics(Some(Ok(PortalCapabilities {
            remote_desktop_version: 2,
            screen_cast_version: 6,
            available_device_types: 3,
            available_source_types: 3,
            available_cursor_modes: 5,
        })));
        assert_eq!(value["available"], true);
        assert_eq!(value["interactiveUseEnabled"], false);
        assert_eq!(value["readOnlyProbe"], true);
        assert_eq!(value["remoteDesktopVersion"], 2);
        assert_eq!(value["screenCastVersion"], 6);
        assert_eq!(value["availableDeviceTypes"], 3);
        assert_eq!(value["availableSourceTypes"], 3);
        assert_eq!(value["availableCursorModes"], 5);
    }

    #[test]
    fn failed_portal_probe_is_reported_without_enabling_portal_use() {
        let value = portal_diagnostics(Some(Err(PortalError::Unavailable(
            "no portal service".into(),
        ))));
        assert_eq!(value["available"], false);
        assert_eq!(value["interactiveUseEnabled"], false);
        assert_eq!(value["error"]["kind"], "portal_unavailable");
        assert!(value["error"]["message"]
            .as_str()
            .unwrap()
            .contains("no portal service"));
    }

    #[test]
    fn non_wayland_diagnostics_skip_the_portal_probe() {
        let value = portal_diagnostics(None);
        assert_eq!(value["probed"], false);
        assert_eq!(value["reason"], "not_wayland");
        assert_eq!(value["interactiveUseEnabled"], false);
    }

    #[test]
    fn scoped_no_image_keeps_downscaled_coordinate_mapping() {
        let mut root = RootSnapshot {
            accessible: AccessibleRef {
                destination: ":1.1".into(),
                path: "/window".into(),
            },
            pid: 1,
            name: "Window".into(),
            app_name: "App".into(),
            role: "frame".into(),
            frame: Some(Rect {
                x: 100,
                y: 200,
                width: 2000,
                height: 1000,
            }),
            x11_window: None,
            is_focused: false,
            is_minimized: false,
            z_order: None,
        };
        let base_size = initial_image_size(&root, Some((1000, 500)));
        let base_point = image_point_to_screen(
            root.frame.as_ref().unwrap(),
            base_size.0,
            base_size.1,
            250.0,
            125.0,
        )
        .unwrap();
        root.name = "Scoped expansion".into();
        let scoped_size = initial_image_size(&root, Some(base_size));
        let scoped_point = image_point_to_screen(
            root.frame.as_ref().unwrap(),
            scoped_size.0,
            scoped_size.1,
            250.0,
            125.0,
        )
        .unwrap();
        assert_eq!(scoped_size, (1000, 500));
        assert_eq!(scoped_point, base_point);
    }

    #[test]
    fn downscaled_image_coordinates_map_back_to_window_points() {
        let frame = Rect {
            x: 100,
            y: 200,
            width: 2000,
            height: 1000,
        };
        assert_eq!(
            image_point_to_screen(&frame, 1000, 500, 250.0, 125.0).unwrap(),
            (600, 450)
        );
        assert!(image_point_to_screen(&frame, 1000, 500, 1000.0, 0.0).is_err());
    }

    #[test]
    fn outline_rects_follow_image_scaling() {
        let mut outline = json!({"rect":{"x":100,"y":50,"w":400,"h":200},"text":[{"rect":{"x":20,"y":10,"w":40,"h":20}}]});
        scale_outline_rects(&mut outline, 0.5, 0.25);
        assert_eq!(
            outline["rect"],
            json!({"x":50.0,"y":12.5,"w":200.0,"h":50.0})
        );
        assert_eq!(
            outline["text"][0]["rect"],
            json!({"x":10.0,"y":2.5,"w":20.0,"h":5.0})
        );
    }

    #[test]
    fn batch_outcome_preserves_unknown_physical_results() {
        assert_eq!(
            batch_outcome(&[json!({"outcome":"worked"})], false),
            "worked"
        );
        assert_eq!(
            batch_outcome(
                &[json!({"outcome":"worked"}), json!({"outcome":"unknown"})],
                false
            ),
            "unknown"
        );
        assert_eq!(
            batch_outcome(&[json!({"outcome":"unknown"})], true),
            "didnt"
        );
    }
}
