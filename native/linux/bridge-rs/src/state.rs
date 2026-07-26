use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::atspi::{AccessibleRef, NodeSnapshot, RootSnapshot};
use crate::{ErrorCode, ProtocolError};

pub const MAX_LOOK_RECORDS: usize = 8;

#[derive(Debug, Clone)]
pub struct LookRecord {
    pub root: RootSnapshot,
    pub nodes: HashMap<String, NodeSnapshot>,
    pub image_width: u16,
    pub image_height: u16,
}

#[derive(Debug, Default)]
pub struct HelperState {
    roots: HashMap<String, RootSnapshot>,
    root_refs: HashMap<AccessibleRef, String>,
    looks: HashMap<String, LookRecord>,
    look_order: VecDeque<String>,
    next_root: u64,
    next_look: u64,
}

impl HelperState {
    pub fn replace_roots(&mut self, roots: Vec<RootSnapshot>) -> Vec<(String, RootSnapshot)> {
        let mut next = HashMap::new();
        let mut result = Vec::with_capacity(roots.len());
        for root in roots {
            let reference = self
                .root_refs
                .get(&root.accessible)
                .cloned()
                .unwrap_or_else(|| {
                    self.next_root += 1;
                    format!("@w{}", self.next_root)
                });
            self.root_refs
                .insert(root.accessible.clone(), reference.clone());
            next.insert(reference.clone(), root.clone());
            result.push((reference, root));
        }
        self.roots = next;
        self.root_refs
            .retain(|_, reference| self.roots.contains_key(reference));
        result
    }

    pub fn root(&self, reference: &str) -> Option<RootSnapshot> {
        self.roots.get(reference).cloned()
    }

    pub fn roots(&self) -> Vec<(String, RootSnapshot)> {
        let mut roots = self
            .roots
            .iter()
            .map(|(reference, root)| (reference.clone(), root.clone()))
            .collect::<Vec<_>>();
        roots.sort_by(|a, b| a.0.cmp(&b.0));
        roots
    }

