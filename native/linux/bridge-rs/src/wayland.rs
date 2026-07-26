//! Read-only Wayland portal capability diagnostics.
//!
//! Runtime capture and input are intentionally unsupported. The probe only
//! reads D-Bus properties and never creates a portal request or session.

use std::fmt;

use zbus::{Connection, Proxy};

const DESTINATION: &str = "org.freedesktop.portal.Desktop";
const DESKTOP_PATH: &str = "/org/freedesktop/portal/desktop";
const REMOTE_DESKTOP: &str = "org.freedesktop.portal.RemoteDesktop";
const SCREEN_CAST: &str = "org.freedesktop.portal.ScreenCast";
const CURSOR_HIDDEN: u32 = 1;

#[derive(Debug)]
pub enum PortalError {
    Unavailable(String),
}

impl fmt::Display for PortalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable(message) => write!(f, "desktop portal unavailable: {message}"),
        }
    }
}

impl std::error::Error for PortalError {}

fn unavailable(error: impl fmt::Display) -> PortalError {
    PortalError::Unavailable(error.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortalCapabilities {
    pub remote_desktop_version: u32,
    pub screen_cast_version: u32,
    pub available_device_types: u32,
    pub available_source_types: u32,
    pub available_cursor_modes: u32,
}

#[derive(Clone)]
pub struct PortalClient {
    connection: Connection,
}

impl PortalClient {
    pub async fn connect() -> Result<Self, PortalError> {
        Ok(Self {
            connection: Connection::session().await.map_err(unavailable)?,
        })
    }

    pub async fn probe(&self) -> Result<PortalCapabilities, PortalError> {
        let remote = Proxy::new(&self.connection, DESTINATION, DESKTOP_PATH, REMOTE_DESKTOP)
            .await
            .map_err(unavailable)?;
        let screen = Proxy::new(&self.connection, DESTINATION, DESKTOP_PATH, SCREEN_CAST)
            .await
            .map_err(unavailable)?;
        let remote_desktop_version = remote.get_property("version").await.map_err(unavailable)?;
        let available_device_types = remote
            .get_property("AvailableDeviceTypes")
            .await
            .map_err(unavailable)?;
        let screen_cast_version = screen.get_property("version").await.map_err(unavailable)?;
        let available_source_types = screen
            .get_property("AvailableSourceTypes")
            .await
            .map_err(unavailable)?;
        let available_cursor_modes = if screen_cast_version >= 2 {
            screen
                .get_property("AvailableCursorModes")
                .await
                .map_err(unavailable)?
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
}
