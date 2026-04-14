import type { IncomingChatMessage } from "../runtime/app.js";
import type { RoutedText } from "./router.js";
import type { BridgeTurn } from "./turn.js";
import type { SessionWindowRecord } from "../store/mappings.js";
import type { PendingInteraction } from "./state.js";

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
      const result = await module.handleMessage?.(context);
      if (result?.claimed) {
        return result;
      }
    }
    return { claimed: false };
  }

  async collectBeforeTurnBlocks(context: RuntimeModuleBeforeTurnContext): Promise<string[]> {
    const blocks: string[] = [];
    for (const module of this.modules) {
      const result = await module.beforeTurn?.(context);
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
      await module.afterTurn?.(context);
    }
  }
}
