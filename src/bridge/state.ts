export type PendingQuestionInteraction = {
  kind: "question";
  turnId: string;
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
  options: Array<{ index: number; sessionId: string; title: string; current?: boolean; inWindow?: boolean }>;
  expiresAt: number;
};

export type PendingSessionDeleteConfirmationInteraction = {
  kind: "session-delete-confirm";
  index?: number | undefined;
  indices?: number[] | undefined;
  rangeLabel?: string | undefined;
  sessionId?: string | undefined;
  title?: string | undefined;
  all?: boolean | undefined;
  sessionIds?: string[] | undefined;
  titles?: string[] | undefined;
  expiresAt: number;
};

export type PendingKnowledgeIngestInteraction = {
  kind: "knowledge-ingest-await-file";
  chatId: string;
  conversationKey: string;
  requesterOpenId: string;
  replyToMessageId: string;
  ingestSessionId?: string | undefined;
  previousActiveSessionId?: string | null | undefined;
};

export type PendingInteraction =
  | PendingQuestionInteraction
  | PendingPermissionInteraction
  | PendingSessionSelectionInteraction
  | PendingSessionDeleteConfirmationInteraction
  | PendingKnowledgeIngestInteraction;
