//! Window and element reference store.
//!
//! Maps monotonically increasing display-form references (`@w1`, `@e2`, …)
//! to native window handles and owned marshalled UIA references. Each `State`
//! should get its own `RefStore` so that references remain scoped to a
//! single discovery session.

use std::collections::{HashMap, HashSet};
use std::fmt;

/// A marshalled UIA reference, owned by its discovery store or look record.
#[cfg(windows)]
pub type UiaElement = windows::core::AgileReference<
    windows::Win32::UI::Accessibility::IUIAutomationElement,
>;
#[cfg(not(windows))]
#[derive(Clone, Debug)]
pub struct UiaElement;

/// An opaque native handle (e.g., HWND).
///
/// Kept inside helper memory; never serialized to JSON.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NativeHandle(isize);

impl NativeHandle {
    /// Wrap a raw handle value.
    pub fn new(raw: isize) -> Self {
        Self(raw)
    }

    /// Return the raw handle value.
    pub fn raw(self) -> isize {
        self.0
    }
}

// ---------------------------------------------------------------------------
// WindowRef
// ---------------------------------------------------------------------------

/// A reference to a discovered window.
///
/// Display form is `@wN` where `N` is a monotonically increasing,
/// 1-indexed integer scoped to a `RefStore`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WindowRef {
    pub(crate) id: u64,
}

impl fmt::Display for WindowRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "@w{}", self.id)
    }
}

impl WindowRef {
    /// Parse a display-form window reference (e.g. `"@w1"`) into a `WindowRef`.
    ///
    /// Returns `None` if the string does not match the expected pattern.
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        if !s.starts_with("@w") {
            return None;
        }
        let num_part = &s[2..];
        let id: u64 = num_part.parse().ok()?;
        Some(WindowRef { id })
    }
}

// ---------------------------------------------------------------------------
// ElementRef
// ---------------------------------------------------------------------------

/// A reference to a discovered UIA element.
///
/// Display form is `@eN` where `N` is a monotonically increasing,
/// 1-indexed integer scoped to a `RefStore`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ElementRef {
    pub(crate) id: u64,
}

impl fmt::Display for ElementRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "@e{}", self.id)
    }
}

// ---------------------------------------------------------------------------
// RefStore
// ---------------------------------------------------------------------------

/// An owned store of window handles and marshalled element references.
///
/// Assigns monotonically increasing, 1-indexed references.  Each
/// discovery state should hold its own `RefStore` so that reference
/// numbering is scoped to that state.
#[derive(Debug, Clone)]
pub struct RefStore {
    next_window_id: u64,
    next_element_id: u64,
    windows: HashMap<u64, NativeHandle>,
    window_ids: HashMap<NativeHandle, u64>,
    elements: HashMap<u64, (NativeHandle, Option<UiaElement>)>,
}

impl RefStore {
    /// Create an empty store with counters starting at 1.
    pub fn new() -> Self {
        Self {
            next_window_id: 1,
            next_element_id: 1,
            windows: HashMap::new(),
            window_ids: HashMap::new(),
            elements: HashMap::new(),
        }
    }

    /// Insert a window native handle and return its `WindowRef`.
    pub fn insert_window(&mut self, handle: NativeHandle) -> WindowRef {
        if let Some(id) = self.window_ids.get(&handle).copied() {
            return WindowRef { id };
        }
        let id = self.next_window_id;
        self.next_window_id += 1;
        self.windows.insert(id, handle);
        self.window_ids.insert(handle, id);
        WindowRef { id }
    }

    /// Insert a UIA element native handle and return its `ElementRef`.
    pub fn insert_element(&mut self, handle: NativeHandle) -> ElementRef {
        let id = self.next_element_id;
        self.next_element_id += 1;
        self.elements.insert(id, (handle, None));
        ElementRef { id }
    }

    /// Look up the native handle for a previously-returned `WindowRef`.
    ///
    /// Returns `None` if the ref did not originate from this store.
    pub fn get_window(&self, wref: &WindowRef) -> Option<NativeHandle> {
        self.windows.get(&wref.id).copied()
    }

    /// Look up the native handle for a previously-returned `ElementRef`.
    ///
    /// Returns `None` if the ref did not originate from this store.
    pub fn get_element(&self, eref: &ElementRef) -> Option<NativeHandle> {
        self.elements.get(&eref.id).map(|(handle, _)| *handle)
    }

    /// Retain the observed COM object without sharing an apartment-bound pointer.
    #[cfg(windows)]
    pub fn insert_uia_element(
        &mut self,
        element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    ) -> windows::core::Result<ElementRef> {
        let retained = UiaElement::new(element)?;
        let eref = self.insert_element(NativeHandle::new(0));
        self.elements.get_mut(&eref.id).unwrap().1 = Some(retained);
        Ok(eref)
    }

    /// Clone the agile reference into the owning look, before this store is dropped.
    pub fn get_uia_element(&self, reference: &str) -> Option<UiaElement> {
        let id = reference.strip_prefix("@e")?.parse::<u64>().ok()?;
        self.elements.get(&id)?.1.clone()
    }

    /// Keep only the currently discoverable windows while preserving refs for
    /// HWNDs that remain live. This makes repeated discovery stable and bounded.
    pub fn retain_window_refs<'a>(&mut self, refs: impl IntoIterator<Item = &'a str>) {
        let live = refs
            .into_iter()
            .filter_map(WindowRef::parse)
            .map(|reference| reference.id)
            .collect::<HashSet<_>>();
        self.windows.retain(|id, _| live.contains(id));
        self.window_ids.retain(|_, id| live.contains(id));
    }
}

impl Default for RefStore {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn window_ref_display() {
        let w = WindowRef { id: 1 };
        assert_eq!(w.to_string(), "@w1");
        let w = WindowRef { id: 42 };
        assert_eq!(w.to_string(), "@w42");
    }

    #[test]
    fn element_ref_display() {
        let e = ElementRef { id: 1 };
        assert_eq!(e.to_string(), "@e1");
        let e = ElementRef { id: 7 };
        assert_eq!(e.to_string(), "@e7");
    }

    #[test]
    fn native_handle_roundtrip() {
        let h = NativeHandle::new(0xBAD);
        assert_eq!(h.raw(), 0xBAD);
    }

    #[test]
    fn window_ref_parse_valid() {
        let w = WindowRef::parse("@w1").expect("should parse @w1");
        assert_eq!(w.to_string(), "@w1");
    }

    #[test]
    fn window_ref_parse_valid_high_number() {
        let w = WindowRef::parse("@w42").expect("should parse @w42");
        assert_eq!(w.to_string(), "@w42");
    }

    #[test]
    fn window_ref_parse_invalid_no_at() {
        assert!(WindowRef::parse("w1").is_none());
    }

    #[test]
    fn window_ref_parse_invalid_wrong_prefix() {
        assert!(WindowRef::parse("@x1").is_none());
    }

    #[test]
    fn window_ref_parse_invalid_empty() {
        assert!(WindowRef::parse("").is_none());
    }

    #[test]
    fn window_ref_parse_invalid_non_numeric() {
        assert!(WindowRef::parse("@wabc").is_none());
    }

    #[test]
    fn window_ref_parse_roundtrip() {
        // Verify that display-then-parse recovers the original id.
        for id in &[1u64, 5, 100] {
            let w = WindowRef { id: *id };
            let s = w.to_string();
            let parsed = WindowRef::parse(&s).expect("roundtrip parse");
            assert_eq!(parsed.id, *id);
        }
    }
}
