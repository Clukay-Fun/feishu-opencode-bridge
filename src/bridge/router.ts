export type RoutedText =
  | {
    kind: "command";
    command:
      | { kind: "new"; title?: string | undefined }
      | { kind: "rename"; title: string }
      | { kind: "status" }
      | { kind: "abort" }
      | { kind: "models"; provider?: string | undefined }
      | { kind: "leave" }
      | { kind: "who" }
      | { kind: "knowledge-query"; question: string; explicit?: boolean | undefined }
      | { kind: "knowledge-ingest" }
      | { kind: "knowledge-ingest-end" }
      | { kind: "knowledge-mode-start" }
      | { kind: "knowledge-mode-end" }
      | { kind: "sessions" }
      | { kind: "sessions-all" }
      | { kind: "sessions-select"; index?: number | undefined; query?: string | undefined }
      | { kind: "close"; index?: number | undefined; range?: { start: number; end: number } | undefined; all?: boolean | undefined }
      | { kind: "delete"; index?: number | undefined; range?: { start: number; end: number } | undefined; all?: boolean | undefined; confirm: boolean }
      | { kind: "allow"; policy: "once" | "always" }
      | { kind: "deny" }
      | { kind: "passthrough"; name: string; arguments: string[] };
  }
  | { kind: "message"; text: string };

export function routeIncomingText(text: string): RoutedText {
  const normalized = normalizeCommandCandidate(text);
  if (!normalized.startsWith("/")) {
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

  if (rawCommand === "abort" && args.length === 0) {
    return { kind: "command", command: { kind: "abort" } };
  }

  if (rawCommand === "models" && args.length === 0) {
    return { kind: "command", command: { kind: "models" } };
  }

  if (rawCommand === "models" && args.length === 1 && !["use", "reset"].includes(args[0] ?? "")) {
    return { kind: "command", command: { kind: "models", provider: args[0] } };
  }

  if (rawCommand === "leave" && args.length === 0) {
    return { kind: "command", command: { kind: "leave" } };
  }

  if (rawCommand === "who" && args.length === 0) {
    return { kind: "command", command: { kind: "who" } };
  }

  if ((rawCommand === "知识入库" || rawCommand === "kb-ingest" || rawCommand === "kb-ingest-start") && args.length === 0) {
    return { kind: "command", command: { kind: "knowledge-ingest" } };
  }

  if (rawCommand === "kb-ingest-end" && args.length === 0) {
    return { kind: "command", command: { kind: "knowledge-ingest-end" } };
  }

  if (rawCommand === "法律咨询开始" && args.length === 0) {
    return { kind: "command", command: { kind: "knowledge-mode-start" } };
  }

  if (rawCommand === "法律咨询结束" && args.length === 0) {
    return { kind: "command", command: { kind: "knowledge-mode-end" } };
  }

  if (rawCommand === "法律咨询" && args.length > 0) {
    return { kind: "command", command: { kind: "knowledge-query", question: args.join(" ").trim() } };
  }

  if (rawCommand === "kb-query" && args.length > 0) {
    return { kind: "command", command: { kind: "knowledge-query", question: args.join(" ").trim(), explicit: true } };
  }

  if (rawCommand === "sessions" && args.length === 0) {
    return { kind: "command", command: { kind: "sessions" } };
  }

  if (rawCommand === "sessions" && args.length === 1 && args[0] === "all") {
    return { kind: "command", command: { kind: "sessions-all" } };
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