    pub fn insert_look(
        &mut self,
        root: RootSnapshot,
        raw_nodes: Vec<NodeSnapshot>,
        base: Option<&LookRecord>,
    ) -> (String, Vec<NodeSnapshot>) {
        self.next_look += 1;
        let look_id = format!("look_{}", self.next_look);
        let mut nodes = base.map(|record| record.nodes.clone()).unwrap_or_default();
        let existing_refs = base
            .map(|record| {
                record
                    .nodes
                    .values()
                    .map(|node| (node.accessible.clone(), node.reference.clone()))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        let mut output = Vec::with_capacity(raw_nodes.len());
        for (index, mut node) in raw_nodes.into_iter().enumerate() {
            node.reference = existing_refs
                .get(&node.accessible)
                .cloned()
                .unwrap_or_else(|| format!("linux:{look_id}:@e{}", index + 1));
            nodes.insert(node.reference.clone(), node.clone());
            output.push(node);
        }
        let (image_width, image_height) = base
            .map(|record| (record.image_width, record.image_height))
            .or_else(|| {
                root.frame.as_ref().map(|frame| {
                    (
                        frame.width.max(1).min(i32::from(u16::MAX)) as u16,
                        frame.height.max(1).min(i32::from(u16::MAX)) as u16,
                    )
                })
            })
            .unwrap_or((1, 1));
        self.looks.insert(
            look_id.clone(),
            LookRecord {
                root,
                nodes,
                image_width,
                image_height,
            },
        );
        self.look_order.push_back(look_id.clone());
        while self.look_order.len() > MAX_LOOK_RECORDS {
            if let Some(expired) = self.look_order.pop_front() {
                self.looks.remove(&expired);
            }
        }
        (look_id, output)
    }

    pub fn set_look_image_size(
        &mut self,
        look_id: &str,
        width: u16,
        height: u16,
    ) -> Result<(), ProtocolError> {
        let record = self.looks.get_mut(look_id).ok_or_else(|| {
            ProtocolError::new("Owning look is no longer available", ErrorCode::StaleLook)
        })?;
        record.image_width = width.max(1);
        record.image_height = height.max(1);
        Ok(())
    }

    pub fn scope(
        &self,
        reference: &str,
        base_look_id: Option<&str>,
    ) -> Result<(LookRecord, NodeSnapshot), ProtocolError> {
        if let Some(look_id) = base_look_id {
            let record = self.look(look_id)?;
            let node = record.nodes.get(reference).cloned().ok_or_else(|| {
                ProtocolError::new("Scope ref is not owned by baseLookId", ErrorCode::StaleRef)
            })?;
            return Ok((record, node));
        }
        self.look_order
            .iter()
            .rev()
            .filter_map(|look_id| self.looks.get(look_id))
            .find_map(|record| {
                record
                    .nodes
                    .get(reference)
                    .cloned()
                    .map(|node| (record.clone(), node))
            })
            .ok_or_else(|| ProtocolError::new("Scope ref is stale", ErrorCode::StaleRef))
    }

    pub fn look(&self, look_id: &str) -> Result<LookRecord, ProtocolError> {
        self.looks.get(look_id).cloned().ok_or_else(|| {
            ProtocolError::new("Owning look is no longer available", ErrorCode::StaleLook)
        })
    }

    pub fn element(&self, look_id: &str, reference: &str) -> Result<NodeSnapshot, ProtocolError> {
        self.look(look_id)?
            .nodes
            .get(reference)
            .cloned()
            .ok_or_else(|| ProtocolError::new("Element reference is stale", ErrorCode::StaleRef))
    }
}

pub fn fresh_state_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!("w-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accessible(n: usize) -> AccessibleRef {
        AccessibleRef {
            destination: format!(":1.{n}"),
            path: format!("/node/{n}"),
        }
    }

    fn root(n: usize) -> RootSnapshot {
        RootSnapshot {
            accessible: accessible(n),
            pid: n as u64,
            name: format!("root {n}"),
            app_name: format!("app {n}"),
            role: "frame".into(),
            frame: None,
            x11_window: None,
            is_focused: false,
            is_minimized: false,
            z_order: None,
        }
    }

    #[test]
    fn root_refs_are_stable_and_dead_roots_are_removed() {
        let mut state = HelperState::default();
        let first = state.replace_roots(vec![root(1), root(2)]);
        let second = state.replace_roots(vec![root(2)]);
        assert_eq!(first[1].0, second[0].0);
        assert!(state.root(&first[0].0).is_none());
    }

    #[test]
    fn look_history_is_bounded_and_refs_are_look_scoped() {
        let mut state = HelperState::default();
        let mut first = String::new();
        for n in 0..=MAX_LOOK_RECORDS {
            let node = NodeSnapshot::minimal(accessible(n));
            let (look, nodes) = state.insert_look(root(n), vec![node], None);
            if n == 0 {
                first = look.clone();
            }
            assert!(nodes[0].reference.starts_with(&format!("linux:{look}:")));
        }
        assert_eq!(state.look(&first).unwrap_err().code, ErrorCode::StaleLook);
    }

    #[test]
    fn scoped_look_requires_scope_ref_owned_by_base_look() {
        let mut state = HelperState::default();
        let (first, first_nodes) =
            state.insert_look(root(1), vec![NodeSnapshot::minimal(accessible(10))], None);
        let (second, _) =
            state.insert_look(root(1), vec![NodeSnapshot::minimal(accessible(20))], None);
        assert_eq!(
            state
                .scope(&first_nodes[0].reference, Some(&second))
                .unwrap_err()
                .code,
            ErrorCode::StaleRef
        );
        assert_eq!(
            state
                .scope(&first_nodes[0].reference, Some(&first))
                .unwrap()
                .1
                .accessible,
            accessible(10)
        );
    }

    #[test]
    fn scoped_look_carries_base_records_and_reuses_known_refs() {
        let mut state = HelperState::default();
        let mut parent = NodeSnapshot::minimal(accessible(10));
        let mut child = NodeSnapshot::minimal(accessible(11));
        child.parent = Some(parent.accessible.clone());
        let (base_id, base_nodes) = state.insert_look(root(1), vec![parent.clone(), child], None);
        let base = state.look(&base_id).unwrap();
        parent.name = "updated".into();
        let (scoped_id, scoped_nodes) = state.insert_look(root(1), vec![parent], Some(&base));
        assert_eq!(scoped_nodes[0].reference, base_nodes[0].reference);
        assert_eq!(
            state
                .element(&scoped_id, &base_nodes[1].reference)
                .unwrap()
                .accessible,
            accessible(11)
        );
        assert_eq!(
            state
                .element(&scoped_id, &base_nodes[0].reference)
                .unwrap()
                .name,
            "updated"
        );
    }

    #[test]
    fn scoped_look_preserves_base_image_size() {
        let mut state = HelperState::default();
        let node = NodeSnapshot::minimal(accessible(10));
        let (base_id, _) = state.insert_look(root(1), vec![node.clone()], None);
        state.set_look_image_size(&base_id, 1000, 500).unwrap();
        let base = state.look(&base_id).unwrap();
        let (scoped_id, _) = state.insert_look(root(1), vec![node], Some(&base));
        let scoped = state.look(&scoped_id).unwrap();
        assert_eq!((scoped.image_width, scoped.image_height), (1000, 500));
    }
}
