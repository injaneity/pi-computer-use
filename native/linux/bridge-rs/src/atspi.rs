//! Minimal, dependency-light AT-SPI2 client built on zbus.
//!
//! Linux desktop accessibility is intentionally used in preference to global
//! pointer/keyboard injection: Action and EditableText calls are delivered to
//! applications in the background and do not steal focus.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::{json, Value};
use zbus::zvariant::OwnedObjectPath;
use zbus::{Connection, Proxy};

use crate::{ErrorCode, ProtocolError};

const DBUS_DESTINATION: &str = "org.freedesktop.DBus";
const DBUS_ROOT: &str = "/org/freedesktop/DBus";
const DBUS_INTERFACE: &str = "org.freedesktop.DBus";
const REGISTRY_DESTINATION: &str = "org.a11y.atspi.Registry";
const REGISTRY_ROOT: &str = "/org/a11y/atspi/accessible/root";
const ACCESSIBLE: &str = "org.a11y.atspi.Accessible";
const COMPONENT: &str = "org.a11y.atspi.Component";
const ACTION: &str = "org.a11y.atspi.Action";
const MAX_ATSPI_ACTIONS: usize = 64;
const EDITABLE_TEXT: &str = "org.a11y.atspi.EditableText";
const TEXT: &str = "org.a11y.atspi.Text";

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AccessibleRef {
    pub destination: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone)]
pub struct RootSnapshot {
    pub accessible: AccessibleRef,
    pub pid: u64,
    pub name: String,
    pub app_name: String,
    pub role: String,
    pub frame: Option<Rect>,
    pub x11_window: Option<u32>,
    pub is_focused: bool,
    pub is_minimized: bool,
    pub z_order: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct NodeSnapshot {
    pub reference: String,
    pub accessible: AccessibleRef,
    pub parent: Option<AccessibleRef>,
    pub name: String,
    pub role: String,
    pub description: String,
    pub value: String,
    pub interfaces: HashSet<String>,
    pub bounds: Option<Rect>,
    pub is_secure: bool,
    pub depth: usize,
}

impl NodeSnapshot {
    #[cfg(test)]
    pub(crate) fn minimal(accessible: AccessibleRef) -> Self {
        Self {
            reference: String::new(),
            accessible,
            parent: None,
            name: String::new(),
            role: String::new(),
            description: String::new(),
            value: String::new(),
            interfaces: HashSet::new(),
            bounds: None,
            is_secure: false,
            depth: 0,
        }
    }

    pub fn searchable_text(&self) -> String {
        format!("{} {} {}", self.name, self.description, self.value).to_lowercase()
    }
}

#[derive(Clone)]
pub struct AtspiClient {
    connection: Connection,
}

impl AtspiClient {
    pub async fn connect() -> Result<Self, ProtocolError> {
        let session = Connection::session().await.map_err(unavailable)?;
        let bus = Proxy::new(&session, "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus")
            .await
            .map_err(unavailable)?;
        let address: String = bus.call("GetAddress", &()).await.map_err(unavailable)?;
        let connection = zbus::connection::Builder::address(address.as_str())
            .map_err(unavailable)?
            .build()
            .await
            .map_err(unavailable)?;
        Ok(Self { connection })
    }

    pub async fn available() -> bool {
        Self::connect().await.is_ok()
    }

