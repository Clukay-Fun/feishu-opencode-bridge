/**
 * 职责: 定义桥接层所有挂起交互的状态结构。
 * 关注点:
 * - 覆盖提问、权限申请、会话选择、文件上传等等待用户继续操作的场景。
 * - 为持久化、超时恢复和卡片回调提供统一的数据形状。
 */
export type PendingQuestionInteraction = {
  // Awaiting explicit answers to model-generated questions.
  kind: "question";
  turnId: string;
  requestId: string;
  sessionId: string;
  questions: Array<{ header: string; question: string }>;
};

export type PendingPermissionInteraction = {
  // Awaiting a permission decision from a bridge-owned card.
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
  resolution?: "once" | "always" | "deny" | "timeout" | "upstream-expired" | undefined;
};

export type PendingSessionSelectionInteraction = {
  // Awaiting a user choice from a rendered session list.
  kind: "session-select";
  options: Array<{
    index: number;
    sessionId: string;
    title: string;
    displayTitle?: string;
    current?: boolean;
    inWindow?: boolean;
    ownershipState?: "current" | "in-window" | "other-window" | "unowned";
  }>;
  expiresAt: number;
};

export type PendingSessionDeleteConfirmationInteraction = {
  // Awaiting confirmation before deleting one or more sessions.
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
  // Awaiting a local file upload for a knowledge-ingest flow.
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

export type PendingFileInstructionInteraction = {
  // Awaiting a follow-up instruction for a file that was just uploaded.
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
  /** 区分普通文件、图片与文件夹资源，下载时传给飞书 API。缺失时默认 "file"。 */
  resourceType?: "file" | "image" | "folder" | undefined;
};

export type PendingInteraction =
  | PendingQuestionInteraction
  | PendingPermissionInteraction
  | PendingSessionSelectionInteraction
  | PendingSessionDeleteConfirmationInteraction
  | PendingKnowledgeIngestInteraction
  | PendingFileInstructionInteraction;
