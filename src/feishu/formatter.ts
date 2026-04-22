/**
 * 职责: 统一导出飞书格式化与卡片构建模块。
 * 关注点:
 * - 聚合各业务卡片与共享原语的出口。
 * - 降低调用方对具体文件结构的耦合。
 */
//#region Shared primitives
export {
  buildNoticeCardPayload,
  buildPostMarkdownPayload,
  buildPostPayload,
  buildQueueNoticePayload,
  toInteractiveCardContent,
  type FeishuPostPayload,
  type NoticeCardView,
  type OutputView,
  type ToolUpdateView,
} from "./shared-primitives.js";
//#endregion

//#region Knowledge cards
export {
  buildKnowledgeIngestFailurePayload,
  buildKnowledgeIngestPayload,
  buildKnowledgeIngestProcessingPayload,
  buildKnowledgeIngestQueuedPayload,
  buildKnowledgeIngestReadyPayload,
  buildKnowledgeIngestSessionFinalPayload,
  buildKnowledgeIngestSessionPayload,
  buildKnowledgeQueryEmptyPayload,
  buildKnowledgeQueryPayload,
  type KnowledgeIngestFailureCardView,
  type KnowledgeIngestProgressCardView,
  type KnowledgeIngestQueuedCardView,
  type KnowledgeIngestSessionSummaryView,
  type KnowledgeQueryEmptyCardView,
} from "./knowledge-cards.js";
//#endregion

//#region Runtime cards
export {
  buildLeaveCommandCardPayload,
  buildModelListCardPayload,
  buildPermissionRequestCardPayload,
  buildSessionListCardPayload,
  buildSessionTransitionCardPayload,
  buildStatusCommandCardPayload,
  buildTurnStatusCardPayload,
  buildWhoCommandCardPayload,
  type LeaveCommandCardView,
  type ModelListCardView,
  type PermissionActionButton,
  type PermissionRequestCardView,
  type SessionListCardView,
  type SessionTransitionCardView,
  type StatusCommandCardView,
  type TurnStatusCardView,
  type WhoCommandCardView,
} from "./runtime-cards.js";
//#endregion

//#region Labor cards
export {
  buildLaborAnalysisCompletedPayload,
  buildLaborAnalysisProgressPayload,
  type LaborAnalysisCompletedCardView,
  type LaborAnalysisProgressCardView,
} from "./labor-cards.js";
//#endregion

//#region Contract cards
export {
  buildCaseCreateCompletedPayload,
  buildCaseCreateProcessingPayload,
  buildCaseReminderAddCompletedPayload,
  buildContractDraftCompletedPayload,
  buildContractDraftProgressPayload,
  buildInvoiceRecognizeCompletedPayload,
  buildInvoiceRecognizeProgressPayload,
  buildReminderProgressPayload,
  buildTodayTodoPayload,
  type ContractDraftProgressView,
  type InvoiceRecognizeProgressView,
  type ReminderListResult,
} from "./contract-cards.js";
//#endregion
