import type { RuntimeModule, RuntimeModuleAfterTurnContext, RuntimeModuleBeforeTurnContext } from "../bridge/module.js";
import type { MemoryService } from "./index.js";

export class MemoryRuntimeModule implements RuntimeModule {
  readonly name = "memory";
  readonly priority = 30;

  constructor(private readonly memory: MemoryService) {}

  async start(): Promise<void> {
    await this.memory.start();
  }

  async stop(): Promise<void> {
    await this.memory.stop();
  }

  async beforeTurn(context: RuntimeModuleBeforeTurnContext): Promise<{ systemBlocks?: string[] } | void> {
    const recallBlock = await this.memory.buildRecallBlock(context.turn.senderOpenId, context.turn.plainText);
    if (!recallBlock.trim()) {
      return;
    }
    return { systemBlocks: [recallBlock] };
  }

  async afterTurn(context: RuntimeModuleAfterTurnContext): Promise<void> {
    if (!context.reply.trim()) {
      return;
    }
    this.memory.enqueueLearn(context.turn.senderOpenId, context.turn.plainText, context.reply);
  }
}
