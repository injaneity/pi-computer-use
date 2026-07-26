//! Wayland screen capture and input through the XDG desktop portals.
//!
//! Capability discovery is deliberately separate from session creation:
//! [`PortalClient::probe`] only reads D-Bus properties and can therefore be
//! called by diagnostics without displaying a chooser. Session creation is
//! guarded by [`InteractionAuthorization`] and [`HeadlessPolicy`].

use std::collections::HashMap;
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};

use zbus::export::futures_util::StreamExt;
use zbus::proxy::SignalStream;
use zbus::zvariant::{OwnedFd, OwnedObjectPath, OwnedValue, Value};
use zbus::{Connection, Proxy};

const DESTINATION: &str = "org.freedesktop.portal.Desktop";
const DESKTOP_PATH: &str = "/org/freedesktop/portal/desktop";
const REMOTE_DESKTOP: &str = "org.freedesktop.portal.RemoteDesktop";
const SCREEN_CAST: &str = "org.freedesktop.portal.ScreenCast";
const REQUEST: &str = "org.freedesktop.portal.Request";
const SESSION: &str = "org.freedesktop.portal.Session";

pub const DEVICE_KEYBOARD: u32 = 1;
pub const DEVICE_POINTER: u32 = 2;
pub const DEVICE_TOUCHSCREEN: u32 = 4;
pub const SOURCE_MONITOR: u32 = 1;
pub const SOURCE_WINDOW: u32 = 2;
pub const SOURCE_VIRTUAL: u32 = 4;
pub const CURSOR_HIDDEN: u32 = 1;
pub const CURSOR_EMBEDDED: u32 = 2;
pub const CURSOR_METADATA: u32 = 4;
pub const PERSIST_UNTIL_REVOKED: u32 = 2;

#[derive(Debug)]
pub enum PortalError {
    Unavailable(String),
    Unsupported(&'static str),
    InteractionDenied(&'static str),
    InvalidState {
        expected: &'static str,
        actual: SessionPhase,
    },
    Cancelled,
    RequestFailed(u32),
    InvalidResponse(String),
}

impl fmt::Display for PortalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable(message) => write!(f, "desktop portal unavailable: {message}"),
            Self::Unsupported(feature) => write!(f, "desktop portal does not support {feature}"),
            Self::InteractionDenied(reason) => f.write_str(reason),
            Self::InvalidState { expected, actual } => {
                write!(f, "portal session must be {expected}, but is {actual:?}")
            }
            Self::Cancelled => f.write_str("desktop portal request was cancelled"),
            Self::RequestFailed(code) => write!(f, "desktop portal request failed ({code})"),
            Self::InvalidResponse(message) => write!(f, "invalid portal response: {message}"),
        }
    }
}

impl std::error::Error for PortalError {}

fn dbus_error(error: impl fmt::Display) -> PortalError {
    PortalError::Unavailable(error.to_string())
}

/// Properties whose reads cannot create a session or display portal UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortalCapabilities {
    pub remote_desktop_version: u32,
    pub screen_cast_version: u32,
    pub available_device_types: u32,
    pub available_source_types: u32,
    pub available_cursor_modes: u32,
}

impl PortalCapabilities {
    pub fn supports_devices(self, requested: u32) -> bool {
        requested != 0 && requested & !self.available_device_types == 0
    }

    pub fn supports_sources(self, requested: u32) -> bool {
        requested != 0 && requested & !self.available_source_types == 0
    }

    pub fn supports_persistence(self) -> bool {
        self.remote_desktop_version >= 2
    }
}

/// Strict headless operation never invokes a method which may display UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadlessPolicy {
    InteractiveDesktop,
    StrictHeadless,
}

/// Only an explicit user operation may create or start a portal session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InteractionAuthorization {
    ExplicitUserAction,
    Diagnostic,
}

