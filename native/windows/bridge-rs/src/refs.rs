//! Window and element reference store.
//!
//! Maps monotonically increasing display-form references (`@w1`, `@e2`, …)
//! to opaque native handles (HWND, UIA element pointer).  Each `State`
//! should get its own `RefStore` so that references remain scoped to a
//! single discovery session.

use std::fmt;

/// An opaque native handle (e.g., HWND or UIA element pointer).
///
/// Kept inside helper memory; never serialized to JSON.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

/// An owned store of window and element native handles.
///
/// Assigns monotonically increasing, 1-indexed references.  Each
/// discovery state should hold its own `RefStore` so that reference
/// numbering is scoped to that state.
#[derive(Debug, Clone)]
pub struct RefStore {
    next_window_id: u64,
    next_element_id: u64,
    windows: Vec<NativeHandle>,
    elements: Vec<NativeHandle>,
}

impl RefStore {
    /// Create an empty store with counters starting at 1.
    pub fn new() -> Self {
        Self {
            next_window_id: 1,
            next_element_id: 1,
            windows: Vec::new(),
            elements: Vec::new(),
        }
    }

    /// Insert a window native handle and return its `WindowRef`.
    pub fn insert_window(&mut self, handle: NativeHandle) -> WindowRef {
        let id = self.next_window_id;
        self.next_window_id += 1;
        self.windows.push(handle);
        WindowRef { id }
    }

    /// Insert a UIA element native handle and return its `ElementRef`.
    pub fn insert_element(&mut self, handle: NativeHandle) -> ElementRef {
        let id = self.next_element_id;
        self.next_element_id += 1;
        self.elements.push(handle);
        ElementRef { id }
    }

    /// Look up the native handle for a previously-returned `WindowRef`.
    ///
    /// Returns `None` if the ref did not originate from this store.
    pub fn get_window(&self, wref: &WindowRef) -> Option<NativeHandle> {
        let idx = (wref.id as usize).checked_sub(1)?;
        self.windows.get(idx).copied()
    }

    /// Look up the native handle for a previously-returned `ElementRef`.
    ///
    /// Returns `None` if the ref did not originate from this store.
    pub fn get_element(&self, eref: &ElementRef) -> Option<NativeHandle> {
        let idx = (eref.id as usize).checked_sub(1)?;
        self.elements.get(idx).copied()
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