    async fn proxy<'a>(
        &'a self,
        accessible: &'a AccessibleRef,
        interface: &'a str,
    ) -> Result<Proxy<'a>, ProtocolError> {
        Proxy::new(
            &self.connection,
            accessible.destination.as_str(),
            accessible.path.as_str(),
            interface,
        )
        .await
        .map_err(atspi_error)
    }

    async fn children(
        &self,
        accessible: &AccessibleRef,
    ) -> Result<Vec<AccessibleRef>, ProtocolError> {
        let proxy = self.proxy(accessible, ACCESSIBLE).await?;
        let children: Vec<(String, OwnedObjectPath)> =
            proxy.call("GetChildren", &()).await.map_err(atspi_error)?;
        Ok(children
            .into_iter()
            .filter(|(destination, path)| !destination.is_empty() && path.as_str() != "/")
            .map(|(destination, path)| AccessibleRef {
                destination,
                path: path.to_string(),
            })
            .collect())
    }

    async fn string_property(&self, accessible: &AccessibleRef, property: &str) -> String {
        match self.proxy(accessible, ACCESSIBLE).await {
            Ok(proxy) => proxy.get_property(property).await.unwrap_or_default(),
            Err(_) => String::new(),
        }
    }

    async fn role(&self, accessible: &AccessibleRef) -> String {
        match self.proxy(accessible, ACCESSIBLE).await {
            Ok(proxy) => proxy.call("GetRoleName", &()).await.unwrap_or_default(),
            Err(_) => String::new(),
        }
    }

    async fn interfaces(&self, accessible: &AccessibleRef) -> HashSet<String> {
        match self.proxy(accessible, ACCESSIBLE).await {
            Ok(proxy) => proxy
                .call::<_, _, Vec<String>>("GetInterfaces", &())
                .await
                .unwrap_or_default()
                .into_iter()
                .collect(),
            Err(_) => HashSet::new(),
        }
    }

    async fn bounds(&self, accessible: &AccessibleRef) -> Option<Rect> {
        let proxy = self.proxy(accessible, COMPONENT).await.ok()?;
        let (x, y, width, height): (i32, i32, i32, i32) =
            proxy.call("GetExtents", &(0u32)).await.ok()?;
        (width > 0 && height > 0).then_some(Rect {
            x,
            y,
            width,
            height,
        })
    }

    async fn application_pid(&self, accessible: &AccessibleRef) -> u64 {
        let application_id = match self.proxy(accessible, "org.a11y.atspi.Application").await {
            Ok(proxy) => proxy.get_property::<i32>("Id").await.unwrap_or(0),
            Err(_) => 0,
        };
        if let Some(pid) = positive_application_pid(application_id) {
            return pid;
        }
        let Ok(bus) = Proxy::new(
            &self.connection,
            DBUS_DESTINATION,
            DBUS_ROOT,
            DBUS_INTERFACE,
        )
        .await
        else {
            return 0;
        };
        let connection_pid: Option<u32> = bus
            .call(
                "GetConnectionUnixProcessID",
                &(accessible.destination.as_str()),
            )
            .await
            .ok();
        fallback_application_pid(application_id, connection_pid)
    }

    pub async fn list_roots(
        &self,
        filter_pid: Option<u64>,
    ) -> Result<Vec<RootSnapshot>, ProtocolError> {
        let registry = AccessibleRef {
            destination: REGISTRY_DESTINATION.to_owned(),
            path: REGISTRY_ROOT.to_owned(),
        };
        let applications = self.children(&registry).await?;
        let mut roots = Vec::new();
        for app in applications {
            let pid = self.application_pid(&app).await;
            if filter_pid.is_some_and(|wanted| wanted != pid) {
                continue;
            }
            let app_name = self.string_property(&app, "Name").await;
            let windows = self.children(&app).await.unwrap_or_default();
            for window in windows {
                let role = self.role(&window).await;
                let name = self.string_property(&window, "Name").await;
                roots.push(RootSnapshot {
                    frame: self.bounds(&window).await,
                    accessible: window,
                    pid,
                    name: if name.is_empty() {
                        app_name.clone()
                    } else {
                        name
                    },
                    app_name: app_name.clone(),
                    role,
                    x11_window: None,
                    is_focused: false,
                    is_minimized: false,
                    z_order: None,
                });
            }
        }
        Ok(roots)
    }

    pub async fn snapshot(
        &self,
        root: &RootSnapshot,
        max_nodes: usize,
        max_depth: usize,
    ) -> Result<Vec<NodeSnapshot>, ProtocolError> {
        self.snapshot_from(&root.accessible, max_nodes, max_depth)
            .await
    }

    pub async fn snapshot_from(
        &self,
        start: &AccessibleRef,
        max_nodes: usize,
        max_depth: usize,
    ) -> Result<Vec<NodeSnapshot>, ProtocolError> {
        let mut result = Vec::new();
        let mut seen = HashSet::new();
        let mut queue = VecDeque::from([(start.clone(), None, 0usize)]);
        while let Some((accessible, parent, depth)) = queue.pop_front() {
            if result.len() >= max_nodes || depth > max_depth || !seen.insert(accessible.clone()) {
                continue;
            }
            let interfaces = self.interfaces(&accessible).await;
            let role = self.role(&accessible).await;
            let name = self.string_property(&accessible, "Name").await;
            let description = self.string_property(&accessible, "Description").await;
            let is_secure =
                role.eq_ignore_ascii_case("password text") || role.eq_ignore_ascii_case("password");
            let value = if !is_secure && interfaces.contains(TEXT) {
                self.read_text(&accessible).await.unwrap_or_default()
            } else {
                String::new()
            };
            let children = self.children(&accessible).await.unwrap_or_default();
            for child in children {
                queue.push_back((child, Some(accessible.clone()), depth + 1));
            }
            result.push(NodeSnapshot {
                reference: String::new(),
                bounds: self.bounds(&accessible).await,
                accessible,
                parent,
                name,
                role,
                description,
                value,
                interfaces,
                is_secure,
                depth,
            });
        }
        Ok(result)
    }

    pub async fn read_text(&self, accessible: &AccessibleRef) -> Result<String, ProtocolError> {
        let proxy = self.proxy(accessible, TEXT).await?;
        proxy
            .call("GetText", &(0i32, -1i32))
            .await
            .map_err(atspi_error)
    }

    pub async fn press(&self, node: &NodeSnapshot) -> Result<bool, ProtocolError> {
        if !node.interfaces.contains(ACTION) {
            return Err(ProtocolError::new(
                "Target does not expose the AT-SPI Action interface",
                ErrorCode::CapabilityDeferred,
            ));
        }
        let proxy = self.proxy(&node.accessible, ACTION).await?;
        let action_count = bounded_action_count(proxy.get_property::<i32>("NActions").await.ok())?;
        let mut names = Vec::new();
        if action_count > 1 {
            names.reserve(action_count);
            for index in 0..action_count {
                let name: String = proxy
                    .call("GetName", &(index as i32))
                    .await
                    .unwrap_or_default();
                names.push(name);
            }
        }
        let Some(action_index) = selected_action_index(action_count, &names) else {
            return Ok(false);
        };
        proxy
            .call("DoAction", &(action_index))
            .await
            .map_err(atspi_error)
    }

    pub async fn set_text(&self, node: &NodeSnapshot, text: &str) -> Result<bool, ProtocolError> {
        if !node.interfaces.contains(EDITABLE_TEXT) {
            return Err(ProtocolError::new(
                "Target does not expose the AT-SPI EditableText interface",
                ErrorCode::CapabilityDeferred,
            ));
        }
        let proxy = self.proxy(&node.accessible, EDITABLE_TEXT).await?;
        proxy
            .call("SetTextContents", &(text))
            .await
            .map_err(atspi_error)
    }
}

