# Changelog

All notable changes to this project will be documented in this file.

The project follows Semantic Versioning.

## 0.1.12 - 2026-04-14

### Added
- Added runtime version exposure through `src/version.ts`, startup logs, and the `/healthz` response.

## 0.1.11 - 2026-04-14

### Fixed
- Fixed fallback final replies so direct markdown responses stay attached to the original Feishu message thread when process cards cannot be created.

## 0.1.10 - 2026-04-14

### Added
- Added persisted active knowledge-ingest session state so in-flight ingest sessions can be restored and tracked separately from normal pending interactions.

### Changed
- Updated knowledge-ingest flow to use session-level queue summaries, queued item processing, and explicit session idle configuration.
- Updated Feishu reply delivery so ingest and permission replies can opt into threaded replies when needed.

## 0.1.9 - 2026-04-14

### Fixed
- Fixed Feishu turn-status cards so tool updates are no longer truncated from the toolbar display.

## 0.1.8 - 2026-04-14

### Fixed
- Fixed knowledge-flow tests so CI does not require a real OpenCode server on `127.0.0.1:4096`.

## 0.1.7 - 2026-04-14

### Added
- Added a file-intent follow-up flow so uploaded files outside ingest mode can be processed as normal OpenCode turns.
- Added tests for non-legal text fallback while knowledge mode is enabled and ordinary chat during background ingest.

### Changed
- Updated knowledge ingestion to process long documents in batches instead of truncating to the first `maxExtractChunks` chunks.
- Made legal question and web-ingest detection more conservative to reduce accidental knowledge-mode routing.

## 0.1.6 - 2026-04-13

### Added
- Added a regression test covering dedicated ingest-session creation and previous-session restore on `/kb-ingest-end`.

## 0.1.5 - 2026-04-13

### Added
- Added staged extraction persistence so interrupted knowledge-base ingest jobs can resume from completed chunks.
- Added retry handling and coverage for transient OpenCode extraction interruptions.

### Changed
- Reused semantic-dedupe embeddings during knowledge-base writes to avoid duplicate embedding requests.
- Added chunk-limit warnings and ingest-session state needed for safer long-running knowledge ingestion.

## 0.1.4 - 2026-04-13

### Added
- Added knowledge-base commands, mode switching, ingest progress cards, and legal-query result cards in bridge runtime.
- Added end-to-end tests for knowledge-mode routing, file ingest flow, and knowledge-base message handling.
- Added README documentation for knowledge-base usage and required Feishu Bitable permissions.

### Changed
- Extended session-window state to track interaction mode and persist knowledge-mode selection across command flows.

## 0.1.3 - 2026-04-13

### Added
- Added knowledge base parser, SQLite storage, embedding retrieval, and Feishu Bitable sync primitives.
- Added knowledge base config schema, sample config, and Feishu/OpenCode resource helpers needed by ingestion.
- Added doctor output for Obsidian sync readiness and tests covering knowledge-base/config compatibility.

### Changed
- Unified shared embedding provider configuration under `embeddings.*`, while keeping legacy memory settings compatible.
- Marked macOS shell entrypoints as executable for direct launch.

## 0.1.2 - 2026-04-12

### Added
- Added OpenCode provider auth and model availability checks to `doctor` / `onboard`.
- Added onboarding tests for `lark-cli auth login`, `opencode providers login`, and start-offer flow.
- Added an actionable runtime fallback hint for missing or expired OpenCode provider credentials.

### Changed
- Updated onboarding to prompt for provider login and optional stack startup when the environment is nearly ready.

## 0.1.1 - 2026-04-12

### Added
- Added `npm run onboard`, `npm run doctor`, and cross-platform setup/start entrypoints.
- Added environment diagnosis and onboarding helper scripts for OpenCode and `lark-cli`.
- Added script-focused tests for health checks, onboarding, startup, and setup entrypoints.

### Changed
- Updated `npm start` to launch `dist/src/index.js` so the built entry matches the current TypeScript output layout.
- Updated logger daily rotation to use the local calendar date instead of UTC.
- Renamed and reorganized planning documents for onboarding and solution ideas.
