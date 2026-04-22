/**
 * 职责: 将记忆服务接入运行时模块链路。
 * 关注点:
 * - 在 turn 前注入相关记忆。
 * - 在 turn 后异步学习新的用户事实。
 */
import type { RuntimeModule, RuntimeModuleAfterTurnContext, RuntimeModuleBeforeTurnContext } from "../bridge/module.js";
import type { MemoryService } from "./index.js";

export class MemoryRuntimeModule implements RuntimeModule {
  readonly name = "memory";
  readonly priority = 30;

  constructor(private readonly memory: MemoryService) {}

  /** 启动记忆服务。 */
  async start(): Promise<void> {
    await this.memory.start();
  }

  /** 停止记忆服务。 */
  async stop(): Promise<void> {
    await this.memory.stop();
  }

  /** 在 turn 前召回与当前问题相关的记忆。 */
  async beforeTurn(context: RuntimeModuleBeforeTurnContext): Promise<{ systemBlocks?: string[] } | void> {
    const recallBlock = await this.memory.buildRecallBlock(context.turn.senderOpenId, context.turn.plainText);
    if (!recallBlock.trim()) {
      return;
    }
    return { systemBlocks: [recallBlock] };
  }

  /** 在 turn 后把本轮对话加入学习队列。 */
  async afterTurn(context: RuntimeModuleAfterTurnContext): Promise<void> {
    if (!context.reply.trim()) {
      return;
    }
    this.memory.enqueueLearn(context.turn.senderOpenId, context.turn.plainText, context.reply);
  }
}
