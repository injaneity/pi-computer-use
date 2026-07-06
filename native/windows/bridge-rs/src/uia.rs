//! Read-only UIA (UI Automation) element extraction for Windows.
//!
//! On Windows, uses the [`windows`] crate to walk the UIA accessibility tree
//! of a given top-level window and extract semantic elements with their
//! properties.  On non-Windows platforms all entry points are stubbed out
//! and return empty results.
//!
//! UIA element extraction for model-visible outlines and element metadata.

use serde_json::Value;

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

#[derive(Clone, Debug, Default)]
pub struct ElementAnnotationSignals {
    pub invoke: bool,
    pub toggle: bool,
    pub selection_item: bool,
    pub expand_collapse: bool,
    pub legacy_default_action: bool,
    pub value: bool,
    pub text: bool,
    pub value_read_only: Option<bool>,
}

pub fn annotation_can_press(signals: &ElementAnnotationSignals) -> bool {
    signals.invoke
        || signals.toggle
        || signals.selection_item
        || signals.expand_collapse
        || signals.legacy_default_action
}

pub fn annotation_can_set_text(signals: &ElementAnnotationSignals) -> bool {
    signals.value && !signals.value_read_only.unwrap_or(false) || signals.text
}

// ---------------------------------------------------------------------------
// Windows implementation  (windows crate)
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod native {
    use serde_json::{json, Value};

    use super::{
        annotation_can_press, annotation_can_set_text, control_type_to_role,
        ElementAnnotationSignals,
    };
    use crate::refs::{NativeHandle, RefStore};

    use windows::core::{BSTR, VARIANT};
    use windows::Win32::Foundation::*;
    use windows::Win32::System::Com::*;
    use windows::Win32::System::Ole::{
        SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound,
    };
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

    fn runtime_id(element: &IUIAutomationElement) -> Option<Vec<i32>> {
        let array = unsafe { element.GetRuntimeId().ok()? };
        if array.is_null() {
            return None;
        }
        let lower = unsafe { SafeArrayGetLBound(array, 1).ok()? };
        let upper = unsafe { SafeArrayGetUBound(array, 1).ok()? };
        let mut values = Vec::with_capacity((upper - lower + 1).max(0) as usize);
        for index in lower..=upper {
            let mut value = 0i32;
            unsafe {
                SafeArrayGetElement(
                    array,
                    &index,
                    &mut value as *mut i32 as *mut core::ffi::c_void,
                )
                .ok()?;
            }
            values.push(value);
        }
        Some(values)
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
        let runtime_id = runtime_id(element).unwrap_or_default();
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
        let value_pattern = unsafe {
            element
                .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .ok()
        };
        let value = value_pattern
            .as_ref()
            .and_then(|pattern| unsafe { pattern.CurrentValue().ok() })
            .map(|value| value.to_string())
            .unwrap_or_default();
        let value_read_only = value_pattern
            .as_ref()
            .and_then(|pattern| unsafe { pattern.CurrentIsReadOnly().ok() })
            .map(|read_only| read_only.as_bool());
        let signals = ElementAnnotationSignals {
            invoke: pattern_available(element, UIA_IsInvokePatternAvailablePropertyId),
            toggle: pattern_available(element, UIA_IsTogglePatternAvailablePropertyId),
            selection_item: pattern_available(
                element,
                UIA_IsSelectionItemPatternAvailablePropertyId,
            ),
            expand_collapse: pattern_available(
                element,
                UIA_IsExpandCollapsePatternAvailablePropertyId,
            ),
            legacy_default_action: legacy_default_action_available(element),
            value: pattern_available(element, UIA_IsValuePatternAvailablePropertyId),
            text: pattern_available(element, UIA_IsTextPatternAvailablePropertyId),
            value_read_only,
        };
        let can_press = annotation_can_press(&signals);
        let can_set_value = annotation_can_set_text(&signals);
        let can_scroll = pattern_available(element, UIA_IsScrollPatternAvailablePropertyId);

        let eref = store.insert_element(NativeHandle::new(0));

        Some(json!({
            "ref": eref.to_string(),
            "role": role,
            "label": name,
            "automationId": automation_id,
            "runtimeId": runtime_id,
            "className": class_name,
            "value": value,
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
                "canInvoke": signals.invoke,
                "canPress": can_press,
                "canSetValue": can_set_value,
                "canScroll": can_scroll,
            },
        }))
    }

    pub fn read_live_text(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
    ) -> Result<String, String> {
        let (_com, _uia, element) = resolve(hwnd, runtime_id_target, automation_id)?;
        Ok(read_text_from_element(&element))
    }

    pub fn live_elements(hwnd: isize) -> Result<Vec<Value>, String> {
        let mut store = RefStore::new();
        uia_extract(&mut store, hwnd)
    }

    pub struct ElementSnapshot {
        pub rect: (f64, f64, f64, f64),
        pub runtime_id: Vec<i32>,
    }

    pub enum PressResult {
        Invoked,
        Toggled(bool),
        Selected(bool),
        Expanded,
        LegacyDefaultAction,
        NoPattern,
    }

    pub enum SetTextResult {
        Set { value: String },
        NoPattern,
    }

    pub enum ScrollResult {
        Scrolled,
        NoPattern,
    }

    pub fn snapshot(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
    ) -> Result<ElementSnapshot, String> {
        let (_com, _uia, element) = resolve(hwnd, runtime_id_target, automation_id)?;
        let rect = unsafe {
            element
                .CurrentBoundingRectangle()
                .map_err(|e| format!("CurrentBoundingRectangle: {e}"))?
        };
        Ok(ElementSnapshot {
            rect: (
                f64::from(rect.left),
                f64::from(rect.top),
                f64::from(rect.right - rect.left),
                f64::from(rect.bottom - rect.top),
            ),
            runtime_id: runtime_id(&element).unwrap_or_default(),
        })
    }

    pub fn press(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
    ) -> Result<PressResult, String> {
        let (_com, _uia, element) = resolve(hwnd, runtime_id_target, automation_id)?;
        if let Ok(pattern) = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
        } {
            unsafe {
                pattern.Invoke().map_err(|e| format!("Invoke: {e}"))?;
            }
            return Ok(PressResult::Invoked);
        }
        if let Ok(pattern) = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
        } {
            unsafe {
                pattern.Toggle().map_err(|e| format!("Toggle: {e}"))?;
            }
            let state = unsafe {
                pattern
                    .CurrentToggleState()
                    .map(|s| s.0 != 0)
                    .unwrap_or(false)
            };
            return Ok(PressResult::Toggled(state));
        }
        if let Ok(pattern) = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                UIA_SelectionItemPatternId,
            )
        } {
            unsafe {
                pattern.Select().map_err(|e| format!("Select: {e}"))?;
            }
            let selected = unsafe {
                pattern
                    .CurrentIsSelected()
                    .map(|b| b.as_bool())
                    .unwrap_or(false)
            };
            return Ok(PressResult::Selected(selected));
        }
        if let Ok(pattern) = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                UIA_ExpandCollapsePatternId,
            )
        } {
            unsafe {
                pattern.Expand().map_err(|e| format!("Expand: {e}"))?;
            }
            return Ok(PressResult::Expanded);
        }
        if let Ok(pattern) = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(
                UIA_LegacyIAccessiblePatternId,
            )
        } {
            let default_action = unsafe {
                pattern
                    .CurrentDefaultAction()
                    .map(|s| s.to_string())
                    .unwrap_or_default()
            };
            if !default_action.trim().is_empty() {
                unsafe {
                    pattern
                        .DoDefaultAction()
                        .map_err(|e| format!("DoDefaultAction: {e}"))?;
                }
                return Ok(PressResult::LegacyDefaultAction);
            }
        }
        Ok(PressResult::NoPattern)
    }

    fn pattern_available(element: &IUIAutomationElement, property_id: UIA_PROPERTY_ID) -> bool {
        unsafe {
            element
                .GetCurrentPropertyValue(property_id)
                .ok()
                .and_then(|value| bool::try_from(&value).ok())
                .unwrap_or(false)
        }
    }

    fn legacy_default_action_available(element: &IUIAutomationElement) -> bool {
        if !pattern_available(element, UIA_IsLegacyIAccessiblePatternAvailablePropertyId) {
            return false;
        }
        unsafe {
            element
                .GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(
                    UIA_LegacyIAccessiblePatternId,
                )
                .ok()
                .and_then(|pattern| pattern.CurrentDefaultAction().ok())
                .map(|action| !action.to_string().trim().is_empty())
                .unwrap_or(false)
        }
    }

    pub fn set_text(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
        text: &str,
    ) -> Result<SetTextResult, String> {
        let (_com, _uia, element) = resolve(hwnd, runtime_id_target, automation_id)?;
        if let Ok(pattern) =
            unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
        {
            let value = BSTR::from(text);
            unsafe {
                pattern
                    .SetValue(&value)
                    .map_err(|e| format!("SetValue: {e}"))?;
            }
            let value = unsafe {
                pattern
                    .CurrentValue()
                    .map(|s| s.to_string())
                    .unwrap_or_default()
            };
            return Ok(SetTextResult::Set { value });
        }
        Ok(SetTextResult::NoPattern)
    }

    pub fn focus(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
    ) -> Result<(), String> {
        let (_com, _uia, element) = resolve(hwnd, runtime_id_target, automation_id)?;
        unsafe { element.SetFocus().map_err(|e| format!("SetFocus: {e}")) }
    }

    pub fn scroll(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
        x: f64,
        y: f64,
    ) -> Result<ScrollResult, String> {
        let (_com, _uia, element) = resolve(hwnd, runtime_id_target, automation_id)?;
        if let Ok(pattern) = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
        } {
            let horizontal = if x > 0.0 {
                ScrollAmount_SmallIncrement
            } else if x < 0.0 {
                ScrollAmount_SmallDecrement
            } else {
                ScrollAmount_NoAmount
            };
            let vertical = if y > 0.0 {
                ScrollAmount_SmallIncrement
            } else if y < 0.0 {
                ScrollAmount_SmallDecrement
            } else {
                ScrollAmount_NoAmount
            };
            unsafe {
                pattern
                    .Scroll(horizontal, vertical)
                    .map_err(|e| format!("Scroll: {e}"))?;
            }
            return Ok(ScrollResult::Scrolled);
        }
        Ok(ScrollResult::NoPattern)
    }

    pub fn occlusion_ok(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
        x: f64,
        y: f64,
    ) -> Result<bool, String> {
        let (_com, uia, target) = resolve(hwnd, runtime_id_target, automation_id)?;
        let hit = unsafe {
            uia.ElementFromPoint(POINT {
                x: x.round() as i32,
                y: y.round() as i32,
            })
            .map_err(|e| format!("ElementFromPoint: {e}"))?
        };
        let target_id = runtime_id(&target).unwrap_or_default();
        let hit_id = runtime_id(&hit).unwrap_or_default();
        if !target_id.is_empty() && target_id == hit_id {
            return Ok(true);
        }
        let walker = unsafe {
            uia.ControlViewWalker()
                .map_err(|e| format!("ControlViewWalker: {e}"))?
        };
        Ok(is_ancestor(&walker, &target_id, hit) || is_ancestor(&walker, &hit_id, target))
    }

    fn is_ancestor(
        walker: &IUIAutomationTreeWalker,
        ancestor_id: &[i32],
        mut element: IUIAutomationElement,
    ) -> bool {
        if ancestor_id.is_empty() {
            return false;
        }
        for _ in 0..64 {
            let Some(parent) = (unsafe { walker.GetParentElement(&element).ok() }) else {
                return false;
            };
            let parent_id = runtime_id(&parent).unwrap_or_default();
            if parent_id == ancestor_id {
                return true;
            }
            element = parent;
        }
        false
    }

    fn resolve(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
    ) -> Result<(ComGuard, IUIAutomation, IUIAutomationElement), String> {
        let com = ComGuard::new()?;
        let uia: IUIAutomation = unsafe {
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("CoCreateInstance IUIAutomation: {e}"))?
        };
        let root = unsafe {
            uia.ElementFromHandle(HWND(hwnd as *mut _))
                .map_err(|e| format!("ElementFromHandle: {e}"))?
        };
        if runtime_id(&root).as_deref() == Some(runtime_id_target) {
            return Ok((com, uia, root));
        }
        // UIA RuntimeId is exposed as a SAFEARRAY and is not reliably accepted by
        // CreatePropertyCondition across providers/windows-rs VARIANT conversion,
        // so use AutomationId as the fast server-side lookup when available and
        // keep RuntimeId as the authoritative equality check/fallback scan.
        if !automation_id.is_empty() {
            let value = VARIANT::from(automation_id);
            if let Ok(condition) =
                unsafe { uia.CreatePropertyCondition(UIA_AutomationIdPropertyId, &value) }
            {
                if let Ok(element) = unsafe { root.FindFirst(TreeScope_Subtree, &condition) } {
                    if runtime_id(&element).as_deref() == Some(runtime_id_target)
                        || runtime_id_target.is_empty()
                    {
                        return Ok((com, uia, element));
                    }
                    let candidate_id = unsafe {
                        element
                            .CurrentAutomationId()
                            .unwrap_or_default()
                            .to_string()
                    };
                    if candidate_id == automation_id && runtime_id_target.is_empty() {
                        return Ok((com, uia, element));
                    }
                }
            }
        }

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
        };
        let mut automation_fallback = None;
        for i in 0..count {
            let element = unsafe {
                found
                    .GetElement(i)
                    .map_err(|e| format!("GetElement({i}): {e}"))?
            };
            if runtime_id(&element).as_deref() == Some(runtime_id_target) {
                return Ok((com, uia, element));
            }
            if !automation_id.is_empty() {
                let candidate_id = unsafe {
                    element
                        .CurrentAutomationId()
                        .unwrap_or_default()
                        .to_string()
                };
                if candidate_id == automation_id && automation_fallback.is_none() {
                    automation_fallback = Some(element);
                }
            }
        }
        if let Some(element) = automation_fallback {
            return Ok((com, uia, element));
        }
        Err("Element reference is stale".to_owned())
    }

    fn read_text_from_element(element: &IUIAutomationElement) -> String {
        if let Ok(pattern) =
            unsafe { element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) }
        {
            if let Ok(range) = unsafe { pattern.DocumentRange() } {
                if let Ok(value) = unsafe { range.GetText(-1) } {
                    let text = value.to_string();
                    if !text.is_empty() {
                        return text;
                    }
                }
            }
        }
        if let Ok(pattern) =
            unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
        {
            if let Ok(value) = unsafe { pattern.CurrentValue() } {
                let text = value.to_string();
                if !text.is_empty() {
                    return text;
                }
            }
        }
        unsafe { element.CurrentName().unwrap_or_default().to_string() }
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
pub use native::{
    focus, live_elements, occlusion_ok, press, read_live_text, scroll, set_text, snapshot,
    uia_extract, ElementSnapshot, PressResult, ScrollResult, SetTextResult,
};

