/**
 * 职责: 将飞书原始文本解析为结构化命令，或保留为普通透传消息。
 * 关注点:
 * - 清理群聊中的 @mention 前缀等输入噪音。
 * - 识别桥接层支持的斜杠命令并返回判别联合类型。
 * - 对未识别输入稳定降级为 passthrough。
 */
export type RoutedText =
  | {
    kind: "command";
    command:
      | { kind: "new"; title?: string | undefined }
      | { kind: "rename"; title: string }
      | { kind: "status" }
      | { kind: "cost" }
      | { kind: "abort" }
      | { kind: "models"; provider?: string | undefined }
      | { kind: "model-use"; model: string }
      | { kind: "model-reset" }
      | { kind: "help" }
      | { kind: "button-test" }
      | { kind: "knowledge-query"; question: string; explicit?: boolean | undefined }
      | { kind: "knowledge-ingest" }
      | { kind: "knowledge-ingest-end" }
      | { kind: "knowledge-mode-start" }
      | { kind: "knowledge-mode-end" }
      | { kind: "sessions" }
      | { kind: "sessions-all"; query?: string | undefined }
      | { kind: "sessions-select"; index?: number | undefined; query?: string | undefined }
      | { kind: "close"; index?: number | undefined; range?: { start: number; end: number } | undefined; all?: boolean | undefined }
      | { kind: "delete"; index?: number | undefined; sessionId?: string | undefined; range?: { start: number; end: number } | undefined; all?: boolean | undefined; confirm: boolean }
      | { kind: "allow"; policy: "once" | "always" }
      | { kind: "deny" }
      | { kind: "passthrough"; name: string; arguments: string[] };
  }
  | { kind: "message"; text: string };

