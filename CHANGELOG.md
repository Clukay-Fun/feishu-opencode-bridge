# Changelog

All notable project-level changes should be recorded in this file.

This project follows Semantic Versioning in a lightweight form:

- `major`: incompatible runtime, config, or behavior change
- `minor`: backward-compatible feature or capability expansion
- `patch`: backward-compatible fix, compatibility update, or docs-only release

## Unreleased

- No unreleased entries yet.

## 0.2.0 - 2026-04-11

### Added

- Window-level session control for `single` and `multi` modes.
- Long-term memory recall with retriever selection, SQLite storage, and Obsidian profile sync.
- Group whitelist binding, session command cards, and model command interaction.
- Runtime modularization, startup preflight, CI workflow, container/deploy baseline, and richer project docs.

### Changed

- Feishu card action callback parsing and permission handling are more robust.
- Logging now supports level filtering, transcript toggles, console/color switches, and daily rotation.
- `/healthz` now reports the bridge version together with runtime health metadata.

### Fixed

- Permission callback compatibility and timeout handling during card actions.
- Runtime fallback behavior when process cards cannot be created.
- Feishu tenant token reuse and concurrent token refresh handling.
