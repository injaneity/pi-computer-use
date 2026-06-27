use serde_json::Value;

use crate::error::{ErrorCode, ProtocolError};

pub fn act(args: &Value) -> Result<Value, ProtocolError> {
    #[cfg(not(windows))]
    {
        let _ = args;
        Err(ProtocolError::new(
            "Input actions are only supported on Windows",
            ErrorCode::UnsupportedPlatform,
        ))
    }

    #[cfg(windows)]
    {
        native::act(args)
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use serde_json::json;
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;

    pub fn act(args: &Value) -> Result<Value, ProtocolError> {
        let action = args.get("action").and_then(Value::as_str).unwrap_or("");
        match action {
            "press" | "click" => {
                let (x, y) = point(args)?;
                click(x, y)?;
                ok("coordinates", "hid")
            }
            "moveMouse" => {
                let (x, y) = point(args)?;
                unsafe { SetCursorPos(x, y) }.map_err(capture_failed)?;
                ok("coordinates", "hid")
            }
            "drag" => {
                let path = args
                    .get("path")
                    .and_then(Value::as_array)
                    .ok_or_else(|| invalid("drag requires path"))?;
                let points = path
                    .iter()
                    .map(point_value)
                    .collect::<Result<Vec<_>, _>>()?;
                drag(&points)?;
                ok("coordinates", "hid")
            }
            "scroll" => {
                let (x, y) = point(args)?;
                let dy = args.get("scrollY").and_then(Value::as_f64).unwrap_or(0.0);
                let dx = args.get("scrollX").and_then(Value::as_f64).unwrap_or(0.0);
                scroll(x, y, dx, dy)?;
                ok("coordinates", "hid")
            }
            "typeText" => {
                if let Ok((x, y)) = point(args) {
                    click(x, y)?;
                }
                send_text(args.get("text").and_then(Value::as_str).unwrap_or(""))?;
                ok("coordinates", "hid")
            }
            "setText" => {
                if let Ok((x, y)) = point(args) {
                    click(x, y)?;
                }
                hotkey(&[VK_CONTROL], VK_A)?;
                send_text(args.get("text").and_then(Value::as_str).unwrap_or(""))?;
                ok("coordinates", "hid")
            }
            "keypress" => {
                let keys = args
                    .get("keys")
                    .and_then(Value::as_array)
                    .ok_or_else(|| invalid("keypress requires keys"))?;
                send_keys(keys)?;
                ok("coordinates", "hid")
            }
            other => Err(ProtocolError::new(
                format!("Unsupported Windows action '{other}'"),
                ErrorCode::UnsupportedCommand,
            )),
        }
    }

    fn ok(grounding: &str, delivery: &str) -> Result<Value, ProtocolError> {
        Ok(
            json!({ "outcome": "unknown", "performed": { "grounding": grounding, "delivery": delivery } }),
        )
    }

    fn invalid(message: impl Into<String>) -> ProtocolError {
        ProtocolError::new(message.into(), ErrorCode::InvalidRequest)
    }
    fn capture_failed(error: impl std::fmt::Display) -> ProtocolError {
        ProtocolError::new(format!("Input failed: {error}"), ErrorCode::CaptureFailed)
    }

    fn point(args: &Value) -> Result<(i32, i32), ProtocolError> {
        point_value(args.get("point").unwrap_or(args))
    }
    fn point_value(value: &Value) -> Result<(i32, i32), ProtocolError> {
        let x = value
            .get("x")
            .and_then(Value::as_f64)
            .ok_or_else(|| invalid("point.x is required"))?;
        let y = value
            .get("y")
            .and_then(Value::as_f64)
            .ok_or_else(|| invalid("point.y is required"))?;
        Ok((x.round() as i32, y.round() as i32))
    }

    fn send(inputs: &[INPUT]) -> Result<(), ProtocolError> {
        let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent == inputs.len() as u32 {
            Ok(())
        } else {
            Err(capture_failed(format!(
                "SendInput inserted {sent}/{} events",
                inputs.len()
            )))
        }
    }

    fn mouse(flags: MOUSE_EVENT_FLAGS, data: u32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dwFlags: flags,
                    mouseData: data,
                    ..Default::default()
                },
            },
        }
    }

    fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    dwFlags: if up {
                        KEYEVENTF_KEYUP
                    } else {
                        KEYBD_EVENT_FLAGS(0)
                    },
                    ..Default::default()
                },
            },
        }
    }

    fn unicode(ch: u16, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wScan: ch,
                    dwFlags: KEYEVENTF_UNICODE
                        | if up {
                            KEYEVENTF_KEYUP
                        } else {
                            KEYBD_EVENT_FLAGS(0)
                        },
                    ..Default::default()
                },
            },
        }
    }

    fn click(x: i32, y: i32) -> Result<(), ProtocolError> {
        unsafe { SetCursorPos(x, y) }.map_err(capture_failed)?;
        send(&[mouse(MOUSEEVENTF_LEFTDOWN, 0), mouse(MOUSEEVENTF_LEFTUP, 0)])
    }

    fn drag(points: &[(i32, i32)]) -> Result<(), ProtocolError> {
        if points.len() < 2 {
            return Err(invalid("drag requires at least two points"));
        }
        unsafe { SetCursorPos(points[0].0, points[0].1) }.map_err(capture_failed)?;
        send(&[mouse(MOUSEEVENTF_LEFTDOWN, 0)])?;
        for &(x, y) in &points[1..] {
            unsafe { SetCursorPos(x, y) }.map_err(capture_failed)?;
        }
        send(&[mouse(MOUSEEVENTF_LEFTUP, 0)])
    }

    fn scroll(x: i32, y: i32, dx: f64, dy: f64) -> Result<(), ProtocolError> {
        unsafe { SetCursorPos(x, y) }.map_err(capture_failed)?;
        let mut inputs = Vec::new();
        if dy != 0.0 {
            inputs.push(mouse(
                MOUSEEVENTF_WHEEL,
                (-dy * 120.0).round() as i32 as u32,
            ));
        }
        if dx != 0.0 {
            inputs.push(mouse(
                MOUSEEVENTF_HWHEEL,
                (dx * 120.0).round() as i32 as u32,
            ));
        }
        if inputs.is_empty() {
            return Ok(());
        }
        send(&inputs)
    }

    fn send_text(text: &str) -> Result<(), ProtocolError> {
        let mut inputs = Vec::new();
        for unit in text.encode_utf16() {
            inputs.push(unicode(unit, false));
            inputs.push(unicode(unit, true));
        }
        send(&inputs)
    }

    fn send_keys(keys: &[Value]) -> Result<(), ProtocolError> {
        let names = keys.iter().filter_map(Value::as_str).collect::<Vec<_>>();
        if names.is_empty() {
            return Err(invalid("keypress requires at least one key"));
        }
        let vks = names
            .iter()
            .map(|name| vk_for(name).ok_or_else(|| invalid(format!("Unsupported key '{name}'"))))
            .collect::<Result<Vec<_>, _>>()?;
        for vk in &vks[..vks.len().saturating_sub(1)] {
            send(&[key(*vk, false)])?;
        }
        if let Some(last) = vks.last() {
            send(&[key(*last, false), key(*last, true)])?;
        }
        for vk in vks[..vks.len().saturating_sub(1)].iter().rev() {
            send(&[key(*vk, true)])?;
        }
        Ok(())
    }

    fn hotkey(mods: &[VIRTUAL_KEY], key_vk: VIRTUAL_KEY) -> Result<(), ProtocolError> {
        for vk in mods {
            send(&[key(*vk, false)])?;
        }
        send(&[key(key_vk, false), key(key_vk, true)])?;
        for vk in mods.iter().rev() {
            send(&[key(*vk, true)])?;
        }
        Ok(())
    }

    fn vk_for(name: &str) -> Option<VIRTUAL_KEY> {
        match name.to_ascii_lowercase().as_str() {
            "enter" | "return" => Some(VK_RETURN),
            "escape" | "esc" => Some(VK_ESCAPE),
            "tab" => Some(VK_TAB),
            "backspace" => Some(VK_BACK),
            "delete" => Some(VK_DELETE),
            "space" => Some(VK_SPACE),
            "left" | "arrowleft" => Some(VK_LEFT),
            "right" | "arrowright" => Some(VK_RIGHT),
            "up" | "arrowup" => Some(VK_UP),
            "down" | "arrowdown" => Some(VK_DOWN),
            "home" => Some(VK_HOME),
            "end" => Some(VK_END),
            "pageup" => Some(VK_PRIOR),
            "pagedown" => Some(VK_NEXT),
            "ctrl" | "control" => Some(VK_CONTROL),
            "shift" => Some(VK_SHIFT),
            "alt" | "option" => Some(VK_MENU),
            "cmd" | "win" | "meta" => Some(VK_LWIN),
            key if key.len() == 1 => {
                Some(VIRTUAL_KEY(key.as_bytes()[0].to_ascii_uppercase() as u16))
            }
            key if key.starts_with('f') => key[1..]
                .parse::<u16>()
                .ok()
                .filter(|n| (1..=24).contains(n))
                .map(|n| VIRTUAL_KEY(VK_F1.0 + n - 1)),
            _ => None,
        }
    }
}
