export type RoutedText =
  | { kind: "command"; command: { kind: "new" | "status" | "abort" } }
  | { kind: "message"; text: string };

export function routeIncomingText(text: string): RoutedText {
  const normalized = text.trim();
  if (normalized === "/new") {
    return { kind: "command", command: { kind: "new" } };
  }

  if (normalized === "/status") {
    return { kind: "command", command: { kind: "status" } };
  }

  if (normalized === "/abort") {
    return { kind: "command", command: { kind: "abort" } };
  }

  return { kind: "message", text };
}
