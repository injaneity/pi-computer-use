//! State identifier generation.
//!
//! Provides monotonically increasing, globally unique state IDs used
//! to scope discovery sessions and ref stores.

use std::sync::atomic::{AtomicU64, Ordering};

/// Generates unique, monotonically increasing state identifiers.
///
/// Each call to `fresh(prefix)` returns a string of the form
/// `{prefix}-{N}` where `N` is a global counter that never repeats
/// within the lifetime of the helper process.
pub struct StateId;

impl StateId {
    /// Return a new unique identifier starting with `prefix`.
    ///
    /// # Examples
    ///
    /// ```
    /// use windows_bridge::state::StateId;
    ///
    /// let id_a = StateId::fresh("session");
    /// let id_b = StateId::fresh("session");
    /// assert_ne!(id_a, id_b);
    /// assert!(id_a.starts_with("session-"));
    /// ```
    pub fn fresh(prefix: &str) -> String {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        format!("{prefix}-{n}")
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn consecutive_ids_differ() {
        let a = StateId::fresh("test");
        let b = StateId::fresh("test");
        assert_ne!(a, b);
    }

    #[test]
    fn id_contains_prefix() {
        let id = StateId::fresh("foobar");
        assert!(id.starts_with("foobar-"));
    }
}
