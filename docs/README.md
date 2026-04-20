# Documentation Index

This directory separates current operating documents from historical records.

Use the current documents first. Archive files are retained for context and should not override the active architecture baseline or guidelines.

## Current Entry Points

- [Architecture baseline](architecture-baseline.md): post-freeze runtime boundaries, extension seams, and reviewer rules.
- [Deployment](deploy.md): local/server deployment, environment variables, Caddy, health checks, and validation steps.
- [Feishu Markdown rules](feishu-markdown.md): Markdown formatting rules for Feishu-facing bridge output.
- [Observability event schema](observability/event-schema.md): stable event names and log fields for runtime observability.

## Guidelines

- [New feature checklist](guidelines/new-feature-checklist.md): PR self-check for feature work after framework freeze.
- [Issue writing standard](guidelines/issue-writing-standard.md): GitHub issue title/body conventions.

## Modules

- [Knowledge base](modules/knowledge-base.md): legal knowledge-base module design and workflow notes.
- [Contract assistant](modules/contract-assistant.md): contract assistant module design and workflow notes.

## Backlog

- [Compatibility cleanup](backlog/compatibility-cleanup.md): compatibility debt that remains useful for future cleanup.
- [Post-freeze backlog](backlog/post-freeze-backlog.md): future work tracked after framework freeze.

## Archive

- `archive/design-history/`: historical design notes, migration records, and one-off implementation plans.
- `archive/demo/`: demo scripts, command examples, packaging strategy, and demo-specific flow notes.
- `archive/qa/`: manual validation notes and QA records.
- `archive/qa-and-submission/`: freeze acceptance, PR split plans, and submission-era materials.
- `archive/overview/`: older project overview snapshots.

Archive documents may contain historical paths such as `docs/plans/...`.
Do not treat those paths as current references unless an active document points to them.