/** 解析一条飞书文本消息，识别桥接命令或普通消息。 */
export function routeIncomingText(text: string): RoutedText {
  const normalized = normalizeCommandCandidate(text);
  if (!normalized.startsWith("/")) {
    return { kind: "message", text };
  }
  if (normalized.includes("\n")) {
    return { kind: "message", text };
  }

  const parts = normalized.split(/\s+/);
  const rawCommand = parts[0]?.slice(1) ?? "";
  const args = parts.slice(1);

  if (rawCommand === "new") {
    return {
      kind: "command",
      command: args.length > 0 ? { kind: "new", title: args.join(" ").trim() } : { kind: "new" },
    };
  }

  if ((rawCommand === "rename" || rawCommand === "title") && args.length > 0) {
    return {
      kind: "command",
      command: { kind: "rename", title: args.join(" ").trim() },
    };
  }

  if (rawCommand === "status" && args.length === 0) {
    return { kind: "command", command: { kind: "status" } };
  }

  if (rawCommand === "cost" && args.length === 0) {
    return { kind: "command", command: { kind: "cost" } };
  }

  if (rawCommand === "abort" && args.length === 0) {
    return { kind: "command", command: { kind: "abort" } };
  }

  if (rawCommand === "models" && args.length === 0) {
    return { kind: "command", command: { kind: "models" } };
  }

  if (rawCommand === "models" && args.length === 1 && !["use", "reset"].includes(args[0] ?? "")) {
    return { kind: "command", command: { kind: "models", provider: args[0] } };
  }

  if (rawCommand === "model" && args[0] === "use") {
    return { kind: "command", command: { kind: "model-use", model: args.length === 2 ? args[1] ?? "" : "" } };
  }

  if (rawCommand === "model" && args.length === 1 && args[0] === "reset") {
    return { kind: "command", command: { kind: "model-reset" } };
  }

  if (["允许一次", "仅此一次"].includes(rawCommand) && args.length === 0) {
    return { kind: "command", command: { kind: "allow", policy: "once" } };
  }

  if (["始终允许", "总是允许"].includes(rawCommand) && args.length === 0) {
    return { kind: "command", command: { kind: "allow", policy: "always" } };
  }

  if (rawCommand === "拒绝" && args.length === 0) {
    return { kind: "command", command: { kind: "deny" } };
  }

  if (["help", "commands", "指令", "帮助"].includes(rawCommand) && args.length === 0) {
    return { kind: "command", command: { kind: "help" } };
  }

  if ((rawCommand === "button-test" || rawCommand === "callback-test") && args.length === 0) {
    return { kind: "command", command: { kind: "button-test" } };
  }

  if ((rawCommand === "知识入库" || rawCommand === "kb-ingest" || rawCommand === "kb-ingest-start") && args.length === 0) {
    return { kind: "command", command: { kind: "knowledge-ingest" } };
  }

  if ((rawCommand === "知识入库结束" || rawCommand === "知识入库完成" || rawCommand === "kb-ingest-end") && args.length === 0) {
    return { kind: "command", command: { kind: "knowledge-ingest-end" } };
  }

  if ((rawCommand === "法律问答" || rawCommand === "kb-query") && args.length > 0) {
    return { kind: "command", command: { kind: "knowledge-query", question: args.join(" ").trim(), explicit: true } };
  }

  if (rawCommand === "sessions" && args.length === 0) {
    return { kind: "command", command: { kind: "sessions" } };
  }

  if (rawCommand === "sessions" && args.length === 1 && args[0] === "all") {
    return { kind: "command", command: { kind: "sessions-all" } };
  }

  if (rawCommand === "sessions" && args.length > 1 && args[0] === "all") {
    return { kind: "command", command: { kind: "sessions-all", query: args.slice(1).join(" ").trim() } };
  }

  if (rawCommand === "sessions" && args.length > 1 && args[0] === "find") {
    return { kind: "command", command: { kind: "sessions-all", query: args.slice(1).join(" ").trim() } };
  }

  if (rawCommand === "sessions" && args.length === 1 && /^\d+$/.test(args[0] ?? "")) {
    return {
      kind: "command",
      command: { kind: "sessions-select", index: Number(args[0]) },
    };
  }

  if (rawCommand === "switch" && args.length === 1 && /^\d+$/.test(args[0] ?? "")) {
    return {
      kind: "command",
      command: { kind: "sessions-select", index: Number(args[0]) },
    };
  }

  if (rawCommand === "switch" && args.length > 0) {
    return {
      kind: "command",
      command: { kind: "sessions-select", query: args.join(" ").trim() },
    };
  }

  if (rawCommand === "close" && args.length === 0) {
    return {
      kind: "command",
      command: { kind: "close" },
    };
  }

  if (rawCommand === "close" && args.length === 1 && args[0] === "all") {
    return {
      kind: "command",
      command: { kind: "close", all: true },
    };
  }

  if (rawCommand === "close" && args.length === 1 && /^\d+$/.test(args[0] ?? "")) {
    return {
      kind: "command",
      command: { kind: "close", index: Number(args[0]) },
    };
  }

  if (rawCommand === "close" && args.length === 1 && /^\d+-\d+$/.test(args[0] ?? "")) {
    const rangeArg = args[0];
    if (!rangeArg) {
      return { kind: "message", text };
    }
    const parts = rangeArg.split("-");
    const start = Number(parts[0] ?? "0");
    const end = Number(parts[1] ?? "0");
    return {
      kind: "command",
      command: { kind: "close", range: { start, end } },
    };
  }

  if (rawCommand === "delete" && args.length === 0) {
    return {
      kind: "command",
      command: { kind: "delete", confirm: false },
    };
  }

  if (rawCommand === "delete" && args.length === 1 && args[0] === "all") {
    return {
      kind: "command",
      command: { kind: "delete", all: true, confirm: false },
    };
  }

  if (rawCommand === "delete" && args.length === 2 && args[0] === "all" && args[1] === "confirm") {
    return {
      kind: "command",
      command: { kind: "delete", all: true, confirm: true },
    };
  }

  if (rawCommand === "delete" && args.length === 1 && args[0] === "confirm") {
    return {
      kind: "command",
      command: { kind: "delete", confirm: true },
    };
  }

  if (rawCommand === "delete" && args.length === 1 && /^\d+$/.test(args[0] ?? "")) {
    return {
      kind: "command",
      command: { kind: "delete", index: Number(args[0]), confirm: false },
    };
  }

  if (rawCommand === "delete" && args.length === 1 && /^\d+-\d+$/.test(args[0] ?? "")) {
    const rangeArg = args[0];
    if (!rangeArg) {
      return { kind: "message", text };
    }
    const parts = rangeArg.split("-");
    const start = Number(parts[0] ?? "0");
    const end = Number(parts[1] ?? "0");
    return {
      kind: "command",
      command: { kind: "delete", range: { start, end }, confirm: false },
    };
  }

  if (rawCommand === "delete" && args.length === 1 && args[0]) {
    return {
      kind: "command",
      command: { kind: "delete", sessionId: args[0], confirm: false },
    };
  }

  if (rawCommand === "delete" && args.length === 2 && /^\d+$/.test(args[0] ?? "") && args[1] === "confirm") {
    return {
      kind: "command",
      command: { kind: "delete", index: Number(args[0]), confirm: true },
    };
  }

  if (rawCommand === "delete" && args.length === 2 && /^\d+-\d+$/.test(args[0] ?? "") && args[1] === "confirm") {
    const rangeArg = args[0];
    if (!rangeArg) {
      return { kind: "message", text };
    }
    const parts = rangeArg.split("-");
    const start = Number(parts[0] ?? "0");
    const end = Number(parts[1] ?? "0");
    return {
      kind: "command",
      command: { kind: "delete", range: { start, end }, confirm: true },
    };
  }

  if (rawCommand === "delete" && args.length === 2 && args[0] && args[1] === "confirm") {
    return {
      kind: "command",
      command: { kind: "delete", sessionId: args[0], confirm: true },
    };
  }

  if (rawCommand === "allow" && (args[0] === "once" || args[0] === "always") && args.length === 1) {
    return {
      kind: "command",
      command: { kind: "allow", policy: args[0] },
    };
  }

  if (rawCommand === "deny" && args.length === 0) {
    return { kind: "command", command: { kind: "deny" } };
  }

  return {
    kind: "command",
    command: {
      kind: "passthrough",
      name: rawCommand,
      arguments: args,
    },
  };
}

function normalizeCommandCandidate(text: string): string {
  const trimmed = stripVisibleMentionPrefix(text.trim());
  if (trimmed.startsWith("/")) {
    return trimmed;
  }

  const mentionWrapped = trimmed.match(/^@(.+)\s+(\/\S[\s\S]*)$/);
  if (!mentionWrapped) {
    return trimmed;
  }

  return mentionWrapped[2]?.trim() ?? trimmed;
}

function stripVisibleMentionPrefix(text: string): string {
  const match = text.match(/^@.+?\s+(\/.+)$/);
  return match?.[1]?.trim() ?? text;
}
