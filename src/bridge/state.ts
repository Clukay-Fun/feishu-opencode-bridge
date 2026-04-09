export type PendingQuestionInteraction = {
  kind: "question";
  requestId: string;
  sessionId: string;
  questions: Array<{ header: string; question: string }>;
};

export type PendingPermissionInteraction = {
  kind: "permission";
  chatId: string;
  conversationKey: string;
  replyToMessageId: string;
  requesterOpenId: string;
  sessionId: string;
  permissionId: string;
  permissionName: string;
  permissionMessageId: string | null;
  permissionVersion: string;
  turnId: string;
  expiresAt: number;
  resolvedAt?: number | undefined;
  resolution?: "once" | "always" | "deny" | "timeout" | undefined;
};

export type PendingSessionSelectionInteraction = {
  kind: "session-select";
  options: Array<{ index: number; sessionId: string; title: string; current?: boolean }>;
  expiresAt: number;
};

export type PendingInteraction =
  | PendingQuestionInteraction
  | PendingPermissionInteraction
  | PendingSessionSelectionInteraction;