pub fn root_json(reference: &str, root: &RootSnapshot, z_order: usize) -> Value {
    let kind = if root.role.to_lowercase().contains("dialog") {
        "dialog"
    } else {
        "window"
    };
    let frame = root
        .frame
        .as_ref()
        .map(|r| json!({"x":r.x,"y":r.y,"width":r.width,"height":r.height}))
        .unwrap_or_else(|| json!({"x":0,"y":0,"width":0,"height":0}));
    json!({
        "kind": kind,
        "rootRef": reference,
        "windowRef": reference,
        "ref": reference,
        "windowId": root.x11_window.unwrap_or(root.pid as u32),
        "title": root.name,
        "pid": root.pid,
        "appName": root.app_name,
        "processName": root.app_name,
        "role": root.role,
        "subrole": "",
        "zOrder": root.z_order.unwrap_or(z_order),
        "framePoints": frame,
        "bounds": frame,
        "scaleFactor": 1.0,
        "isFocused": root.is_focused,
        "isMain": root.is_focused || z_order == 0,
        "isMinimized": root.is_minimized,
        "isOnscreen": true,
        "isModal": kind == "dialog",
        "metadata": {"backend":"at-spi2","busName":root.accessible.destination,"objectPath":root.accessible.path},
        "isBrowser": false,
        "browserFamily": Value::Null
    })
}

