/**
 * 职责: 提供 Bridge MCP stdio server。
 * 关注点:
 * - 由 OpenCode 独立进程启动，暴露只读 Bridge 状态工具。
 * - stdout 只输出 JSON-RPC，日志只能写 stderr。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SafeStoreAccess } from "./safe-store-access.js";
import { buildSchedulerStatusOutput } from "./tools/scheduler-status.js";
import { buildWindowStateOutput } from "./tools/window-state.js";
import { buildRecentMaterialsOutput } from "./tools/recent-materials.js";
import { VisibilityStore } from "./visibility-store.js";

export async function startMcpServer(dataDir: string): Promise<void> {
  const server = new McpServer(
    { name: "bridge-mcp", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const store = new SafeStoreAccess(dataDir);
  const visibilityStore = new VisibilityStore(dataDir);

  // ── Bridge_scheduler_status ─────────────────────────────

  server.registerTool(
    "Bridge_scheduler_status",
    {
      title: "Bridge scheduler status",
      description:
        "Returns a read-only snapshot of the Bridge scheduler state. Call again after /cron add/pause/resume/delete or after task run to get fresh data.",
      inputSchema: {
        include_recent_runs: z
          .boolean()
          .optional()
          .describe("Include recent failed/error run records in the snapshot."),
        creator_user_id: z
          .string()
          .optional()
          .describe("Optional Feishu open_id filter for jobs created by a specific user."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const output = buildSchedulerStatusOutput(store, normalizeSchedulerStatusInput(input));
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err}` }],
          isError: true,
        };
      }
    },
  );

  // ── Bridge_window_state ──────────────────────────────────

  server.registerTool(
    "Bridge_window_state",
    {
      title: "Bridge window state",
      description:
        "Returns a read-only snapshot of the current Bridge window state including bound sessions. Useful when user asks about current session, window, or conversation context.",
      inputSchema: {
        sender_open_id: z
          .string()
          .optional()
          .describe("Optional sender open_id to filter window context."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const output = buildWindowStateOutput(visibilityStore, {
          sender_open_id: typeof input.sender_open_id === "string" ? input.sender_open_id : undefined,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err}` }],
          isError: true,
        };
      }
    },
  );

  // ── Bridge_recent_materials ──────────────────────────────

  server.registerTool(
    "Bridge_recent_materials",
    {
      title: "Bridge recent materials",
      description:
        "Returns recently received files/materials from the current Bridge session. Useful when user says 'summarize that PDF' or 'review the contract from earlier'.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum number of materials to return (default 5, max 20)."),
        window_key: z
          .string()
          .optional()
          .describe("Optional window key filter."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const output = buildRecentMaterialsOutput(visibilityStore, {
          limit: typeof input.limit === "number" ? input.limit : undefined,
          window_key: typeof input.window_key === "string" ? input.window_key : undefined,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err}` }],
          isError: true,
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Logs go to stderr to not interfere with JSON-RPC on stdout
  process.stderr.write("Bridge MCP server started on stdio\n");
}

function normalizeSchedulerStatusInput(input: {
  include_recent_runs?: boolean | undefined;
  creator_user_id?: string | undefined;
}): { include_recent_runs?: boolean; creator_user_id?: string } {
  const normalized: { include_recent_runs?: boolean; creator_user_id?: string } = {};
  if (typeof input.include_recent_runs === "boolean") {
    normalized.include_recent_runs = input.include_recent_runs;
  }
  if (typeof input.creator_user_id === "string" && input.creator_user_id.trim().length > 0) {
    normalized.creator_user_id = input.creator_user_id;
  }
  return normalized;
}
