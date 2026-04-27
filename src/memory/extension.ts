/**
 * 职责: 声明记忆模块内置扩展。
 * 关注点:
 * - 将 memory RuntimeModule 创建接入统一内置扩展装配。
 * - 保持 memory 配置暂在中央配置层，后续可按同模式下沉。
 */
import type { BuiltinExtensionDefinition, RuntimeExtensionContext } from "../extensions/definition.js";
import { MemoryService } from "./index.js";
import { MemoryRuntimeModule } from "./runtime-module.js";
import type { OpenCodeClient } from "../opencode/client.js";

export const memoryExtension: BuiltinExtensionDefinition = {
  id: "memory",
  configKey: "memory",
  createModule(context) {
    const service = context.memory instanceof MemoryService
      ? context.memory
      : createMemoryService(context);
    return service ? new MemoryRuntimeModule(service) : null;
  },
};

function createMemoryService(context: RuntimeExtensionContext): MemoryService | null {
  if (!context.config.memory.enabled) {
    return null;
  }
  return new MemoryService(
    context.config.memory,
    context.config.embeddings ?? { provider: undefined, similarityThreshold: 0.75 },
    context.opencode as OpenCodeClient,
    context.logger,
  );
}