pub fn outline_json(
    _root_ref: &str,
    _root: &RootSnapshot,
    nodes: &[NodeSnapshot],
    max_nodes: usize,
) -> Value {
    let mut descendants: HashMap<AccessibleRef, Vec<Value>> = HashMap::new();
    let mut roots = Vec::new();
    for node in nodes.iter().rev() {
        let rect = node
            .bounds
            .as_ref()
            .map(|r| {
                let origin_x = _root.frame.as_ref().map(|f| f.x).unwrap_or(0);
                let origin_y = _root.frame.as_ref().map(|f| f.y).unwrap_or(0);
                json!({"x":relative_coordinate(r.x, origin_x),"y":relative_coordinate(r.y, origin_y),"w":r.width,"h":r.height})
            })
            .unwrap_or_else(|| json!({"x":0,"y":0,"w":0,"h":0}));
        let can_press = node.interfaces.contains(ACTION);
        let can_set_value = node.interfaces.contains(EDITABLE_TEXT);
        let mut actions = Vec::new();
        if can_press {
            actions.push("press");
        }
        if can_set_value {
            actions.push("setValue");
        }
        let mut children = descendants.remove(&node.accessible).unwrap_or_default();
        children.reverse();
        let value = json!({
            "ref": node.reference,
            "role": node.role,
            "subrole": "",
            "identifier": node.accessible.path,
            "title": node.name,
            "description": node.description,
            "value": if node.is_secure { "" } else { &node.value },
            "actions": actions,
            "canPress": can_press,
            "canFocus": false,
            "canSetValue": can_set_value,
            "canScroll": false,
            "canIncrement": false,
            "canDecrement": false,
            "isTextInput": can_set_value,
            "rect": rect,
            "focused": false,
            "offscreen": node.bounds.is_none(),
            "pictureOnly": false,
            "truncated": nodes.len() >= max_nodes && node.depth == 0,
            "text": if node.value.is_empty() || node.is_secure { json!([]) } else {
                json!([{"string":node.value,"confidence":1.0,"rect":rect}])
            },
            "children": children
        });
        if let Some(parent) = &node.parent {
            descendants.entry(parent.clone()).or_default().push(value);
        } else {
            roots.push(value);
        }
    }
    roots.reverse();
    if roots.is_empty() {
        json!({"role":"window","title":"","children":[],"truncated":false})
    } else {
        let mut root = roots.remove(0);
        if !roots.is_empty() {
            root["children"]
                .as_array_mut()
                .expect("children array")
                .extend(roots);
        }
        root
    }
}

