/**
 * 职责: 将 extension-api 的外部 RuntimeModule 适配到 bridge 内部 RuntimeModule seam。
 * 关注点:
 * - 把内部消息、turn 和 window 状态映射为只读 public view。
 * - 保证外部扩展无法拿到 transport、whitelist、session mutation 等深框架 API。
 * - 仅提供启动期适配，不处理热拔插、reload 或沙箱隔离。
 */
import type {
  ExtensionDefinition,
  ExtensionIncomingMessage,
  ExtensionPendingInteractionView,
  ExtensionRuntimeContext,
  ExtensionRuntimeModule,
  ExtensionRuntimeModuleAfterTurnContext,
  ExtensionRuntimeModuleBeforeTurnContext,
  ExtensionRuntimeModuleMessageContext,
  ExtensionSessionWindowView,
  ExtensionTurnView,
} from "../extension-api/index.js";
import type { RuntimeModule } from "../bridge/module.js";
import type { BridgeTurn } from "../bridge/turn.js";
import type { PendingFileInstructionInteraction, PendingInteraction } from "../bridge/state.js";
import type { KnowledgeBasePort } from "../knowledge/index.js";
import type { Logger } from "../logging/logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { BridgeWindowRecord } from "../store/mappings.js";
import type { IncomingChatMessage } from "./app.js";
import type { RuntimeModuleOutboundPort } from "../extensions/definition.js";

export type ExternalExtensionAdapterContext = {
  config: Readonly<Record<string, unknown>>;
  outbound: RuntimeModuleOutboundPort;
  logger: Logger;
  opencode: Pick<OpenCodeClient,
    | "createSession"
    | "getSessionMessages"
    | "listSessions"
    | "postMessageSync"
    | "promptAsync"
    | "replyPermission"
    | "replyQuestion"
    | "runCommand"
  >;
  knowledge: KnowledgeBasePort | null;
};

export function createExternalRuntimeModule(
  extension: ExtensionDefinition<string, ExtensionRuntimeContext, ExtensionRuntimeModule>,
  context: ExternalExtensionAdapterContext,
): RuntimeModule | null {
  const module = extension.createModule({
    config: context.config,
    outbound: context.outbound,
    logger: context.logger,
    opencode: context.opencode,
    knowledge: context.knowledge,
    window: createEmptyWindowView(),
  });
  if (module instanceof Promise) {
    throw new Error(`Runtime extension ${extension.id} returned an async module; external extensions must create modules synchronously`);
  }
  if (!module) {
    return null;
  }
  return adaptExternalModule(module);
}

function adaptExternalModule(module: ExtensionRuntimeModule): RuntimeModule {
  return {
    name: module.name,
    priority: module.priority,
    ...(module.start ? { start: async () => { await module.start?.(); } } : {}),
    ...(module.stop ? { stop: async () => { await module.stop?.(); } } : {}),
    ...(module.handleMessage ? {
      handleMessage: async (context) => await module.handleMessage?.(toMessageContext(context)) ?? { claimed: false },
    } : {}),
    ...(module.claimFileInstruction ? {
      claimFileInstruction: async (pending, message) => await module.claimFileInstruction?.(toPendingView(pending), toIncomingMessageView(message)) ?? false,
    } : {}),
    ...(module.beforeTurn ? {
      beforeTurn: async (context) => await module.beforeTurn?.(toBeforeTurnContext(context.turn, context.window)),
    } : {}),
    ...(module.afterTurn ? {
      afterTurn: async (context) => await module.afterTurn?.({
        ...toAfterTurnContext(context.turn, context.window),
        reply: context.reply,
      }),
    } : {}),
  };
}

function toMessageContext(context: {
  message: IncomingChatMessage;
  routed: unknown;
  window?: BridgeWindowRecord | undefined;
  pendingInteraction?: PendingInteraction | null | undefined;
}): ExtensionRuntimeModuleMessageContext {
  return {
    message: toIncomingMessageView(context.message),
    routed: context.routed as ExtensionRuntimeModuleMessageContext["routed"],
    window: context.window ? toWindowView(context.window) : createEmptyWindowView(),
    ...(context.pendingInteraction !== undefined
      ? { pendingInteraction: context.pendingInteraction ? toPendingView(context.pendingInteraction) : context.pendingInteraction }
      : {}),
  };
}

function toBeforeTurnContext(
  turn: BridgeTurn & { sessionId: string },
  window: BridgeWindowRecord,
): ExtensionRuntimeModuleBeforeTurnContext {
  return {
    turn: toTurnView(turn),
    window: toWindowView(window),
  };
}

function toAfterTurnContext(
  turn: BridgeTurn & { sessionId: string },
  window: BridgeWindowRecord,
): Omit<ExtensionRuntimeModuleAfterTurnContext, "reply"> {
  return {
    turn: toTurnView(turn),
    window: toWindowView(window),
  };
}

function toIncomingMessageView(message: IncomingChatMessage): ExtensionIncomingMessage {
  return {
    messageId: message.messageId,
    chatId: message.chatId,
    chatType: message.chatType,
    senderOpenId: message.senderOpenId,
    text: message.plainText,
    parentId: message.parentId,
    threadKey: message.threadKey,
    conversationKey: message.conversationKey,
    messageType: message.messageType,
    ...(message.messageType === "file" || message.messageType === "image"
      ? { file: { ...message.file }, resourceType: message.resourceType }
      : {}),
  };
}

function toPendingView(
  pending: PendingInteraction | PendingFileInstructionInteraction,
): ExtensionPendingInteractionView {
  if (pending.kind === "file-await-instruction") {
    return {
      kind: pending.kind,
      file: {
        fileKey: pending.file.fileKey,
        fileName: pending.file.fileName,
        size: pending.file.size,
      },
    };
  }
  return { kind: pending.kind };
}

function toTurnView(turn: BridgeTurn & { sessionId: string }): ExtensionTurnView {
  return {
    turnId: turn.turnId,
    chatId: turn.chatId,
    conversationKey: turn.conversationKey,
    threadKey: turn.threadKey,
    chatType: turn.chatType,
    senderOpenId: turn.senderOpenId,
    inboundMessageId: turn.inboundMessageId,
    plainText: turn.plainText,
    text: turn.text,
    sessionId: turn.sessionId,
  };
}

function toWindowView(window: BridgeWindowRecord): ExtensionSessionWindowView {
  return {
    mode: window.mode,
    interactionMode: window.interactionMode,
    modelOverride: window.modelOverride ? { ...window.modelOverride } : undefined,
    activeSessionId: window.activeSessionId,
    sessions: window.sessions.map((session) => ({ ...session })),
  };
}

function createEmptyWindowView(): ExtensionSessionWindowView {
  return {
    mode: "single",
    activeSessionId: null,
    sessions: [],
  };
}