#[cfg(not(windows))]
#[derive(Clone, Debug)]
pub struct ElementSnapshot {
    pub rect: (f64, f64, f64, f64),
    pub runtime_id: Vec<i32>,
}
#[cfg(not(windows))]
pub enum PressResult {
    Invoked,
    Toggled(bool),
    Selected(bool),
    Expanded,
    LegacyDefaultAction,
    NoPattern,
}
#[cfg(not(windows))]
pub enum SetTextResult {
    Set { value: String },
    NoPattern,
}
#[cfg(not(windows))]
pub enum ScrollResult {
    Scrolled,
    NoPattern,
}
#[cfg(not(windows))]
pub fn read_live_text(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
) -> Result<String, String> {
    Err("UIA is only supported on Windows".to_owned())
}
#[cfg(not(windows))]
pub fn live_elements(_hwnd: isize) -> Result<Vec<Value>, String> {
    Ok(Vec::new())
}
#[cfg(not(windows))]
pub fn snapshot(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
) -> Result<ElementSnapshot, String> {
    Err("UIA is only supported on Windows".to_owned())
}
#[cfg(not(windows))]
pub fn press(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
) -> Result<PressResult, String> {
    Err("UIA is only supported on Windows".to_owned())
}
#[cfg(not(windows))]
pub fn set_text(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
    _text: &str,
) -> Result<SetTextResult, String> {
    Err("UIA is only supported on Windows".to_owned())
}
#[cfg(not(windows))]
pub fn focus(_hwnd: isize, _runtime_id: &[i32], _automation_id: &str) -> Result<(), String> {
    Err("UIA is only supported on Windows".to_owned())
}
#[cfg(not(windows))]
pub fn scroll(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
    _x: f64,
    _y: f64,
) -> Result<ScrollResult, String> {
    Err("UIA is only supported on Windows".to_owned())
}
#[cfg(not(windows))]
pub fn occlusion_ok(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
    _x: f64,
    _y: f64,
) -> Result<bool, String> {
    Err("UIA is only supported on Windows".to_owned())
}

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
            "runtimeId": [42, 7, 9],
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
        let runtime_id = element["runtimeId"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_i64().unwrap() as i32)
            .collect::<Vec<_>>();
        assert_eq!(runtime_id, vec![42, 7, 9]);
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
    fn pressability_annotation_matrix_matches_grounding_ladder() {
        let base = ElementAnnotationSignals::default();
        assert!(!annotation_can_press(&base));

        let cases = [
            ElementAnnotationSignals {
                invoke: true,
                ..base.clone()
            },
            ElementAnnotationSignals {
                toggle: true,
                ..base.clone()
            },
            ElementAnnotationSignals {
                selection_item: true,
                ..base.clone()
            },
            ElementAnnotationSignals {
                expand_collapse: true,
                ..base.clone()
            },
            ElementAnnotationSignals {
                legacy_default_action: true,
                ..base.clone()
            },
        ];
        for signals in cases {
            assert!(annotation_can_press(&signals));
        }
    }

    #[test]
    fn text_editable_annotation_matrix_matches_set_text_grounding() {
        assert!(!annotation_can_set_text(
            &ElementAnnotationSignals::default()
        ));
        assert!(annotation_can_set_text(&ElementAnnotationSignals {
            value: true,
            value_read_only: Some(false),
            ..Default::default()
        }));
        assert!(!annotation_can_set_text(&ElementAnnotationSignals {
            value: true,
            value_read_only: Some(true),
            ..Default::default()
        }));
        assert!(annotation_can_set_text(&ElementAnnotationSignals {
            text: true,
            ..Default::default()
        }));
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
