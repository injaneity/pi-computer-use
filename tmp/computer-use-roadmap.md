# Computer-use roadmap

Running checklist for usability, speed, reliability, and multi-window/multi-agent support.

## Done

- [x] Add `list_apps` tool for running app discovery.
- [x] Add `list_windows` tool for controllable window discovery.
- [x] Add stable model-facing window refs, e.g. `@w1`.
- [x] Allow `screenshot({ window })` to select by explicit window ref/id.
- [x] Allow optional explicit `window` targeting on action tools.

## Next priorities

- [x] Add `stateId` for stale state validation.
- [x] Improve stale window/ref/capture errors and recovery guidance.
- [x] Add per-window write serialization for multi-agent safety.
- [x] Add `arrange_window` / `set_window_frame` for deterministic layouts.
- [x] Add optional screenshot mode, e.g. `image: "auto" | "always" | "never"`.
- [x] Improve action result classification with concise success/failure reasons.
- [x] Improve scroll target selection and boundary/no-effect reporting.

## Lower priority / likely not useful now

- [ ] Full local HTTP API runtime.
- [ ] Runtime route catalog equivalent to `/v1/routes`.
- [ ] Visible agent cursor overlay.
- [ ] Full base64/path/omit image transport modes beyond Pi attachments.
- [ ] Full projected AX tree by default.
- [ ] Private WindowServer event transport.
- [ ] Heavy verifier pipeline before lightweight result classification is in place.
