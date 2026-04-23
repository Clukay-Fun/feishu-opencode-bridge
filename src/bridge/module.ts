/**
 * 职责: 定义运行时模块接口，以及模块链路之间共享的上下文契约。
 * 关注点:
 * - 约束 handleMessage、beforeTurn、afterTurn 三个扩展入口。
 * - 提供模块执行时使用的上下文类型。
 * - 定义 ModuleManager 对模块编排层的最小接口。
 */
import type { IncomingChatMessage } from "../runtime/app.js";
import type { RoutedText } from "./router.js";
import type { BridgeTurn } from "./turn.js";
import type { SessionWindowRecord } from "../store/mappings.js";
import type { PendingFileInstructionInteraction, PendingInteraction } from "./state.js";
import { logEvent, type Logger } from "../logging/logger.js";

export type RuntimeModuleHandleResult =
  | { claimed: true }
  | { claimed: false };

export type RuntimeModuleMessageContext = {
  message: IncomingChatMessage;
  routed: RoutedText | null;
  pendingInteraction?: PendingInteraction | null;
};

export type RuntimeModuleBeforeTurnContext = {
  turn: BridgeTurn & { sessionId: string };
  window: SessionWindowRecord;
};

export type RuntimeModuleAfterTurnContext = {
  turn: BridgeTurn & { sessionId: string };
  reply: string;
  window: SessionWindowRecord;
};

export interface RuntimeModule {
  readonly name: string;
  readonly priority: number;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  handleMessage?(context: RuntimeModuleMessageContext): Promise<RuntimeModuleHandleResult>;
  claimFileInstruction?(
    pending: PendingFileInstructionInteraction,
    message: IncomingChatMessage,
  ): Promise<boolean>;
  beforeTurn?(context: RuntimeModuleBeforeTurnContext): Promise<{ systemBlocks?: string[] } | void>;
  afterTurn?(context: RuntimeModuleAfterTurnContext): Promise<void>;
}

/**
 * 负责管理 RuntimeModule 的注册顺序和钩子调用。
 */
export class ModuleManager {
  private readonly modules: RuntimeModule[] = [];

  constructor(private readonly logger?: Pick<Logger, "log" | "event">) {}

  /** 注册模块，并按优先级重新排序。 */
  register(module: RuntimeModule): void {
    this.modules.push(module);
    this.modules.sort((left, right) => left.priority - right.priority);
  }

  /** 返回当前已注册模块列表。 */
  list(): readonly RuntimeModule[] {
    return this.modules;
  }

  /** 按注册顺序启动所有模块。 */
  async start(): Promise<void> {
    for (const module of this.modules) {
      await module.start?.();
    }
  }

  /** 按逆序停止所有模块。 */
  async stop(): Promise<void> {
    for (const module of [...this.modules].reverse()) {
      await module.stop?.();
    }
  }

  /** 依次执行模块的消息拦截入口，直到有模块认领。 */
  async handleMessage(context: RuntimeModuleMessageContext): Promise<RuntimeModuleHandleResult> {
    for (const module of this.modules) {
      const startedAt = Date.now();
      let result: RuntimeModuleHandleResult | undefined;
      try {
        result = await module.handleMessage?.(context);
      } catch (error) {
        this.logModuleFailed(module, "handleMessage", error);
        throw error;
      }
      if (result?.claimed) {
        this.logModuleInvoked(module, "handleMessage", "claimed", startedAt);
        return result;
      }
    }
    return { claimed: false };
  }

  /** 依次询问模块是否要接管“先上传文件，后补指令”的挂起流程。 */
  async claimFileInstruction(
    pending: PendingFileInstructionInteraction,
    message: IncomingChatMessage,
  ): Promise<boolean> {
    for (const module of this.modules) {
      if (!module.claimFileInstruction) {
        continue;
      }
      const startedAt = Date.now();
      let claimed = false;
      try {
        claimed = await module.claimFileInstruction(pending, message);
      } catch (error) {
        this.logModuleFailed(module, "claimFileInstruction", error);
        throw error;
      }
      if (claimed) {
        this.logModuleInvoked(module, "claimFileInstruction", "claimed", startedAt);
        return true;
      }
    }
    return false;
  }

  /** 汇总所有模块注入的 beforeTurn system blocks。 */
  async collectBeforeTurnBlocks(context: RuntimeModuleBeforeTurnContext): Promise<string[]> {
    const blocks: string[] = [];
    for (const module of this.modules) {
      const startedAt = Date.now();
      let result: { systemBlocks?: string[] } | void;
      try {
        result = await module.beforeTurn?.(context);
      } catch (error) {
        this.logModuleFailed(module, "beforeTurn", error);
        throw error;
      }
      if (module.beforeTurn) {
        this.logModuleInvoked(module, "beforeTurn", "completed", startedAt);
      }
      if (!result?.systemBlocks) {
        continue;
      }
      for (const block of result.systemBlocks) {
        const normalized = block.trim();
        if (normalized) {
          blocks.push(normalized);
        }
      }
    }
    return blocks;
  }

  /** 在 turn 完成后顺序执行各模块的 afterTurn 钩子。 */
  async runAfterTurnHooks(context: RuntimeModuleAfterTurnContext): Promise<void> {
    for (const module of this.modules) {
      if (!module.afterTurn) {
        continue;
      }
      const startedAt = Date.now();
      try {
        await module.afterTurn(context);
      } catch (error) {
        this.logModuleFailed(module, "afterTurn", error);
        throw error;
      }
      this.logModuleInvoked(module, "afterTurn", "completed", startedAt);
    }
  }

  /** 记录模块调用成功日志。 */
  private logModuleInvoked(
    module: RuntimeModule,
    hook: "handleMessage" | "claimFileInstruction" | "beforeTurn" | "afterTurn" | "stop",
    result: "claimed" | "completed",
    startedAt: number,
  ): void {
    if (!this.logger) {
      return;
    }
    logEvent(this.logger, "runtime/modules", "module.invoked", {
      moduleId: module.name,
      hook,
      result,
      durationMs: Date.now() - startedAt,
    });
  }

  /** 记录模块调用失败日志。 */
  private logModuleFailed(
    module: RuntimeModule,
    hook: "handleMessage" | "claimFileInstruction" | "beforeTurn" | "afterTurn" | "stop",
    error: unknown,
  ): void {
    if (!this.logger) {
      return;
    }
    logEvent(this.logger, "runtime/modules", "module.failed", {
      moduleId: module.name,
      hook,
      errorKind: error instanceof Error ? error.name : "unknown",
      detail: error instanceof Error ? error.message : String(error),
    }, "warn");
  }
}
