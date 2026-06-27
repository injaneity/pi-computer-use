use windows_bridge::state::StateId;

// ---------------------------------------------------------------------------
// Fresh state IDs
// ---------------------------------------------------------------------------

#[test]
fn test_two_fresh_state_ids_differ() {
    let id1 = StateId::fresh("session");
    let id2 = StateId::fresh("session");
    assert_ne!(id1, id2, "two fresh state IDs must differ");
}

#[test]
fn test_fresh_state_id_contains_prefix() {
    let id = StateId::fresh("test");
    assert!(
        id.starts_with("test-"),
        "state ID should start with prefix followed by '-'"
    );
}

#[test]
fn test_fresh_ids_are_unique_across_calls() {
    let mut ids = Vec::new();
    for _ in 0..100 {
        ids.push(StateId::fresh("batch"));
    }
    let mut sorted = ids.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), ids.len(), "all 100 fresh IDs must be unique");
}
