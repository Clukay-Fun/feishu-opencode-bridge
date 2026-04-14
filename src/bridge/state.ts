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
  chatType: string;
  conversationKey: string;
  requesterOpenId: string;
  replyToMessageId: string;
  rootMessageId: string;
  anchorMessageId: string;
  deliveryMode: "group_thread" | "p2p_reply";
  ingestSessionId?: string | undefined;
  previousActiveSessionId?: string | null | undefined;
  expiresAt: number;
};

export type PendingLaborAnalysisInteraction = {
  kind: "labor-analysis-await-input";
  chatId: string;
  chatType: string;
  conversationKey: string;
  requesterOpenId: string;
  replyToMessageId: string;
  rootMessageId: string;
  anchorMessageId: string;
  deliveryMode: "group_thread" | "p2p_reply";
  caseTitle?: string | undefined;
  materials: Array<{
    sourceFile: string;
    messageId: string;
    fileKey: string;
    size?: number | undefined;
  }>;
  notes: string[];
  expiresAt: number;
};

export type PendingFileInstructionInteraction = {
  kind: "file-await-instruction";
  chatId: string;
  conversationKey: string;
  requesterOpenId: string;
  replyToMessageId: string;
  file: {
    messageId: string;
    fileKey: string;
    fileName: string;
    size?: number | undefined;
  };
};

export type PendingInteraction =
  | PendingQuestionInteraction
  | PendingPermissionInteraction
  | PendingSessionSelectionInteraction
  | PendingSessionDeleteConfirmationInteraction
  | PendingKnowledgeIngestInteraction
  | PendingLaborAnalysisInteraction
  | PendingFileInstructionInteraction;
