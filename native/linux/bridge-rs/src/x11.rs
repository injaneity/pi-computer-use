//! X11/EWMH enrichment, capture, focus, and guarded XTEST physical input.
use crate::atspi::{Rect, RootSnapshot};
use crate::{ErrorCode, ProtocolError};
use base64::Engine as _;
use serde_json::{json, Value};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ButtonIndex, ClientMessageData, ClientMessageEvent, ConnectionExt as _,
    Drawable, EventMask, ImageFormat, ImageOrder, Keycode, MapState, Window, BUTTON_PRESS_EVENT,
    BUTTON_RELEASE_EVENT, CLIENT_MESSAGE_EVENT, KEY_PRESS_EVENT, KEY_RELEASE_EVENT,
    MOTION_NOTIFY_EVENT,
};
use x11rb::protocol::{composite, xtest};
use x11rb::rust_connection::RustConnection;

const MAX_CAPTURE_PIXELS: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionKind {
    X11,
    Wayland,
    Headless,
}
impl SessionKind {
    pub fn detect() -> Self {
        let kind = std::env::var("XDG_SESSION_TYPE")
            .unwrap_or_default()
            .to_ascii_lowercase();
        if kind == "wayland" || (kind.is_empty() && std::env::var_os("WAYLAND_DISPLAY").is_some()) {
            Self::Wayland
        } else if kind == "x11" || std::env::var_os("DISPLAY").is_some() {
            Self::X11
        } else {
            Self::Headless
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::X11 => "x11",
            Self::Wayland => "wayland",
            Self::Headless => "headless",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhysicalPolicy {
    AxOnly,
    Background,
    Default,
    Foreground,
}
impl PhysicalPolicy {
    pub fn parse(value: Option<&str>) -> Result<Self, ProtocolError> {
        match value.unwrap_or("default") {
            "ax_only" => Ok(Self::AxOnly),
            "background" => Ok(Self::Background),
            "default" => Ok(Self::Default),
            "foreground" => Ok(Self::Foreground),
            value => Err(invalid(format!("Unknown delivery policy '{value}'"))),
        }
    }
    pub fn require_physical(self, session: SessionKind) -> Result<(), ProtocolError> {
        if session == SessionKind::Headless {
            return Err(err(
                "Physical input is unavailable in a headless Linux session",
                ErrorCode::CoordinateBlocked,
            ));
        }
        if session != SessionKind::X11 {
            return Err(err(
                "XTEST is unavailable in native Wayland sessions; use AT-SPI",
                ErrorCode::CapabilityDeferred,
            ));
        }
        match self {
            Self::AxOnly => Err(err(
                "ax_only policy forbids XTEST and window focus",
                ErrorCode::CoordinateBlocked,
            )),
            Self::Background => Err(err(
                "Background policy forbids global XTEST input",
                ErrorCode::ForegroundRequired,
            )),
            Self::Default | Self::Foreground => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowInfo {
    pub id: u32,
    pub pid: u64,
    pub title: String,
    pub frame: Rect,
    pub focused: bool,
    pub minimized: bool,
    pub z_order: usize,
}
pub struct Capture {
    pub png_base64: String,
    pub width: u16,
    pub height: u16,
    pub source: &'static str,
    pub warnings: Vec<String>,
}
pub fn available() -> bool {
    SessionKind::detect() == SessionKind::X11 && connect().is_ok()
}

pub fn list_windows() -> Result<Vec<WindowInfo>, ProtocolError> {
    let (conn, screen) = connect()?;
    let root = conn.setup().roots[screen].root;
    let a = Atoms::new(&conn)?;
    let active = property32(&conn, root, a.active, AtomEnum::WINDOW.into())
        .first()
        .copied();
    let mut windows = property32(&conn, root, a.stacking, AtomEnum::WINDOW.into());
    if windows.is_empty() {
        windows = property32(&conn, root, a.clients, AtomEnum::WINDOW.into());
    }
    let mut out = Vec::new();
    for (z_order, id) in windows.into_iter().rev().enumerate() {
        let Ok(g) = conn
            .get_geometry(id)
            .ok()
            .and_then(|c| c.reply().ok())
            .ok_or(())
        else {
            continue;
        };
        let translated = conn
            .translate_coordinates(id, root, 0, 0)
            .ok()
            .and_then(|c| c.reply().ok());
        let states = property32(&conn, id, a.state, AtomEnum::ATOM.into());
        out.push(WindowInfo {
            id,
            pid: property32(&conn, id, a.pid, AtomEnum::CARDINAL.into())
                .first()
                .copied()
                .unwrap_or(0) as u64,
            title: title(&conn, id, &a),
            frame: Rect {
                x: translated
                    .as_ref()
                    .map(|r| i32::from(r.dst_x))
                    .unwrap_or(i32::from(g.x)),
                y: translated
                    .as_ref()
                    .map(|r| i32::from(r.dst_y))
                    .unwrap_or(i32::from(g.y)),
                width: i32::from(g.width),
                height: i32::from(g.height),
            },
            focused: active == Some(id),
            minimized: states.contains(&a.hidden),
            z_order,
        });
    }
    Ok(out)
}

pub fn enrich_roots(roots: &mut [RootSnapshot], windows: &[WindowInfo]) {
    let mut used = Vec::new();
    for root in roots {
        let best = windows
            .iter()
            .filter(|w| w.pid != 0 && w.pid == root.pid && !used.contains(&w.id))
            .min_by_key(|w| {
                let title = if !root.name.is_empty()
                    && (w.title.contains(&root.name) || root.name.contains(&w.title))
                {
                    0
                } else {
                    1_000_000
                };
                title + distance(root.frame.as_ref(), &w.frame)
            });
        if let Some(w) = best {
            used.push(w.id);
            root.x11_window = Some(w.id);
            root.frame = Some(w.frame.clone());
            root.is_focused = w.focused;
            root.is_minimized = w.minimized;
            root.z_order = Some(w.z_order);
            if root.name.is_empty() {
                root.name.clone_from(&w.title);
            }
        }
    }
}
fn distance(a: Option<&Rect>, b: &Rect) -> i64 {
    a.map(|a| {
        i64::from(
            (a.x - b.x).abs()
                + (a.y - b.y).abs()
                + (a.width - b.width).abs()
                + (a.height - b.height).abs(),
        )
    })
    .unwrap_or(0)
}

pub fn focus_window(window: Window, policy: PhysicalPolicy) -> Result<Value, ProtocolError> {
    policy.require_physical(SessionKind::detect())?;
    let (conn, screen) = connect()?;
    let root = conn.setup().roots[screen].root;
    let atom = intern(&conn, "_NET_ACTIVE_WINDOW")?;
    let event = ClientMessageEvent {
        response_type: CLIENT_MESSAGE_EVENT,
        format: 32,
        sequence: 0,
        window,
        type_: atom,
        data: ClientMessageData::from([2, 0, 0, 0, 0]),
    };
    conn.send_event(
        false,
        root,
        EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
        event,
    )
    .map_err(xerr)?
    .check()
    .map_err(xerr)?;
    conn.flush().map_err(xerr)?;
    Ok(json!({"focused":true,"delivery":"ewmh","windowId":window}))
}

pub fn capture_window(
    window: Window,
    max_dimension: Option<u32>,
) -> Result<Capture, ProtocolError> {
    let (conn, _) = connect()?;
    let g = conn
        .get_geometry(window)
        .map_err(xerr)?
        .reply()
        .map_err(xerr)?;
    let pixels = u64::from(g.width) * u64::from(g.height);
    if pixels == 0 || pixels > MAX_CAPTURE_PIXELS {
        return Err(err(
            format!(
                "Refusing X11 capture of {}x{} window (64MP limit)",
                g.width, g.height
            ),
            ErrorCode::CaptureFailed,
        ));
    }
    let pixmap = conn.generate_id().map_err(xerr)?;
    let mut warnings = Vec::new();
    let (drawable, source) = match composite::name_window_pixmap(&conn, window, pixmap)
        .ok()
        .and_then(|c| c.check().ok())
        .ok_or(())
    {
        Ok(()) => (pixmap as Drawable, "xcomposite"),
        Err(_) => {
            warnings.push(
                "XComposite unavailable; GetImage fallback may contain stale or obscured pixels"
                    .into(),
            );
            (window as Drawable, "get_image")
        }
    };
    let image = conn
        .get_image(
            ImageFormat::Z_PIXMAP,
            drawable,
            0,
            0,
            g.width,
            g.height,
            u32::MAX,
        )
        .map_err(xerr)?
        .reply()
        .map_err(|e| {
            err(
                format!("X11 GetImage failed: {e}"),
                ErrorCode::CaptureFailed,
            )
        })?;
    if source == "xcomposite" {
        let _ = conn.free_pixmap(pixmap);
    }
    let rgba = decode(
        &image.data,
        g.width,
        g.height,
        image.depth,
        conn.setup().image_byte_order,
    )?;
    let (output_width, output_height) = scaled_dimensions(g.width, g.height, max_dimension);
    let rgba = resize_rgba(&rgba, g.width, g.height, output_width, output_height);
    let mut encoded = Vec::new();
    {
        let mut encoder =
            png::Encoder::new(&mut encoded, output_width.into(), output_height.into());
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(capture_err)?;
        writer.write_image_data(&rgba).map_err(capture_err)?;
    }
    Ok(Capture {
        png_base64: base64::engine::general_purpose::STANDARD.encode(encoded),
        width: output_width,
        height: output_height,
        source,
        warnings,
    })
}
fn scaled_dimensions(width: u16, height: u16, max_dimension: Option<u32>) -> (u16, u16) {
    let largest = u32::from(width.max(height));
    let Some(limit) = max_dimension.filter(|limit| *limit > 0 && *limit < largest) else {
        return (width, height);
    };
    let scale = f64::from(limit) / f64::from(largest);
    (
        (f64::from(width) * scale).round().max(1.0) as u16,
        (f64::from(height) * scale).round().max(1.0) as u16,
    )
}

fn resize_rgba(
    source: &[u8],
    source_width: u16,
    source_height: u16,
    width: u16,
    height: u16,
) -> Vec<u8> {
    if (source_width, source_height) == (width, height) {
        return source.to_vec();
    }
    let mut output = vec![0; usize::from(width) * usize::from(height) * 4];
    for y in 0..height {
        let source_y = (u32::from(y) * u32::from(source_height) / u32::from(height)) as usize;
        for x in 0..width {
            let source_x = (u32::from(x) * u32::from(source_width) / u32::from(width)) as usize;
            let from = (source_y * usize::from(source_width) + source_x) * 4;
            let to = (usize::from(y) * usize::from(width) + usize::from(x)) * 4;
            output[to..to + 4].copy_from_slice(&source[from..from + 4]);
        }
    }
    output
}

fn decode(
    data: &[u8],
    w: u16,
    h: u16,
    depth: u8,
    order: ImageOrder,
) -> Result<Vec<u8>, ProtocolError> {
    let expected = usize::from(w) * usize::from(h) * 4;
    if !matches!(depth, 24 | 32) || data.len() < expected {
        return Err(err(
            format!(
                "Unsupported X11 image layout: depth {depth}, {} bytes",
                data.len()
            ),
            ErrorCode::CaptureFailed,
        ));
    }
    let mut out = Vec::with_capacity(expected);
    for p in data[..expected].chunks_exact(4) {
        let (r, g, b) = if order == ImageOrder::LSB_FIRST {
            (p[2], p[1], p[0])
        } else {
            (p[1], p[2], p[3])
        };
        out.extend_from_slice(&[r, g, b, 255]);
    }
    Ok(out)
}

pub struct Input {
    conn: RustConnection,
    root: Window,
    target: Window,
}
impl Input {
    pub fn connect(policy: PhysicalPolicy, target: Window) -> Result<Self, ProtocolError> {
        policy.require_physical(SessionKind::detect())?;
        let (conn, screen) = connect()?;
        let root = conn.setup().roots[screen].root;
        validate_target(&conn, root, target)?;
        prepare_focus(&conn, root, target, policy)?;
        xtest::get_version(&conn, 2, 2)
            .map_err(xerr)?
            .reply()
            .map_err(|e| {
                err(
                    format!("XTEST unavailable: {e}"),
                    ErrorCode::CapabilityDeferred,
                )
            })?;
        Ok(Self { conn, root, target })
    }
    pub fn move_pointer(&self, x: i32, y: i32) -> Result<(), ProtocolError> {
        self.preflight_point(x, y)?;
        self.fake(MOTION_NOTIFY_EVENT, 0, x, y)
    }
    pub fn click(&self, x: i32, y: i32, button: &str, count: u64) -> Result<(), ProtocolError> {
        let b = button_detail(button)?;
        self.preflight_point(x, y)?;
        self.fake(MOTION_NOTIFY_EVENT, 0, x, y)?;
        for _ in 0..count.clamp(1, 3) {
            self.fake(BUTTON_PRESS_EVENT, b, 0, 0)?;
            self.fake(BUTTON_RELEASE_EVENT, b, 0, 0)?;
        }
        Ok(())
    }
    pub fn scroll(&self, x: i32, y: i32, dx: f64, dy: f64) -> Result<(), ProtocolError> {
        self.preflight_point(x, y)?;
        self.fake(MOTION_NOTIFY_EVENT, 0, x, y)?;
        for _ in 0..dy.abs().ceil().clamp(0., 100.) as usize {
            self.button(if dy < 0. { 4 } else { 5 })?;
        }
        for _ in 0..dx.abs().ceil().clamp(0., 100.) as usize {
            self.button(if dx < 0. { 6 } else { 7 })?;
        }
        Ok(())
    }
    pub fn drag(&self, path: &[(i32, i32)], button: &str) -> Result<(), ProtocolError> {
        if path.len() < 2 {
            return Err(invalid("drag requires at least two points"));
        }
        let b = button_detail(button)?;
        for &(x, y) in path {
            self.preflight_point(x, y)?;
        }
        self.fake(MOTION_NOTIFY_EVENT, 0, path[0].0, path[0].1)?;
        self.fake(BUTTON_PRESS_EVENT, b, 0, 0)?;
        for &(x, y) in &path[1..] {
            self.fake(MOTION_NOTIFY_EVENT, 0, x, y)?;
        }
        self.fake(BUTTON_RELEASE_EVENT, b, 0, 0)
    }
    pub fn type_text(&self, text: &str) -> Result<(), ProtocolError> {
        for ch in text.chars() {
            let (sym, shift) = char_keysym(ch)
                .ok_or_else(|| invalid(format!("Unsupported XTEST character {ch:?}")))?;
            if shift {
                self.key(0xffe1, KEY_PRESS_EVENT)?;
            }
            self.key(sym, KEY_PRESS_EVENT)?;
            self.key(sym, KEY_RELEASE_EVENT)?;
            if shift {
                self.key(0xffe1, KEY_RELEASE_EVENT)?;
            }
        }
        Ok(())
    }
    pub fn keypress(&self, names: &[&str]) -> Result<(), ProtocolError> {
        if names.is_empty() {
            return Err(invalid("keypress requires keys"));
        }
        let syms = names
            .iter()
            .map(|n| named_keysym(n).ok_or_else(|| invalid(format!("Unsupported key '{n}'"))))
            .collect::<Result<Vec<_>, _>>()?;
        for &s in &syms {
            self.key(s, KEY_PRESS_EVENT)?;
        }
        for &s in syms.iter().rev() {
            self.key(s, KEY_RELEASE_EVENT)?;
        }
        Ok(())
    }
    fn preflight_point(&self, x: i32, y: i32) -> Result<(), ProtocolError> {
        validate_target(&self.conn, self.root, self.target)?;
        if active_window(&self.conn, self.root)? != Some(self.target) {
            return Err(err(
                "Refusing XTEST delivery because the owning window is no longer active",
                ErrorCode::ForegroundRequired,
            ));
        }
        let hit = self
            .conn
            .translate_coordinates(self.root, self.root, clamp_i16(x), clamp_i16(y))
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?
            .child;
        if hit == 0 || !windows_related(&self.conn, hit, self.target)? {
            return Err(err(
                "Refusing XTEST pointer delivery because the target point is outside or occluded",
                ErrorCode::CoordinateBlocked,
            ));
        }
        Ok(())
    }
    fn key(&self, sym: u32, event: u8) -> Result<(), ProtocolError> {
        let code = self
            .keycode(sym)?
            .ok_or_else(|| invalid(format!("No keycode for keysym 0x{sym:x}")))?;
        self.fake(event, code, 0, 0)
    }
    fn keycode(&self, sym: u32) -> Result<Option<Keycode>, ProtocolError> {
        let setup = self.conn.setup();
        let min = setup.min_keycode;
        let count = setup.max_keycode - min + 1;
        let m = self
            .conn
            .get_keyboard_mapping(min, count)
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?;
        Ok(m.keysyms
            .chunks(usize::from(m.keysyms_per_keycode))
            .position(|s| s.contains(&sym))
            .map(|i| min + i as u8))
    }
    fn button(&self, b: u8) -> Result<(), ProtocolError> {
        self.fake(BUTTON_PRESS_EVENT, b, 0, 0)?;
        self.fake(BUTTON_RELEASE_EVENT, b, 0, 0)
    }
    fn fake(&self, event: u8, detail: u8, x: i32, y: i32) -> Result<(), ProtocolError> {
        validate_target(&self.conn, self.root, self.target)?;
        if active_window(&self.conn, self.root)? != Some(self.target) {
            return Err(err(
                "Refusing XTEST delivery because the owning window is no longer active",
                ErrorCode::ForegroundRequired,
            ));
        }
        xtest::fake_input(
            &self.conn,
            event,
            detail,
            0,
            self.root,
            clamp_i16(x),
            clamp_i16(y),
            0,
        )
        .map_err(xerr)?
        .check()
        .map_err(xerr)?;
        self.conn.flush().map_err(xerr)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FocusPlan {
    Confirm,
    ActivateAndConfirm,
}

fn focus_plan(policy: PhysicalPolicy, active: bool) -> Result<FocusPlan, ProtocolError> {
    match policy {
        PhysicalPolicy::Foreground => Ok(FocusPlan::ActivateAndConfirm),
        PhysicalPolicy::Default if active => Ok(FocusPlan::Confirm),
        PhysicalPolicy::Default => Err(err(
            "Default policy requires the owning X11 window to already be active",
            ErrorCode::ForegroundRequired,
        )),
        PhysicalPolicy::AxOnly | PhysicalPolicy::Background => {
            policy.require_physical(SessionKind::X11)?;
            unreachable!()
        }
    }
}
fn prepare_focus(
    c: &RustConnection,
    root: Window,
    target: Window,
    policy: PhysicalPolicy,
) -> Result<(), ProtocolError> {
    let plan = focus_plan(policy, active_window(c, root)? == Some(target))?;
    if plan == FocusPlan::ActivateAndConfirm {
        request_active_window(c, root, target)?;
    }
    for _ in 0..20 {
        if active_window(c, root)? == Some(target) {
            return Ok(());
        }
        if plan == FocusPlan::Confirm {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    Err(err(
        "Window manager did not activate the owning X11 window; refusing XTEST delivery",
        ErrorCode::ForegroundRequired,
    ))
}
fn validate_target(c: &RustConnection, root: Window, target: Window) -> Result<(), ProtocolError> {
    if target == 0 || target == root {
        return Err(err(
            "XTEST requires a specific owning X11 window",
            ErrorCode::CoordinateBlocked,
        ));
    }
    let attributes = c
        .get_window_attributes(target)
        .map_err(xerr)?
        .reply()
        .map_err(|_| {
            err(
                "Owning X11 window no longer exists",
                ErrorCode::TargetNotFound,
            )
        })?;
    let geometry = c.get_geometry(target).map_err(xerr)?.reply().map_err(|_| {
        err(
            "Owning X11 window has no usable geometry",
            ErrorCode::CoordinateBlocked,
        )
    })?;
    let atoms = Atoms::new(c)?;
    if attributes.map_state != MapState::VIEWABLE
        || geometry.width == 0
        || geometry.height == 0
        || property32(c, target, atoms.state, AtomEnum::ATOM.into()).contains(&atoms.hidden)
    {
        return Err(err(
            "Owning X11 window is not mapped and visible",
            ErrorCode::CoordinateBlocked,
        ));
    }
    Ok(())
}
fn active_window(c: &RustConnection, root: Window) -> Result<Option<Window>, ProtocolError> {
    let atom = intern(c, "_NET_ACTIVE_WINDOW")?;
    Ok(property32(c, root, atom, AtomEnum::WINDOW.into())
        .first()
        .copied())
}
fn request_active_window(
    c: &RustConnection,
    root: Window,
    target: Window,
) -> Result<(), ProtocolError> {
    let atom = intern(c, "_NET_ACTIVE_WINDOW")?;
    let event = ClientMessageEvent {
        response_type: CLIENT_MESSAGE_EVENT,
        format: 32,
        sequence: 0,
        window: target,
        type_: atom,
        data: ClientMessageData::from([2, 0, 0, 0, 0]),
    };
    c.send_event(
        false,
        root,
        EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
        event,
    )
    .map_err(xerr)?
    .check()
    .map_err(xerr)?;
    c.flush().map_err(xerr)
}
fn windows_related(c: &RustConnection, hit: Window, target: Window) -> Result<bool, ProtocolError> {
    fn ancestors(c: &RustConnection, mut w: Window) -> Result<Vec<Window>, ProtocolError> {
        let mut out = vec![w];
        for _ in 0..64 {
            let tree = c.query_tree(w).map_err(xerr)?.reply().map_err(xerr)?;
            if tree.parent == 0 || tree.parent == w {
                break;
            }
            w = tree.parent;
            out.push(w);
        }
        Ok(out)
    }
    Ok(ancestors(c, hit)?.contains(&target) || ancestors(c, target)?.contains(&hit))
}
fn clamp_i16(value: i32) -> i16 {
    value.clamp(i16::MIN.into(), i16::MAX.into()) as i16
}

fn button_detail(b: &str) -> Result<u8, ProtocolError> {
    match b {
        "left" => Ok(ButtonIndex::M1.into()),
        "middle" => Ok(ButtonIndex::M2.into()),
        "right" => Ok(ButtonIndex::M3.into()),
        _ => Err(invalid(format!("Unsupported mouse button '{b}'"))),
    }
}
fn char_keysym(c: char) -> Option<(u32, bool)> {
    if c == '\n' {
        return Some((0xff0d, false));
    }
    if c == '\t' {
        return Some((0xff09, false));
    }
    if c == ' ' || c.is_ascii_lowercase() || c.is_ascii_digit() {
        return Some((c as u32, false));
    }
    if c.is_ascii_uppercase() {
        return Some((c.to_ascii_lowercase() as u32, true));
    }
    let shifted = "~!@#$%^&*()_+{}|:\"<>?";
    let base = "`1234567890-=[]\\;',./";
    shifted
        .chars()
        .position(|v| v == c)
        .and_then(|i| base.chars().nth(i))
        .map(|v| (v as u32, true))
}
fn named_keysym(n: &str) -> Option<u32> {
    match n.to_ascii_lowercase().as_str() {
        "enter" | "return" => Some(0xff0d),
        "tab" => Some(0xff09),
        "escape" | "esc" => Some(0xff1b),
        "backspace" => Some(0xff08),
        "delete" => Some(0xffff),
        "space" => Some(0x20),
        "left" => Some(0xff51),
        "up" => Some(0xff52),
        "right" => Some(0xff53),
        "down" => Some(0xff54),
        "home" => Some(0xff50),
        "end" => Some(0xff57),
        "pageup" => Some(0xff55),
        "pagedown" => Some(0xff56),
        "ctrl" | "control" => Some(0xffe3),
        "shift" => Some(0xffe1),
        "alt" | "option" => Some(0xffe9),
        "meta" | "super" | "cmd" | "command" => Some(0xffeb),
        v if v.len() == 1 => v.chars().next().map(|c| c as u32),
        v if v.starts_with('f') => v[1..]
            .parse::<u32>()
            .ok()
            .filter(|n| (1..=35).contains(n))
            .map(|n| 0xffbd + n),
        _ => None,
    }
}

struct Atoms {
    clients: Atom,
    stacking: Atom,
    active: Atom,
    pid: Atom,
    name: Atom,
    state: Atom,
    hidden: Atom,
    utf8: Atom,
}
impl Atoms {
    fn new(c: &RustConnection) -> Result<Self, ProtocolError> {
        Ok(Self {
            clients: intern(c, "_NET_CLIENT_LIST")?,
            stacking: intern(c, "_NET_CLIENT_LIST_STACKING")?,
            active: intern(c, "_NET_ACTIVE_WINDOW")?,
            pid: intern(c, "_NET_WM_PID")?,
            name: intern(c, "_NET_WM_NAME")?,
            state: intern(c, "_NET_WM_STATE")?,
            hidden: intern(c, "_NET_WM_STATE_HIDDEN")?,
            utf8: intern(c, "UTF8_STRING")?,
        })
    }
}
fn connect() -> Result<(RustConnection, usize), ProtocolError> {
    x11rb::connect(None).map_err(|e| {
        err(
            format!("X11 unavailable: {e}"),
            ErrorCode::CapabilityDeferred,
        )
    })
}
fn intern(c: &RustConnection, n: &str) -> Result<Atom, ProtocolError> {
    c.intern_atom(false, n.as_bytes())
        .map_err(xerr)?
        .reply()
        .map(|r| r.atom)
        .map_err(xerr)
}
fn property32(c: &RustConnection, w: Window, p: Atom, t: Atom) -> Vec<u32> {
    c.get_property(false, w, p, t, 0, u32::MAX)
        .ok()
        .and_then(|v| v.reply().ok())
        .and_then(|v| v.value32().map(Iterator::collect))
        .unwrap_or_default()
}
fn title(c: &RustConnection, w: Window, a: &Atoms) -> String {
    let utf = c
        .get_property(false, w, a.name, a.utf8, 0, 4096)
        .ok()
        .and_then(|v| v.reply().ok())
        .and_then(|v| String::from_utf8(v.value).ok())
        .unwrap_or_default();
    if !utf.is_empty() {
        return utf;
    }
    c.get_property(false, w, AtomEnum::WM_NAME, AtomEnum::STRING, 0, 4096)
        .ok()
        .and_then(|v| v.reply().ok())
        .map(|v| String::from_utf8_lossy(&v.value).into_owned())
        .unwrap_or_default()
}
fn err(m: impl Into<String>, code: ErrorCode) -> ProtocolError {
    ProtocolError::new(m, code)
}
fn invalid(m: impl Into<String>) -> ProtocolError {
    err(m, ErrorCode::InvalidRequest)
}
fn xerr(e: impl std::fmt::Display) -> ProtocolError {
    err(format!("X11 request failed: {e}"), ErrorCode::InternalError)
}
fn capture_err(e: impl std::fmt::Display) -> ProtocolError {
    err(
        format!("PNG encoding failed: {e}"),
        ErrorCode::CaptureFailed,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_guards() {
        assert_eq!(
            PhysicalPolicy::AxOnly
                .require_physical(SessionKind::X11)
                .unwrap_err()
                .code,
            ErrorCode::CoordinateBlocked
        );
        assert_eq!(
            PhysicalPolicy::Background
                .require_physical(SessionKind::X11)
                .unwrap_err()
                .code,
            ErrorCode::ForegroundRequired
        );
        assert!(PhysicalPolicy::Foreground
            .require_physical(SessionKind::X11)
            .is_ok());
        assert!(PhysicalPolicy::Default
            .require_physical(SessionKind::Headless)
            .is_err());
    }
    #[test]
    fn focus_policy_is_deterministic() {
        assert_eq!(
            focus_plan(PhysicalPolicy::Foreground, false).unwrap(),
            FocusPlan::ActivateAndConfirm
        );
        assert_eq!(
            focus_plan(PhysicalPolicy::Foreground, true).unwrap(),
            FocusPlan::ActivateAndConfirm
        );
        assert_eq!(
            focus_plan(PhysicalPolicy::Default, true).unwrap(),
            FocusPlan::Confirm
        );
        assert_eq!(
            focus_plan(PhysicalPolicy::Default, false).unwrap_err().code,
            ErrorCode::ForegroundRequired
        );
        assert_eq!(
            focus_plan(PhysicalPolicy::Background, true)
                .unwrap_err()
                .code,
            ErrorCode::ForegroundRequired
        );
    }
    #[test]
    fn coordinate_clamping_is_deterministic() {
        assert_eq!(clamp_i16(i32::MIN), i16::MIN);
        assert_eq!(clamp_i16(i32::MAX), i16::MAX);
        assert_eq!(clamp_i16(42), 42);
    }
    #[test]
    fn geometry_is_deterministic() {
        let a = Rect {
            x: 1,
            y: 2,
            width: 3,
            height: 4,
        };
        assert_eq!(distance(Some(&a), &a), 0);
        assert_eq!(distance(Some(&a), &Rect { x: 6, ..a.clone() }), 5);
    }
    #[test]
    fn key_protocol() {
        assert_eq!(named_keysym("Control"), Some(0xffe3));
        assert_eq!(named_keysym("F12"), Some(0xffc9));
        assert_eq!(char_keysym('A'), Some(('a' as u32, true)));
        assert_eq!(char_keysym('!'), Some(('1' as u32, true)));
        assert_eq!(char_keysym('é'), None);
    }
    #[test]
    fn bounded_capture_dimensions_preserve_aspect_ratio() {
        assert_eq!(scaled_dimensions(1920, 1080, Some(1000)), (1000, 563));
        assert_eq!(scaled_dimensions(800, 600, Some(1000)), (800, 600));
        assert_eq!(scaled_dimensions(1, 4000, Some(100)), (1, 100));
        assert_eq!(scaled_dimensions(4000, 1, Some(100)), (100, 1));
    }
    #[test]
    fn rgba_resize_is_bounded_and_deterministic() {
        let source = vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        assert_eq!(resize_rgba(&source, 2, 2, 1, 1), vec![1, 2, 3, 4]);
        assert_eq!(resize_rgba(&source, 2, 2, 2, 2), source);
    }
    #[test]
    fn decode_limits() {
        assert_eq!(
            decode(&[1, 2, 3, 0], 1, 1, 24, ImageOrder::LSB_FIRST).unwrap(),
            vec![3, 2, 1, 255]
        );
        assert!(decode(&[0; 2], 1, 1, 16, ImageOrder::LSB_FIRST).is_err());
    }
}
