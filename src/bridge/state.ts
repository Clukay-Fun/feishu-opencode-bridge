export type PendingQuestionInteraction = {
  kind: "question";
  requestId: string;
  sessionId: string;
  questions: Array<{ header: string; question: string }>;
};

export type PendingPermissionInteraction = {
  kind: "permission";
  chatId: string;
  replyToMessageId: string;
  sessionId: string;
  permissionId: string;
  permissionName: string;
  turnId: string;
  expiresAt: number;
};

export type PendingSessionSelectionInteraction = {
  kind: "session-select";
  options: Array<{ index: number; sessionId: string; title: string }>;
  expiresAt: number;
};

export type PendingInteraction =
  | PendingQuestionInteraction
  | PendingPermissionInteraction
  | PendingSessionSelectionInteraction;
