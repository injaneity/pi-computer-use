//! Read-only UIA (UI Automation) element extraction for Windows.
//!
//! On Windows, uses the [`windows`] crate to walk the UIA accessibility tree
//! of a given top-level window and extract semantic elements with their
//! properties.  On non-Windows platforms all entry points are stubbed out
//! and return empty results.
//!
//! **Scope (PR #1):** read-only element extraction only.  No action
//! execution, focus, or input.

use serde_json::Value;

#[cfg(windows)]
use crate::refs::NativeHandle;
use crate::refs::RefStore;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/// Extract UIA accessible elements from the window identified by `hwnd`.
///
/// Returns a `Vec` of JSON objects, each with shape:
/// ```json
/// {
///   "ref": "@e1",
///   "role": "edit",
///   "label": "Address bar",
///   "automationId": "1001",
///   "className": "Edit",
///   "bounds": { "x": 0, "y": 0, "width": 100, "height": 20 },
///   "capabilities": { "isEnabled": true, "isOffscreen": false }
/// }
/// ```
///
/// On non-Windows this always returns an empty `Vec`.
pub fn extract_elements(store: &mut RefStore, hwnd: isize) -> Vec<Value> {
    #[cfg(not(windows))]
    {
        let _ = store;
        let _ = hwnd;
        Vec::new()
    }

    #[cfg(windows)]
    {
        match uia_extract(store, hwnd) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[uia] WARN extraction skipped: {e}");
                Vec::new()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// UIA control type → semantic role mapping
//
// These constants and the mapping function are always compiled because
// they are exercised by cross-platform unit tests, but on non-Windows the
// compiler flags them as dead code since they are only called from the
// `#[cfg(windows)] native` module.  We suppress the lint for that case.
// ---------------------------------------------------------------------------

#[cfg_attr(not(windows), allow(dead_code))]
const UIA_WINDOW_CONTROL: u32 = 50032;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_PANE_CONTROL: u32 = 50033;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_DOCUMENT_CONTROL: u32 = 50030;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_EDIT_CONTROL: u32 = 50004;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_BUTTON_CONTROL: u32 = 50000;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_CHECKBOX_CONTROL: u32 = 50002;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_RADIOBUTTON_CONTROL: u32 = 50007;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_COMBOBOX_CONTROL: u32 = 50003;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_LIST_CONTROL: u32 = 50008;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_LISTITEM_CONTROL: u32 = 50009;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TREE_CONTROL: u32 = 50020;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TREEITEM_CONTROL: u32 = 50021;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_MENUITEM_CONTROL: u32 = 50010;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TEXT_CONTROL: u32 = 50019;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_HYPERLINK_CONTROL: u32 = 50005;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TAB_CONTROL: u32 = 50018;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TABITEM_CONTROL: u32 = 50022;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_HEADER_CONTROL: u32 = 50034;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_HEADERITEM_CONTROL: u32 = 50035;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TABLE_CONTROL: u32 = 50036;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_IMAGE_CONTROL: u32 = 50031;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_SLIDER_CONTROL: u32 = 50013;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_PROGRESSBAR_CONTROL: u32 = 50006;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TOOLBAR_CONTROL: u32 = 50016;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_STATUSBAR_CONTROL: u32 = 50014;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TOOLTIP_CONTROL: u32 = 50015;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_SCROLLBAR_CONTROL: u32 = 50011;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_GROUP_CONTROL: u32 = 50026;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_SEPARATOR_CONTROL: u32 = 50039;

/// Map a UIA control type ID to a semantic role string.
///
/// Returns `"unknown"` for unrecognised control type IDs.
#[cfg_attr(not(windows), allow(dead_code))]
fn control_type_to_role(ctrl_type: u32) -> &'static str {
    match ctrl_type {
        UIA_WINDOW_CONTROL => "window",
        UIA_PANE_CONTROL => "pane",
        UIA_DOCUMENT_CONTROL => "document",
        UIA_EDIT_CONTROL => "edit",
        UIA_BUTTON_CONTROL => "button",
        UIA_CHECKBOX_CONTROL => "checkbox",
        UIA_RADIOBUTTON_CONTROL => "radio",
        UIA_COMBOBOX_CONTROL => "comboBox",
        UIA_LIST_CONTROL => "list",
        UIA_LISTITEM_CONTROL => "listItem",
        UIA_TREE_CONTROL => "tree",
        UIA_TREEITEM_CONTROL => "treeItem",
        UIA_MENUITEM_CONTROL => "menuItem",
        UIA_TEXT_CONTROL => "text",
        UIA_HYPERLINK_CONTROL => "link",
        UIA_TAB_CONTROL => "tab",
        UIA_TABITEM_CONTROL => "tabItem",
        UIA_HEADER_CONTROL => "header",
        UIA_HEADERITEM_CONTROL => "headerItem",
        UIA_TABLE_CONTROL => "table",
        UIA_IMAGE_CONTROL => "image",
        UIA_SLIDER_CONTROL => "slider",
        UIA_PROGRESSBAR_CONTROL => "progressBar",
        UIA_TOOLBAR_CONTROL => "toolBar",
        UIA_STATUSBAR_CONTROL => "statusBar",
        UIA_TOOLTIP_CONTROL => "toolTip",
        UIA_SCROLLBAR_CONTROL => "scrollBar",
        UIA_GROUP_CONTROL => "group",
        UIA_SEPARATOR_CONTROL => "separator",
        _ => "unknown",
    }
}

// ---------------------------------------------------------------------------
// Windows implementation  (windows crate)
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod native {
    use serde_json::{json, Value};

    use super::control_type_to_role;
    use crate::refs::{NativeHandle, RefStore};

    use windows::Win32::Foundation::*;
    use windows::Win32::System::Com::*;
    use windows::Win32::UI::Accessibility::*;

    const MAX_ELEMENTS: usize = 200;

    /// Entry point called from the public stub on cfg(windows).
    pub fn uia_extract(store: &mut RefStore, hwnd: isize) -> Result<Vec<Value>, String> {
        let _com = ComGuard::new()?;

        let uia: IUIAutomation = unsafe {
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("CoCreateInstance IUIAutomation: {e}"))?
        };

        let root = unsafe {
            uia.ElementFromHandle(HWND(hwnd as *mut _))
                .map_err(|e| format!("ElementFromHandle: {e}"))?
        };

        let condition = unsafe {
            uia.CreateTrueCondition()
                .map_err(|e| format!("CreateTrueCondition: {e}"))?
        };

        let found = unsafe {
            root.FindAll(TreeScope_Subtree, &condition)
                .map_err(|e| format!("FindAll: {e}"))?
        };

        let count = unsafe {
            found
                .Length()
                .map_err(|e| format!("ElementArray.Length: {e}"))?
        } as usize;

        let limit = count.min(MAX_ELEMENTS);
        let mut elements = Vec::with_capacity(limit);

        for i in 0..limit {
            let element = unsafe {
                found
                    .GetElement(i as _)
                    .map_err(|e| format!("GetElement({i}): {e}"))?
            };
            if let Some(json_val) = element_to_json(store, &element) {
                elements.push(json_val);
            }
        }

        Ok(elements)
    }

    /// Convert a single UIA element to its JSON representation.
    ///
    /// Returns `None` for elements that are offscreen, zero-sized, or
    /// otherwise uninteresting.
    fn element_to_json(store: &mut RefStore, element: &IUIAutomationElement) -> Option<Value> {
        let ctrl_type = unsafe { element.CurrentControlType().ok()? };
        let role = control_type_to_role(ctrl_type.0 as u32);

        let name = unsafe { element.CurrentName().unwrap_or_default().to_string() };
        let automation_id = unsafe {
            element
                .CurrentAutomationId()
                .unwrap_or_default()
                .to_string()
        };
        let class_name = unsafe { element.CurrentClassName().unwrap_or_default().to_string() };

        // Bounding rectangle.
        let rect = unsafe { element.CurrentBoundingRectangle().ok()? };

        // Skip invisible / offscreen elements.
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w <= 0 || h <= 0 {
            return None;
        }

        let is_offscreen = unsafe {
            element
                .CurrentIsOffscreen()
                .map(|value| value.as_bool())
                .unwrap_or(true)
        };
        if is_offscreen {
            return None;
        }

        // Capabilities.
        let is_enabled = unsafe {
            element
                .CurrentIsEnabled()
                .map(|value| value.as_bool())
                .unwrap_or(true)
        };
        let is_keyboard_focusable = unsafe {
            element
                .CurrentIsKeyboardFocusable()
                .map(|value| value.as_bool())
                .unwrap_or(false)
        };

        // Store the element ref (PR #1 uses a placeholder handle since
        // we do not yet support action execution).
        let eref = store.insert_element(NativeHandle::new(0));

        Some(json!({
            "ref": eref.to_string(),
            "role": role,
            "label": name,
            "automationId": automation_id,
            "className": class_name,
            "bounds": {
                "x": rect.left,
                "y": rect.top,
                "width": w,
                "height": h,
            },
            "capabilities": {
                "isEnabled": is_enabled,
                "isOffscreen": is_offscreen,
                "isKeyboardFocusable": is_keyboard_focusable,
            },
        }))
    }

    // -----------------------------------------------------------------------
    // COM lifetime guard
    // -----------------------------------------------------------------------

    /// Calls `CoInitializeEx` on construction and `CoUninitialize` on drop.
    struct ComGuard;

    impl ComGuard {
        fn new() -> Result<Self, String> {
            // SAFETY: COM must be initialised for the calling thread before
            // any UIA calls.  S_OK (0) and S_FALSE (1) are both success
            // indicators; only a negative HRESULT means failure.
            let hr = unsafe { CoInitializeEx(Some(std::ptr::null()), COINIT_APARTMENTTHREADED) };
            if hr.0 < 0 {
                return Err(format!("CoInitializeEx failed: {:#010x}", hr.0));
            }
            Ok(Self)
        }
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            // SAFETY: each successful CoInitializeEx (including S_FALSE) must
            // be balanced with a CoUninitialize.
            unsafe {
                CoUninitialize();
            }
        }
    }
}

