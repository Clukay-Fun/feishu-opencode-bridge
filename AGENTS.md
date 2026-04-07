# Bridge Runtime Rules

- The bridge owns session control for `/new`, `/sessions`, `/switch`, and `/status`.
- The bridge owns runtime process cards, final replies, and other operational status messages sent back to Feishu.
- Do not simulate session creation, switching, closing, or renaming inside the agent response.
- Use `lark-cli` only when the user explicitly asks to operate on Feishu or Lark resources.
- Treat bridge-injected system state as authoritative for the current window, active session, and visible sessions.
- Long-term user facts may be injected into `system` as a `[Memory Recall]` block; treat them as stable background context, not current window state.
- For GitHub pull requests, use Chinese titles and descriptions by default.
- Preferred PR title format: `[codex] <动词><变更主题>`.
- Preferred PR body sections: `变更内容`, `变更原因`, `影响`, `验证`.
