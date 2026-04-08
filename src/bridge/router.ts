export type RoutedText =
  | {
    kind: "command";
    command:
      | { kind: "new" }
      | { kind: "status" }
      | { kind: "rename"; label: string }
      | { kind: "close"; index?: number | undefined }
      | { kind: "abort" }
      | { kind: "models"; provider?: string | undefined }
      | { kind: "model-use"; model: string }
      | { kind: "model-reset" }
      | { kind: "leave" }
      | { kind: "who" }
      | { kind: "sessions" }
      | { kind: "sessions-select"; index: number }
      | { kind: "allow"; policy: "once" | "always" }
      | { kind: "deny" }
      | { kind: "invalid"; message: string }
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

  if (rawCommand === "new" && args.length === 0) {
    return { kind: "command", command: { kind: "new" } };
  }
  if (rawCommand === "new") {
    return invalidCommand("用法：/new");
  }

  if (rawCommand === "status" && args.length === 0) {
    return { kind: "command", command: { kind: "status" } };
  }
  if (rawCommand === "status") {
    return invalidCommand("用法：/status");
  }

  if (rawCommand === "current" && args.length === 0) {
    return { kind: "command", command: { kind: "status" } };
  }
  if (rawCommand === "current") {
    return invalidCommand("用法：/current");
  }

  if (rawCommand === "rename" && args.length > 0) {
    return {
      kind: "command",
      command: { kind: "rename", label: args.join(" ").trim() },
    };
  }
  if (rawCommand === "rename") {
    return invalidCommand("用法：/rename <新名称>");
  }

  if (rawCommand === "close" && args.length === 0) {
    return { kind: "command", command: { kind: "close" } };
  }

  if (rawCommand === "close" && args.length === 1 && /^\d+$/.test(args[0] ?? "")) {
    return {
      kind: "command",
      command: { kind: "close", index: Number(args[0]) },
    };
  }
  if (rawCommand === "close") {
    return invalidCommand("用法：/close [编号]");
  }

  if (rawCommand === "delete" && args.length === 0) {
    return { kind: "command", command: { kind: "close" } };
  }

  if (rawCommand === "delete" && args.length === 1 && /^\d+$/.test(args[0] ?? "")) {
    return {
      kind: "command",
      command: { kind: "close", index: Number(args[0]) },
    };
  }
  if (rawCommand === "delete") {
    return invalidCommand("用法：/delete [编号]");
  }

  if (rawCommand === "abort" && args.length === 0) {
    return { kind: "command", command: { kind: "abort" } };
  }
  if (rawCommand === "abort") {
    return invalidCommand("用法：/abort");
  }

  if (rawCommand === "models" && args.length === 0) {
    return { kind: "command", command: { kind: "models" } };
  }
  if (rawCommand === "models" && args.length === 1) {
    return { kind: "command", command: { kind: "models", provider: args[0] } };
  }
  if (rawCommand === "models") {
    return invalidCommand("用法：/models [provider]");
  }

  if (rawCommand === "model" && args.length === 0) {
    return { kind: "command", command: { kind: "models" } };
  }

  if (rawCommand === "model" && args[0] === "use") {
    if (args.length >= 2 && args.slice(1).join(" ").trim().length > 0) {
      return {
        kind: "command",
        command: { kind: "model-use", model: args.slice(1).join(" ").trim() },
      };
    }
    return invalidCommand("用法：/model use <provider/model>");
  }

  if (rawCommand === "model" && args[0] === "reset") {
    if (args.length === 1) {
      return { kind: "command", command: { kind: "model-reset" } };
    }
    return invalidCommand("用法：/model reset");
  }

  if (rawCommand === "model" && args.length === 1) {
    return { kind: "command", command: { kind: "models", provider: args[0] } };
  }
  if (rawCommand === "model") {
    return invalidCommand("用法：/model [provider]\n或：/model use <provider/model>\n或：/model reset");
  }

  if (rawCommand === "leave" && args.length === 0) {
    return { kind: "command", command: { kind: "leave" } };
  }
  if (rawCommand === "leave") {
    return invalidCommand("用法：/leave");
  }

  if (rawCommand === "who" && args.length === 0) {
    return { kind: "command", command: { kind: "who" } };
  }
  if (rawCommand === "who") {
    return invalidCommand("用法：/who");
  }

  if (rawCommand === "sessions" && args.length === 0) {
    return { kind: "command", command: { kind: "sessions" } };
  }

  if (rawCommand === "sessions" && args.length === 1 && /^\d+$/.test(args[0] ?? "")) {
    return {
      kind: "command",
      command: { kind: "sessions-select", index: Number(args[0]) },
    };
  }
  if (rawCommand === "sessions") {
    return invalidCommand("用法：/sessions [编号]");
  }

  if (rawCommand === "switch" && args.length === 1 && /^\d+$/.test(args[0] ?? "")) {
    return {
      kind: "command",
      command: { kind: "sessions-select", index: Number(args[0]) },
    };
  }
  if (rawCommand === "switch") {
    return invalidCommand("用法：/switch <编号>");
  }

  if (rawCommand === "allow" && (args[0] === "once" || args[0] === "always") && args.length === 1) {
    return {
      kind: "command",
      command: { kind: "allow", policy: args[0] },
    };
  }
  if (rawCommand === "allow") {
    return invalidCommand("用法：/allow <once|always>");
  }

  if (rawCommand === "deny" && args.length === 0) {
    return { kind: "command", command: { kind: "deny" } };
  }
  if (rawCommand === "deny") {
    return invalidCommand("用法：/deny");
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

function invalidCommand(message: string): RoutedText {
  return {
    kind: "command",
    command: { kind: "invalid", message },
  };
}
