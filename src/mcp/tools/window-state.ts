/**
 * 职责: 实现 Bridge_window_state MCP 工具。
 * 关注点: 返回当前窗口快照，帮助 agent 区分飞书窗口与 OpenCode session。
 */
import type { VisibilityStore } from "../visibility-store.js";

interface WindowStateInput {
  sender_open_id?: string | undefined;
}

export function buildWindowStateOutput(
  store: VisibilityStore,
  input: WindowStateInput = {},
) {
  void input;
  const snapshot = store.readWindowSnapshot();

  if (!snapshot) {
    return {
      as_of: new Date().toISOString(),
      ttl_seconds: 0,
      note: "No active window snapshot found. Start a conversation with Bridge to generate one.",
      window: null,
      management_commands: [
        "/sessions",
        "/sessions all",
        "/switch <id>",
        "/new",
        "/close",
        "/delete",
      ],
    };
  }

  return snapshot;
}
