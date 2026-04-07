export type RoutedText =
  | {
    kind: "command";
    command:
      | { kind: "new" }
      | { kind: "status" }
      | { kind: "abort" }
      | { kind: "models" }
      | { kind: "leave" }
      | { kind: "who" }
      | { kind: "sessions" }
      | { kind: "sessions-select"; index: number }
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

  if (rawCommand === "new" && args.length === 0) {
    return { kind: "command", command: { kind: "new" } };
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

  if (rawCommand === "leave" && args.length === 0) {
    return { kind: "command", command: { kind: "leave" } };
  }

  if (rawCommand === "who" && args.length === 0) {
    return { kind: "command", command: { kind: "who" } };
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

  if (rawCommand === "switch" && args.length === 1 && /^\d+$/.test(args[0] ?? "")) {
    return {
      kind: "command",
      command: { kind: "sessions-select", index: Number(args[0]) },
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
  const trimmed = text.trim();
  if (trimmed.startsWith("/")) {
    return trimmed;
  }

  const mentionWrapped = trimmed.match(/^@(.+)\s+(\/\S[\s\S]*)$/);
  if (!mentionWrapped) {
    return trimmed;
  }

  return mentionWrapped[2]?.trim() ?? trimmed;
}