fn normalized_action_name(name: &str) -> String {
    name.trim()
        .to_ascii_lowercase()
        .replace(['-', '_'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn activation_action_index(names: &[String]) -> usize {
    const PRIORITY: [&str; 5] = ["activate", "click", "press", "invoke", "open"];
    PRIORITY
        .iter()
        .find_map(|wanted| {
            names
                .iter()
                .position(|name| normalized_action_name(name) == *wanted)
        })
        .unwrap_or(0)
}

fn selected_action_index(action_count: usize, names: &[String]) -> Option<i32> {
    match action_count {
        0 => None,
        1 => Some(0),
        _ => Some(activation_action_index(names) as i32),
    }
}

fn bounded_action_count(raw_count: Option<i32>) -> Result<usize, ProtocolError> {
    let count = raw_count.unwrap_or(0);
    if count <= 1 {
        return Ok(count.max(0) as usize);
    }
    let count = usize::try_from(count).map_err(|_| {
        ProtocolError::new(
            "AT-SPI action count is invalid",
            ErrorCode::CapabilityDeferred,
        )
    })?;
    if count > MAX_ATSPI_ACTIONS {
        return Err(ProtocolError::new(
            format!(
                "AT-SPI target exposes {count} actions; maximum supported is {MAX_ATSPI_ACTIONS}"
            ),
            ErrorCode::CapabilityDeferred,
        ));
    }
    Ok(count)
}

fn relative_coordinate(value: i32, origin: i32) -> i32 {
    value.saturating_sub(origin)
}

fn positive_application_pid(application_id: i32) -> Option<u64> {
    u64::try_from(application_id).ok().filter(|pid| *pid > 0)
}

fn fallback_application_pid(application_id: i32, connection_pid: Option<u32>) -> u64 {
    positive_application_pid(application_id)
        .or_else(|| connection_pid.filter(|pid| *pid > 0).map(u64::from))
        .unwrap_or(0)
}

fn unavailable(error: impl std::fmt::Display) -> ProtocolError {
    ProtocolError::new(
        format!("AT-SPI2 is unavailable: {error}"),
        ErrorCode::CapabilityDeferred,
    )
}

fn atspi_error(error: impl std::fmt::Display) -> ProtocolError {
    ProtocolError::new(
        format!("AT-SPI2 request failed: {error}"),
        ErrorCode::InternalError,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_action_selection_prefers_semantics_over_index_zero() {
        let row = ["expand or contract", "edit", "activate"].map(str::to_owned);
        assert_eq!(activation_action_index(&row), 2);
        let mixed = ["open", "press", "click"].map(str::to_owned);
        assert_eq!(activation_action_index(&mixed), 2);
        let unsupported = ["expand or contract", "edit"].map(str::to_owned);
        assert_eq!(activation_action_index(&unsupported), 0);
        assert_eq!(activation_action_index(&["  InVoKe  ".into()]), 0);
    }

    #[test]
    fn action_count_and_dispatch_boundaries_are_explicit() {
        assert_eq!(bounded_action_count(Some(0)).unwrap(), 0);
        assert_eq!(selected_action_index(0, &[]), None);
        assert_eq!(bounded_action_count(Some(1)).unwrap(), 1);
        assert_eq!(selected_action_index(1, &[]), Some(0));

        let mut names = vec!["edit".to_owned(); 64];
        names[63] = "activate".to_owned();
        assert_eq!(bounded_action_count(Some(64)).unwrap(), 64);
        assert_eq!(selected_action_index(64, &names), Some(63));
        assert!(bounded_action_count(Some(65)).is_err());
        assert!(bounded_action_count(Some(i32::MAX)).is_err());
    }

    #[test]
    fn relative_coordinates_saturate_instead_of_overflowing() {
        assert_eq!(relative_coordinate(i32::MIN, i32::MAX), i32::MIN);
        assert_eq!(relative_coordinate(i32::MAX, i32::MIN), i32::MAX);
        assert_eq!(relative_coordinate(355, 100), 255);
    }

    #[test]
    fn application_pid_prefers_positive_atspi_id_then_bus_fallback() {
        assert_eq!(fallback_application_pid(42, Some(99)), 42);
        assert_eq!(fallback_application_pid(0, Some(99)), 99);
        assert_eq!(fallback_application_pid(-1, Some(99)), 99);
        assert_eq!(fallback_application_pid(0, Some(0)), 0);
        assert_eq!(fallback_application_pid(0, None), 0);
    }

    #[tokio::test]
    #[ignore = "requires a live session AT-SPI bus"]
    async fn connects_through_get_address_method() {
        AtspiClient::connect()
            .await
            .expect("org.a11y.Bus.GetAddress should return a usable bus address");
    }

    #[test]
    fn root_shape_has_cross_platform_aliases() {
        let root = RootSnapshot {
            accessible: AccessibleRef {
                destination: ":1.2".into(),
                path: "/window".into(),
            },
            pid: 42,
            name: "Editor".into(),
            app_name: "Text Editor".into(),
            role: "frame".into(),
            frame: Some(Rect {
                x: 1,
                y: 2,
                width: 3,
                height: 4,
            }),
            x11_window: Some(99),
            is_focused: true,
            is_minimized: false,
            z_order: Some(0),
        };
        let value = root_json("@w1", &root, 0);
        assert_eq!(value["rootRef"], "@w1");
        assert_eq!(value["windowRef"], "@w1");
        assert_eq!(value["metadata"]["backend"], "at-spi2");
        assert_eq!(value["title"], "Editor");
        assert_eq!(value["appName"], "Text Editor");
        assert_eq!(value["processName"], "Text Editor");
    }
}
