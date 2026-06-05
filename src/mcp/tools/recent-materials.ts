/**
 * 职责: 实现 Bridge_recent_materials MCP 工具。
 * 关注点: 只返回最近材料快照，不读取或解析文件正文。
 */
import type { VisibilityStore } from "../visibility-store.js";

interface RecentMaterialsInput {
  limit?: number | undefined;
  window_key?: string | undefined;
}

export function buildRecentMaterialsOutput(
  store: VisibilityStore,
  input: RecentMaterialsInput = {},
) {
  const windowKey = typeof input.window_key === "string" && input.window_key.trim().length > 0
    ? input.window_key
    : null;
  const snapshot = windowKey
    ? store.readMaterialsSnapshot({ window_key: windowKey })
    : store.readMaterialsSnapshot();

  if (!snapshot) {
    return {
      as_of: new Date().toISOString(),
      ttl_seconds: 0,
      note: "No recent materials found. Upload a file to Bridge to see it here.",
      materials: [],
      suggested_actions: [
        "总结主要内容",
        "审查合同风险",
        "提取关键信息",
        "收入知识库",
        "识别发票信息",
      ],
    };
  }

  const limit = input.limit ?? 5;
  return {
    ...snapshot,
    materials: snapshot.materials.slice(0, limit),
  };
}
