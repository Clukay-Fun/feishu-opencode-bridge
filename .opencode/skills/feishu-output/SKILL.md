---
name: feishu-output
description: Use when writing user-visible output for feishu-opencode-bridge that will render in Feishu cards or Plain Post, including final replies, operational notices, command results, architecture walkthroughs, and code review summaries.
compatibility: opencode
metadata:
  project: feishu-opencode-bridge
  reference: docs/feishu-markdown.md
---

# Feishu Output Skill

Use this skill whenever your response will be rendered by `feishu-opencode-bridge` in Feishu.

The full reference is `docs/feishu-markdown.md`. This file is the compact, model-facing version.

## Core Rules

- Use `###` headings for long-form sections.
- Do not use `#` or `##` headings in card body content.
- Keep paragraphs short and direct.
- Put one blank line before each `###` heading.
- Use `---` between long logical sections.
- Use `**bold**` for emphasis.
- Use backticks for commands, paths, IDs, env vars, and inline code.
- Use fenced code blocks with a language tag for multi-line code, commands, call chains, and data flow.
- Use `[label](url)` links. Do not paste bare URLs.
- Use `-` for unordered lists. Do not use `*` list markers.
- Use ordered lists only for steps or numbered choices.
- Do not use HTML tags, image Markdown, footnotes, task lists, table alignment markers, italic, underline, `#`, or `##`.

## Long Bridge Output

For architecture walkthroughs, project summaries, review explanations, and other long output:

- Use `###` section headings.
- Keep each section roughly one screen.
- Render call chains as fenced code blocks with indentation.
- Do not explain call chains in a single dense paragraph.
- Do not inline file paths or line numbers into narrative paragraphs.
- Put paths in their own sentence, list item, or final reference block.
- Use short sentences.

Example:

```text
Feishu event
  -> ws handleEvent()
  -> app handleIncomingMessage()
  -> route command or conversation
  -> run turn
  -> update Feishu card
```

## Code Blocks

- Preserve fenced code block content exactly.
- Do not HTML-escape arrows inside fenced code blocks.
- `->` must remain `->`, not `-&gt;`.
- Put one blank line before and after code blocks.

## Tables

- Use tables only for compact multi-field data.
- Keep tables to four columns or fewer.
- Do not use alignment markers like `:---:` or `---:`.
- Escape table pipes in cell content when needed.

## Tone

- Use a calm operational tone.
- Completion states should start with `已`.
- In-progress states should start with `正在`.
- Current-state notices should start with `当前`.
- Prefer direct next steps such as `发送 /sessions 查看列表`.
- Do not use exclamation marks.
- Do not say `抱歉`.
- Do not say `请注意`.
- Do not over-explain obvious causes.

## Plain Post

Use Plain Post only for passthrough text, ultra-short confirmations, and card fallback.

Bridge-owned commands, structured lists, operational status, and system notices should use cards instead.

## Emoji

Emoji are status markers, not decoration. Avoid emoji unless the bridge output context explicitly needs a status marker.

Allowed status meanings:

- ⚙️ processing.
- ✅ success or completed.
- ❌ error or failed.
- ⚠️ warning or reminder.
- ℹ️ information or empty state.
- 🔐 permission request.
- ⏹ aborted.
- ⏱ elapsed time.
- ⏳ queued.
