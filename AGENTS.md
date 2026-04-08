# Bridge Runtime Rules

- The bridge owns session control for `/new`, `/sessions`, `/switch`, and `/status`.
- The bridge owns runtime process cards, final replies, and other operational status messages sent back to Feishu.
- Follow the Feishu output Markdown rules in `docs/feishu-markdown.md`.
- Plain Post is only for passthrough text output, ultra-short confirmations, and card fallback. Bridge-owned commands, structured lists, and system notices must use cards instead.
- Do not simulate session creation, switching, closing, or renaming inside the agent response.
- Use `lark-cli` only when the user explicitly asks to operate on Feishu or Lark resources.
- Treat bridge-injected system state as authoritative for the current window, active session, and visible sessions.
- For GitHub pull requests, use Chinese titles and descriptions by default.
- Preferred PR title format: `[codex] <动词><变更主题>`.
- Preferred PR body sections: `变更内容`, `变更原因`, `影响`, `验证`.
- Keep updating the same branch and PR while the related feature line is still open and unmerged.
- Once a PR has been merged into `main`, do not reopen or reuse it for follow-up work; create a new branch and a new PR instead.
