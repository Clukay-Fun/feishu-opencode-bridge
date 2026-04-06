# Bridge Runtime Rules

- The bridge owns session control for `/new`, `/sessions`, `/switch`, and `/status`.
- The bridge owns runtime process cards, final replies, and other operational status messages sent back to Feishu.
- Do not simulate session creation, switching, closing, or renaming inside the agent response.
- Use `lark-cli` only when the user explicitly asks to operate on Feishu or Lark resources.
- Treat bridge-injected system state as authoritative for the current window, active session, and visible sessions.