fn authorize_interaction(
    headless: HeadlessPolicy,
    authorization: InteractionAuthorization,
) -> Result<(), PortalError> {
    if headless == HeadlessPolicy::StrictHeadless {
        return Err(PortalError::InteractionDenied(
            "strict-headless mode forbids interactive desktop portal requests",
        ));
    }
    if authorization != InteractionAuthorization::ExplicitUserAction {
        return Err(PortalError::InteractionDenied(
            "diagnostics are read-only and may not create or start portal sessions",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionPhase {
    New,
    Creating,
    Created,
    SelectingDevices,
    DevicesSelected,
    SelectingSources,
    ReadyToStart,
    Starting,
    Active,
    Closed,
}

/// Pure, testable state machine for the one-shot portal method ordering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortalSessionState {
    phase: SessionPhase,
    sources_requested: bool,
}

impl PortalSessionState {
    pub fn new(sources_requested: bool) -> Self {
        Self {
            phase: SessionPhase::New,
            sources_requested,
        }
    }

    pub fn phase(&self) -> SessionPhase {
        self.phase
    }

    fn transition(
        &mut self,
        expected: SessionPhase,
        next: SessionPhase,
        expected_name: &'static str,
    ) -> Result<(), PortalError> {
        if self.phase != expected {
            return Err(PortalError::InvalidState {
                expected: expected_name,
                actual: self.phase,
            });
        }
        self.phase = next;
        Ok(())
    }

    pub fn begin_create(&mut self) -> Result<(), PortalError> {
        self.transition(SessionPhase::New, SessionPhase::Creating, "new")
    }

    pub fn created(&mut self) -> Result<(), PortalError> {
        self.transition(SessionPhase::Creating, SessionPhase::Created, "creating")
    }

    pub fn begin_select_devices(&mut self) -> Result<(), PortalError> {
        self.transition(
            SessionPhase::Created,
            SessionPhase::SelectingDevices,
            "created",
        )
    }

    pub fn devices_selected(&mut self) -> Result<(), PortalError> {
        self.transition(
            SessionPhase::SelectingDevices,
            SessionPhase::DevicesSelected,
            "selecting devices",
        )?;
        if !self.sources_requested {
            self.phase = SessionPhase::ReadyToStart;
        }
        Ok(())
    }

    pub fn begin_select_sources(&mut self) -> Result<(), PortalError> {
        self.transition(
            SessionPhase::DevicesSelected,
            SessionPhase::SelectingSources,
            "devices selected",
        )
    }

    pub fn sources_selected(&mut self) -> Result<(), PortalError> {
        self.transition(
            SessionPhase::SelectingSources,
            SessionPhase::ReadyToStart,
            "selecting sources",
        )
    }

    pub fn begin_start(&mut self) -> Result<(), PortalError> {
        self.transition(
            SessionPhase::ReadyToStart,
            SessionPhase::Starting,
            "ready to start",
        )
    }

    pub fn started(&mut self) -> Result<(), PortalError> {
        self.transition(SessionPhase::Starting, SessionPhase::Active, "starting")
    }

    pub fn close(&mut self) {
        self.phase = SessionPhase::Closed;
    }
}

/// Storage boundary for a portal's rotating, single-use restore token.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RestoreToken {
    current: Option<String>,
}

impl RestoreToken {
    pub fn new(token: impl Into<String>) -> Self {
        Self {
            current: Some(token.into()),
        }
    }

    pub fn current(&self) -> Option<&str> {
        self.current.as_deref()
    }

    /// Consumes the previous token before SelectDevices. It must never be
    /// retried: the portal invalidates a restore token after one use.
    pub fn take_for_attempt(&mut self) -> Option<String> {
        self.current.take()
    }

    /// Stores the replacement returned by Start, if persistence was granted.
    pub fn rotate(&mut self, replacement: Option<String>) {
        self.current = replacement;
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LogicalPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LogicalRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl LogicalRect {
    pub fn compositor_to_stream(self, point: LogicalPoint) -> Option<LogicalPoint> {
        let x = point.x - f64::from(self.x);
        let y = point.y - f64::from(self.y);
        (self.width > 0
            && self.height > 0
            && x >= 0.0
            && y >= 0.0
            && x < f64::from(self.width)
            && y < f64::from(self.height))
        .then_some(LogicalPoint { x, y })
    }

    pub fn normalized_to_stream(self, x: f64, y: f64) -> Option<LogicalPoint> {
        (self.width > 0 && self.height > 0 && (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y))
            .then_some(LogicalPoint {
                x: x * f64::from(self.width),
                y: y * f64::from(self.height),
            })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipeWireStream {
    /// Compatibility node id; use `pipewire_serial` to connect when available.
    pub node_id: u32,
    pub id: Option<String>,
    pub position: Option<(i32, i32)>,
    pub logical_size: Option<(i32, i32)>,
    pub source_type: Option<u32>,
    pub mapping_id: Option<String>,
    pub pipewire_serial: Option<u64>,
}

impl PipeWireStream {
    pub fn logical_rect(&self) -> Option<LogicalRect> {
        let (x, y) = self.position?;
        let (width, height) = self.logical_size?;
        Some(LogicalRect {
            x,
            y,
            width,
            height,
        })
    }
}

/// Opaque PipeWire handoff. Frame negotiation/decoding belongs in a dedicated
/// PipeWire consumer; this module does not pretend the node id is image data.
#[derive(Debug)]
pub struct PipeWireHandoff {
    pub remote_fd: OwnedFd,
    pub streams: Vec<PipeWireStream>,
}

#[derive(Debug, Clone)]
pub struct RemoteDesktopOptions {
    pub device_types: u32,
    pub source_types: Option<u32>,
    pub cursor_mode: u32,
    pub multiple_sources: bool,
    pub parent_window: String,
}

impl Default for RemoteDesktopOptions {
    fn default() -> Self {
        Self {
            device_types: DEVICE_KEYBOARD | DEVICE_POINTER,
            source_types: Some(SOURCE_MONITOR | SOURCE_WINDOW),
            cursor_mode: CURSOR_METADATA,
            multiple_sources: false,
            parent_window: String::new(),
        }
    }
}

#[derive(Debug)]
pub struct ActivePortalSession {
    connection: Connection,
    pub handle: OwnedObjectPath,
    pub selected_devices: u32,
    pub streams: Vec<PipeWireStream>,
    pub state: PortalSessionState,
}

impl ActivePortalSession {
    fn ensure_active(&self) -> Result<(), PortalError> {
        if self.state.phase() == SessionPhase::Active {
            Ok(())
        } else {
            Err(PortalError::InvalidState {
                expected: "active",
                actual: self.state.phase(),
            })
        }
    }

    async fn remote_proxy(&self) -> Result<Proxy<'_>, PortalError> {
        Proxy::new(&self.connection, DESTINATION, DESKTOP_PATH, REMOTE_DESKTOP)
            .await
            .map_err(dbus_error)
    }

    pub async fn notify_pointer_motion(&self, dx: f64, dy: f64) -> Result<(), PortalError> {
        self.ensure_active()?;
        self.remote_proxy()
            .await?
            .call(
                "NotifyPointerMotion",
                &(&self.handle, empty_options(), dx, dy),
            )
            .await
            .map_err(dbus_error)
    }

    pub async fn notify_pointer_absolute(
        &self,
        stream_node_id: u32,
        point: LogicalPoint,
    ) -> Result<(), PortalError> {
        self.ensure_active()?;
        self.remote_proxy()
            .await?
            .call(
                "NotifyPointerMotionAbsolute",
                &(
                    &self.handle,
                    empty_options(),
                    stream_node_id,
                    point.x,
                    point.y,
                ),
            )
            .await
            .map_err(dbus_error)
    }

    pub async fn notify_pointer_button(
        &self,
        evdev_button: i32,
        pressed: bool,
    ) -> Result<(), PortalError> {
        self.ensure_active()?;
        self.remote_proxy()
            .await?
            .call(
                "NotifyPointerButton",
                &(
                    &self.handle,
                    empty_options(),
                    evdev_button,
                    u32::from(pressed),
                ),
            )
            .await
            .map_err(dbus_error)
    }

    pub async fn notify_pointer_axis(
        &self,
        dx: f64,
        dy: f64,
        finish: bool,
    ) -> Result<(), PortalError> {
        self.ensure_active()?;
        let mut options = empty_options();
        options.insert("finish", Value::from(finish));
        self.remote_proxy()
            .await?
            .call("NotifyPointerAxis", &(&self.handle, options, dx, dy))
            .await
            .map_err(dbus_error)
    }

    pub async fn notify_pointer_axis_discrete(
        &self,
        horizontal: bool,
        steps: i32,
    ) -> Result<(), PortalError> {
        self.ensure_active()?;
        self.remote_proxy()
            .await?
            .call(
                "NotifyPointerAxisDiscrete",
                &(&self.handle, empty_options(), u32::from(horizontal), steps),
            )
            .await
            .map_err(dbus_error)
    }

    pub async fn notify_keyboard_keycode(
        &self,
        evdev_keycode: i32,
        pressed: bool,
    ) -> Result<(), PortalError> {
        self.ensure_active()?;
        self.remote_proxy()
            .await?
            .call(
                "NotifyKeyboardKeycode",
                &(
                    &self.handle,
                    empty_options(),
                    evdev_keycode,
                    u32::from(pressed),
                ),
            )
            .await
            .map_err(dbus_error)
    }

    pub async fn notify_keyboard_keysym(
        &self,
        xkb_keysym: i32,
        pressed: bool,
    ) -> Result<(), PortalError> {
        self.ensure_active()?;
        self.remote_proxy()
            .await?
            .call(
                "NotifyKeyboardKeysym",
                &(
                    &self.handle,
                    empty_options(),
                    xkb_keysym,
                    u32::from(pressed),
                ),
            )
            .await
            .map_err(dbus_error)
    }

    pub async fn open_pipewire_remote(&self) -> Result<PipeWireHandoff, PortalError> {
        self.ensure_active()?;
        let proxy = Proxy::new(&self.connection, DESTINATION, DESKTOP_PATH, SCREEN_CAST)
            .await
            .map_err(dbus_error)?;
        let remote_fd = proxy
            .call("OpenPipeWireRemote", &(&self.handle, empty_options()))
            .await
            .map_err(dbus_error)?;
        Ok(PipeWireHandoff {
            remote_fd,
            streams: self.streams.clone(),
        })
    }

    pub async fn close(&mut self) -> Result<(), PortalError> {
        if self.state.phase() == SessionPhase::Closed {
            return Ok(());
        }
        let proxy = Proxy::new(&self.connection, DESTINATION, self.handle.as_str(), SESSION)
            .await
            .map_err(dbus_error)?;
        proxy
            .call::<_, _, ()>("Close", &())
            .await
            .map_err(dbus_error)?;
        self.state.close();
        Ok(())
    }
}

#[derive(Clone)]
pub struct PortalClient {
    connection: Connection,
}

impl PortalClient {
    pub async fn connect() -> Result<Self, PortalError> {
        Ok(Self {
            connection: Connection::session().await.map_err(dbus_error)?,
        })
    }

    /// Read-only capability probe. This method never creates a Request object.
    pub async fn probe(&self) -> Result<PortalCapabilities, PortalError> {
        let remote = Proxy::new(&self.connection, DESTINATION, DESKTOP_PATH, REMOTE_DESKTOP)
            .await
            .map_err(dbus_error)?;
        let screen = Proxy::new(&self.connection, DESTINATION, DESKTOP_PATH, SCREEN_CAST)
            .await
            .map_err(dbus_error)?;
        let remote_desktop_version = remote.get_property("version").await.map_err(dbus_error)?;
        let available_device_types = remote
            .get_property("AvailableDeviceTypes")
            .await
            .map_err(dbus_error)?;
        let screen_cast_version = screen.get_property("version").await.map_err(dbus_error)?;
        let available_source_types = screen
            .get_property("AvailableSourceTypes")
            .await
            .map_err(dbus_error)?;
        let available_cursor_modes = if screen_cast_version >= 2 {
            screen
                .get_property("AvailableCursorModes")
                .await
                .map_err(dbus_error)?
        } else {
            CURSOR_HIDDEN
        };
        Ok(PortalCapabilities {
            remote_desktop_version,
            screen_cast_version,
            available_device_types,
            available_source_types,
            available_cursor_modes,
        })
    }

    pub async fn start_remote_desktop(
        &self,
        capabilities: PortalCapabilities,
        options: &RemoteDesktopOptions,
        restore_token: &mut RestoreToken,
        headless: HeadlessPolicy,
        authorization: InteractionAuthorization,
    ) -> Result<ActivePortalSession, PortalError> {
        authorize_interaction(headless, authorization)?;
        if !capabilities.supports_devices(options.device_types) {
            return Err(PortalError::Unsupported("requested input devices"));
        }
        if let Some(sources) = options.source_types {
            if !capabilities.supports_sources(sources) {
                return Err(PortalError::Unsupported("requested screen-cast sources"));
            }
            if options.cursor_mode & capabilities.available_cursor_modes == 0 {
                return Err(PortalError::Unsupported("requested cursor mode"));
            }
        }

        let remote = Proxy::new(&self.connection, DESTINATION, DESKTOP_PATH, REMOTE_DESKTOP)
            .await
            .map_err(dbus_error)?;
        let screen = Proxy::new(&self.connection, DESTINATION, DESKTOP_PATH, SCREEN_CAST)
            .await
            .map_err(dbus_error)?;
        let mut state = PortalSessionState::new(options.source_types.is_some());

        state.begin_create()?;
        let request_token = random_token("picu");
        let session_token = random_token("picus");
        let mut create_options = empty_options();
        create_options.insert("handle_token", Value::from(request_token.as_str()));
        create_options.insert("session_handle_token", Value::from(session_token.as_str()));
        let mut response = self
            .request(&remote, "CreateSession", &(create_options,), &request_token)
            .await?;
        let handle_text: String = take_required(&mut response, "session_handle")?;
        let handle = OwnedObjectPath::try_from(handle_text)
            .map_err(|error| PortalError::InvalidResponse(error.to_string()))?;
        state.created()?;

        state.begin_select_devices()?;
        let request_token = random_token("picu");
        let mut device_options = empty_options();
        device_options.insert("handle_token", Value::from(request_token.as_str()));
        device_options.insert("types", Value::from(options.device_types));
        if capabilities.supports_persistence() {
            device_options.insert("persist_mode", Value::from(PERSIST_UNTIL_REVOKED));
            if let Some(token) = restore_token.take_for_attempt() {
                device_options.insert("restore_token", Value::from(token));
            }
        }
        self.request(
            &remote,
            "SelectDevices",
            &(&handle, device_options),
            &request_token,
        )
        .await?;
        state.devices_selected()?;

        if let Some(source_types) = options.source_types {
            state.begin_select_sources()?;
            let request_token = random_token("picu");
            let mut source_options = empty_options();
            source_options.insert("handle_token", Value::from(request_token.as_str()));
            source_options.insert("types", Value::from(source_types));
            source_options.insert("multiple", Value::from(options.multiple_sources));
            source_options.insert("cursor_mode", Value::from(options.cursor_mode));
            // For a RemoteDesktop-created session persistence belongs solely
            // in SelectDevices, never in ScreenCast.SelectSources.
            self.request(
                &screen,
                "SelectSources",
                &(&handle, source_options),
                &request_token,
            )
            .await?;
            state.sources_selected()?;
        }

        state.begin_start()?;
        let request_token = random_token("picu");
        let mut start_options = empty_options();
        start_options.insert("handle_token", Value::from(request_token.as_str()));
        let mut response = self
            .request(
                &remote,
                "Start",
                &(&handle, options.parent_window.as_str(), start_options),
                &request_token,
            )
            .await?;
        let selected_devices = take_optional(&mut response, "devices")?.unwrap_or(0);
        let streams =
            take_optional::<Vec<(u32, HashMap<String, OwnedValue>)>>(&mut response, "streams")?
                .unwrap_or_default()
                .into_iter()
                .map(parse_stream)
                .collect::<Result<Vec<_>, _>>()?;
        let replacement = take_optional(&mut response, "restore_token")?;
        restore_token.rotate(replacement);
        state.started()?;

        Ok(ActivePortalSession {
            connection: self.connection.clone(),
            handle,
            selected_devices,
            streams,
            state,
        })
    }

    async fn request<B>(
        &self,
        proxy: &Proxy<'_>,
        method: &str,
        body: &B,
        token: &str,
    ) -> Result<HashMap<String, OwnedValue>, PortalError>
    where
        B: serde::ser::Serialize + zbus::zvariant::DynamicType,
    {
        let expected_path = self.request_path(token)?;
        // Subscribe before calling to avoid losing a fast Response signal.
        let request_proxy = Proxy::new(
            &self.connection,
            DESTINATION,
            expected_path.as_str(),
            REQUEST,
        )
        .await
        .map_err(dbus_error)?;
        let mut stream = request_proxy
            .receive_signal("Response")
            .await
            .map_err(dbus_error)?;
        let returned_path: OwnedObjectPath = proxy.call(method, body).await.map_err(dbus_error)?;
        if returned_path != expected_path {
            let fallback = Proxy::new(
                &self.connection,
                DESTINATION,
                returned_path.as_str(),
                REQUEST,
            )
            .await
            .map_err(dbus_error)?;
            stream = fallback
                .receive_signal("Response")
                .await
                .map_err(dbus_error)?;
        }
        wait_response(&mut stream).await
    }

    fn request_path(&self, token: &str) -> Result<OwnedObjectPath, PortalError> {
        let sender = self
            .connection
            .unique_name()
            .ok_or_else(|| PortalError::Unavailable("D-Bus connection has no unique name".into()))?
            .as_str()
            .trim_start_matches(':')
            .replace('.', "_");
        OwnedObjectPath::try_from(format!(
            "/org/freedesktop/portal/desktop/request/{sender}/{token}"
        ))
        .map_err(|error| PortalError::InvalidResponse(error.to_string()))
    }
}

async fn wait_response(
    stream: &mut SignalStream<'_>,
) -> Result<HashMap<String, OwnedValue>, PortalError> {
    let message = stream.next().await.ok_or_else(|| {
        PortalError::Unavailable("portal request disappeared without a response".into())
    })?;
    let (response, results): (u32, HashMap<String, OwnedValue>) =
        message.body().deserialize().map_err(dbus_error)?;
    match response {
        0 => Ok(results),
        1 => Err(PortalError::Cancelled),
        other => Err(PortalError::RequestFailed(other)),
    }
}

fn empty_options<'a>() -> HashMap<&'a str, Value<'a>> {
    HashMap::new()
}

fn take_required<T>(values: &mut HashMap<String, OwnedValue>, key: &str) -> Result<T, PortalError>
where
    T: TryFrom<OwnedValue>,
    T::Error: fmt::Display,
{
    take_optional(values, key)?
        .ok_or_else(|| PortalError::InvalidResponse(format!("missing {key}")))
}

fn take_optional<T>(
    values: &mut HashMap<String, OwnedValue>,
    key: &str,
) -> Result<Option<T>, PortalError>
where
    T: TryFrom<OwnedValue>,
    T::Error: fmt::Display,
{
    values
        .remove(key)
        .map(|value| {
            T::try_from(value)
                .map_err(|error| PortalError::InvalidResponse(format!("{key}: {error}")))
        })
        .transpose()
}

fn parse_stream(
    (node_id, mut values): (u32, HashMap<String, OwnedValue>),
) -> Result<PipeWireStream, PortalError> {
    Ok(PipeWireStream {
        node_id,
        id: take_optional(&mut values, "id")?,
        position: take_optional(&mut values, "position")?,
        logical_size: take_optional(&mut values, "size")?,
        source_type: take_optional(&mut values, "source_type")?,
        mapping_id: take_optional(&mut values, "mapping_id")?,
        pipewire_serial: take_optional(&mut values, "pipewire-serial")?,
    })
}

fn random_token(prefix: &str) -> String {
    let mut bytes = [0u8; 16];
    if File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .is_err()
    {
        static FALLBACK: AtomicU64 = AtomicU64::new(1);
        let value = FALLBACK.fetch_add(1, Ordering::Relaxed);
        bytes[..8].copy_from_slice(&value.to_ne_bytes());
        bytes[8..12].copy_from_slice(&std::process::id().to_ne_bytes());
    }
    let suffix = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{prefix}{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_and_strict_headless_can_never_prompt() {
        assert!(matches!(
            authorize_interaction(
                HeadlessPolicy::InteractiveDesktop,
                InteractionAuthorization::Diagnostic
            ),
            Err(PortalError::InteractionDenied(_))
        ));
        assert!(matches!(
            authorize_interaction(
                HeadlessPolicy::StrictHeadless,
                InteractionAuthorization::ExplicitUserAction
            ),
            Err(PortalError::InteractionDenied(_))
        ));
        assert!(authorize_interaction(
            HeadlessPolicy::InteractiveDesktop,
            InteractionAuthorization::ExplicitUserAction
        )
        .is_ok());
    }

    #[test]
    fn state_machine_enforces_one_shot_portal_order() {
        let mut state = PortalSessionState::new(true);
        assert!(state.begin_start().is_err());
        state.begin_create().unwrap();
        state.created().unwrap();
        state.begin_select_devices().unwrap();
        state.devices_selected().unwrap();
        state.begin_select_sources().unwrap();
        state.sources_selected().unwrap();
        state.begin_start().unwrap();
        state.started().unwrap();
        assert_eq!(state.phase(), SessionPhase::Active);
        assert!(state.begin_start().is_err());
        state.close();
        assert_eq!(state.phase(), SessionPhase::Closed);
    }

    #[test]
    fn session_without_capture_skips_source_selection() {
        let mut state = PortalSessionState::new(false);
        state.begin_create().unwrap();
        state.created().unwrap();
        state.begin_select_devices().unwrap();
        state.devices_selected().unwrap();
        assert_eq!(state.phase(), SessionPhase::ReadyToStart);
    }

    #[test]
    fn restore_token_is_consumed_then_rotated() {
        let mut token = RestoreToken::new("old");
        assert_eq!(token.take_for_attempt().as_deref(), Some("old"));
        assert_eq!(token.take_for_attempt(), None);
        token.rotate(Some("new".into()));
        assert_eq!(token.current(), Some("new"));
    }

    #[test]
    fn coordinate_mapping_uses_logical_not_pixel_space() {
        let rect = LogicalRect {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        assert_eq!(
            rect.compositor_to_stream(LogicalPoint {
                x: -960.0,
                y: 540.0
            }),
            Some(LogicalPoint { x: 960.0, y: 540.0 })
        );
        assert_eq!(
            rect.normalized_to_stream(0.5, 0.25),
            Some(LogicalPoint { x: 960.0, y: 270.0 })
        );
        assert!(rect
            .compositor_to_stream(LogicalPoint { x: 10.0, y: 10.0 })
            .is_none());
    }

    #[test]
    fn capability_masks_are_strict() {
        let capabilities = PortalCapabilities {
            remote_desktop_version: 2,
            screen_cast_version: 6,
            available_device_types: DEVICE_KEYBOARD | DEVICE_POINTER,
            available_source_types: SOURCE_MONITOR,
            available_cursor_modes: CURSOR_HIDDEN | CURSOR_METADATA,
        };
        assert!(capabilities.supports_persistence());
        assert!(capabilities.supports_devices(DEVICE_KEYBOARD | DEVICE_POINTER));
        assert!(!capabilities.supports_devices(DEVICE_TOUCHSCREEN));
        assert!(capabilities.supports_sources(SOURCE_MONITOR));
        assert!(!capabilities.supports_sources(SOURCE_WINDOW));
    }

    #[test]
    fn generated_tokens_are_valid_object_path_elements_and_unique() {
        let first = random_token("picu");
        let second = random_token("picu");
        assert_ne!(first, second);
        assert!(first
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_'));
    }
}
