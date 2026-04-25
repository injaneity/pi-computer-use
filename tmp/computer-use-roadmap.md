# Computer-use roadmap

Running checklist for usability, speed, reliability, and multi-window/multi-agent support.

## Done

- [x] Add `list_apps` tool for running app discovery.
- [x] Add `list_windows` tool for controllable window discovery.

## Next priorities

- [ ] Add stable model-facing window refs, e.g. `@w1`.
- [ ] Allow `screenshot({ window })` to select by explicit window ref/id.
- [ ] Allow optional explicit `window` targeting on action tools.
- [ ] Generalize `captureId` into a broader `stateId` / `stateToken`.
- [ ] Improve stale window/ref/capture errors and recovery guidance.
- [ ] Add per-window write serialization for multi-agent safety.
- [ ] Add `arrange_window` / `set_window_frame` for deterministic layouts.
- [ ] Add optional screenshot mode, e.g. `image: "auto" | "always" | "never"`.
- [ ] Improve action result classification with concise success/failure reasons.
- [ ] Improve scroll target selection and boundary/no-effect reporting.

## Lower priority / likely not useful now

- [ ] Full local HTTP API runtime.
- [ ] Runtime route catalog equivalent to `/v1/routes`.
- [ ] Visible agent cursor overlay.
- [ ] Full base64/path/omit image transport modes beyond Pi attachments.
- [ ] Full projected AX tree by default.
- [ ] Private WindowServer event transport.
- [ ] Heavy verifier pipeline before lightweight result classification is in place.
