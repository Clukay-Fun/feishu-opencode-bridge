import type { IncomingChatMessage } from "../runtime/app.js";
import type { RoutedText } from "./router.js";
import type { BridgeTurn } from "./turn.js";
import type { SessionWindowRecord } from "../store/mappings.js";
import type { PendingInteraction } from "./state.js";
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
  beforeTurn?(context: RuntimeModuleBeforeTurnContext): Promise<{ systemBlocks?: string[] } | void>;
  afterTurn?(context: RuntimeModuleAfterTurnContext): Promise<void>;
}

export class ModuleManager {
  private readonly modules: RuntimeModule[] = [];

  constructor(private readonly logger?: Pick<Logger, "log" | "event">) {}

  register(module: RuntimeModule): void {
    this.modules.push(module);
    this.modules.sort((left, right) => left.priority - right.priority);
  }

  list(): readonly RuntimeModule[] {
    return this.modules;
  }

  async start(): Promise<void> {
    for (const module of this.modules) {
      await module.start?.();
    }
  }

  async stop(): Promise<void> {
    for (const module of [...this.modules].reverse()) {
      await module.stop?.();
    }
  }

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

  private logModuleInvoked(
    module: RuntimeModule,
    hook: "handleMessage" | "beforeTurn" | "afterTurn" | "stop",
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

  private logModuleFailed(
    module: RuntimeModule,
    hook: "handleMessage" | "beforeTurn" | "afterTurn" | "stop",
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