#[cfg(windows)]
use native::uia_extract;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod unit_tests {
    use super::*;
    use crate::refs::NativeHandle;
    use serde_json::json;

    // -- Platform support check (non-Windows) -------------------------------

    #[test]
    #[cfg(not(windows))]
    fn test_extract_elements_empty_on_non_windows() {
        let mut store = RefStore::new();
        let result = extract_elements(&mut store, 0);
        assert!(result.is_empty());
    }

    // -- Role mapping (cross-platform) --------------------------------------

    #[test]
    fn test_control_type_to_role_edit() {
        assert_eq!(control_type_to_role(50004), "edit");
    }

    #[test]
    fn test_control_type_to_role_button() {
        assert_eq!(control_type_to_role(50000), "button");
    }

    #[test]
    fn test_control_type_to_role_checkbox() {
        assert_eq!(control_type_to_role(50002), "checkbox");
    }

    #[test]
    fn test_control_type_to_role_radio() {
        assert_eq!(control_type_to_role(50007), "radio");
    }

    #[test]
    fn test_control_type_to_role_window() {
        assert_eq!(control_type_to_role(50032), "window");
    }

    #[test]
    fn test_control_type_to_role_pane() {
        assert_eq!(control_type_to_role(50033), "pane");
    }

    #[test]
    fn test_control_type_to_role_menu_item() {
        assert_eq!(control_type_to_role(50010), "menuItem");
    }

    #[test]
    fn test_control_type_to_role_list_item() {
        assert_eq!(control_type_to_role(50009), "listItem");
    }

    #[test]
    fn test_control_type_to_role_document() {
        assert_eq!(control_type_to_role(50030), "document");
    }

    #[test]
    fn test_control_type_to_role_unknown() {
        assert_eq!(control_type_to_role(99999), "unknown");
        assert_eq!(control_type_to_role(0), "unknown");
    }

    // -- Element JSON shape (cross-platform) --------------------------------

    #[test]
    fn test_element_json_shape() {
        let mut store = RefStore::new();
        let eref = store.insert_element(NativeHandle::new(0));
        let ref_str = eref.to_string();

        let element = json!({
            "ref": ref_str,
            "role": "edit",
            "label": "Test Label",
            "automationId": "1001",
            "className": "Edit",
            "bounds": {
                "x": 10,
                "y": 20,
                "width": 100,
                "height": 30,
            },
            "capabilities": {
                "isEnabled": true,
                "isOffscreen": false,
                "isKeyboardFocusable": true,
            },
        });

        assert_eq!(element["ref"].as_str(), Some("@e1"));
        assert_eq!(element["role"].as_str(), Some("edit"));
        assert_eq!(element["label"].as_str(), Some("Test Label"));
        assert_eq!(element["automationId"].as_str(), Some("1001"));
        assert_eq!(element["className"].as_str(), Some("Edit"));
        assert!(element["bounds"].is_object());
        assert_eq!(element["bounds"]["x"], 10);
        assert_eq!(element["bounds"]["y"], 20);
        assert_eq!(element["bounds"]["width"], 100);
        assert_eq!(element["bounds"]["height"], 30);
        assert!(element["capabilities"].is_object());
        assert_eq!(element["capabilities"]["isEnabled"], true);
        assert_eq!(element["capabilities"]["isOffscreen"], false);
        assert_eq!(element["capabilities"]["isKeyboardFocusable"], true);
    }

    #[test]
    fn test_ax_targets_response_shape() {
        // Simulate the screenshot response with axTargets.
        let mut store = RefStore::new();
        let eref = store.insert_element(NativeHandle::new(0));
        let ref_str = eref.to_string();

        let response = json!({
            "target": "@w1",
            "capture": {
                "stateId": "s-0",
                "width": 800,
                "height": 600,
                "imageFormat": "png",
                "imageBase64": "dummy",
            },
            "axTargets": [
                {
                    "ref": ref_str,
                    "role": "edit",
                    "label": "Address bar",
                    "automationId": "1001",
                    "className": "Edit",
                    "bounds": { "x": 0, "y": 0, "width": 800, "height": 30 },
                    "capabilities": {
                        "isEnabled": true,
                        "isOffscreen": false,
                        "isKeyboardFocusable": true,
                    },
                }
            ],
            "warnings": [],
        });

        assert_eq!(response["target"].as_str(), Some("@w1"));
        assert!(response["capture"].is_object());
        assert!(response["warnings"].is_array());
        assert!(response["axTargets"].is_array());

        let targets = response["axTargets"].as_array().unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0]["ref"].as_str(), Some("@e1"));
        assert_eq!(targets[0]["role"].as_str(), Some("edit"));
    }
}
