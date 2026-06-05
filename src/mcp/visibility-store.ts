/**
 * 职责: 写入窗口和材料快照，供 MCP 工具只读访问。
 * 关注点:
 * - Bridge turn 开始时写窗口快照，文件接收时写材料快照。
 * - 快照有短 TTL，过期后 MCP 工具返回空状态而不是旧上下文。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

// ============================================================
// Types
// ============================================================

export interface WindowSnapshot {
  as_of: string;
  ttl_seconds: number;
  window: {
    window_key: string;
    chat_type: string;
    mode: string;
    interaction_mode: string;
    active_session_id: string | null;
    bound_sessions: Array<{
      session_id: string;
      short_id: string;
      label: string;
      is_active: boolean;
      last_used_at: string | null;
    }>;
  } | null;
  management_commands: string[];
}

export interface RecentMaterial {
  id: string;
  window_key: string;
  message_id: string;
  file_name: string;
  type: string;
  size: number;
  received_at: string;
  local_path?: string | undefined;
  preview?: string | undefined;
  status: "available" | "expired" | "missing";
}

export interface MaterialsSnapshot {
  as_of: string;
  ttl_seconds: number;
  materials: RecentMaterial[];
  suggested_actions: string[];
}

// ============================================================
// Constants
// ============================================================

const WINDOW_TTL_MS = 5 * 60 * 1000;
const MATERIALS_TTL_MS = 10 * 60 * 1000;
const MAX_MATERIALS = 20;

const SUGGESTED_ACTIONS = [
  "总结主要内容",
  "审查合同风险",
  "提取关键信息",
  "收入知识库",
  "识别发票信息",
];

// ============================================================
// Store
// ============================================================

export class VisibilityStore {
  private readonly windowDir: string;
  private readonly materialsPath: string;

  constructor(private readonly dataDir: string) {
    this.windowDir = path.join(dataDir, "agent-visibility", "current-window");
    this.materialsPath = path.join(dataDir, "agent-visibility", "recent-materials.json");
    mkdirSync(this.windowDir, { recursive: true });
    mkdirSync(path.dirname(this.materialsPath), { recursive: true });
  }

  // ── 窗口快照 ────────────────────────────────────────────

  writeWindowSnapshot(
    sessionId: string,
    snapshot: Omit<WindowSnapshot, "as_of" | "ttl_seconds">,
  ): void {
    const filePath = path.join(this.windowDir, `${sessionId}.json`);
    const full: WindowSnapshot = {
      ...snapshot,
      as_of: new Date().toISOString(),
      ttl_seconds: WINDOW_TTL_MS / 1000,
    };
    writeFileSync(filePath, JSON.stringify(full, null, 2));
  }

  readWindowSnapshot(sessionId?: string): WindowSnapshot | null {
    // 按 sessionId 查找
    if (sessionId) {
      const filePath = path.join(this.windowDir, `${sessionId}.json`);
      return this.readSnapshotIfFresh<WindowSnapshot>(filePath, WINDOW_TTL_MS);
    }
    // 查找最新的有效快照
    try {
      const entries = readdirSyncSafe(this.windowDir);
      let best: WindowSnapshot | null = null;
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const filePath = path.join(this.windowDir, entry);
        const snapshot = this.readSnapshotIfFresh<WindowSnapshot>(filePath, WINDOW_TTL_MS);
        if (snapshot && (!best || (snapshot.as_of ?? "") > (best.as_of ?? ""))) {
          best = snapshot;
        }
      }
      return best;
    } catch {
      return null;
    }
  }

  // ── 材料快照 ────────────────────────────────────────────

  appendMaterial(material: Omit<RecentMaterial, "id" | "status"> & { local_path?: string | undefined }): void {
    const existing = this.readMaterialsSnapshot();
    const materials = existing?.materials ?? [];
    materials.unshift({
      id: `mat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ...material,
      status: "available",
    });
    // 保留最近 MAX_MATERIALS 条
    const trimmed = materials.slice(0, MAX_MATERIALS);
    const snapshot: MaterialsSnapshot = {
      as_of: new Date().toISOString(),
      ttl_seconds: MATERIALS_TTL_MS / 1000,
      materials: trimmed,
      suggested_actions: SUGGESTED_ACTIONS,
    };
    writeFileSync(this.materialsPath, JSON.stringify(snapshot, null, 2));
  }

  readMaterialsSnapshot(options: { window_key?: string } = {}): MaterialsSnapshot | null {
    const snapshot = this.readSnapshotIfFresh<MaterialsSnapshot>(this.materialsPath, MATERIALS_TTL_MS);
    if (!snapshot || !options.window_key) {
      return snapshot;
    }
    return {
      ...snapshot,
      materials: snapshot.materials.filter((material) => material.window_key === options.window_key),
    };
  }

  // ── 内部辅助 ────────────────────────────────────────────

  private readSnapshotIfFresh<T>(filePath: string, ttlMs: number): T | null {
    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as T & { as_of?: string };
      if (parsed.as_of) {
        const age = Date.now() - new Date(parsed.as_of).getTime();
        if (age > ttlMs) return null; // 过期
      }
      return parsed;
    } catch {
      return null;
    }
  }
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
