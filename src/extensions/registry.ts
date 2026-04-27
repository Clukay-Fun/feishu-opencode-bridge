/**
 * 职责: 管理内置扩展 manifest 注册与校验。
 * 关注点:
 * - 校验扩展 id、configKey 和命令声明冲突。
 * - 仅提供启动期静态聚合，不做运行时热拔插或通用命令分发。
 */
import type { AppConfig } from "../config/schema.js";
import type { BuiltinExtensionDefinition, ExtensionCommandDefinition } from "./definition.js";

export type BuiltinExtensionRegistry = {
  extensions: readonly BuiltinExtensionDefinition[];
  listCommands(): readonly (ExtensionCommandDefinition & { extensionId: string })[];
};

export function createBuiltinExtensionRegistry(
  extensions: readonly BuiltinExtensionDefinition[],
  options: { configKeys: readonly (keyof AppConfig)[] },
): BuiltinExtensionRegistry {
  const extensionIds = new Set<string>();
  const configKeys = new Set<keyof AppConfig>(options.configKeys);
  const commandNames = new Map<string, string>();
  const commands: (ExtensionCommandDefinition & { extensionId: string })[] = [];

  for (const extension of extensions) {
    if (extensionIds.has(extension.id)) {
      throw new Error(`Duplicate builtin extension id: ${extension.id}`);
    }
    extensionIds.add(extension.id);

    if (extension.configKey && !configKeys.has(extension.configKey)) {
      throw new Error(`Extension ${extension.id} declares unknown configKey: ${String(extension.configKey)}`);
    }

    for (const command of extension.commands ?? []) {
      for (const name of normalizeCommandNames(command)) {
        const previousOwner = commandNames.get(name);
        if (previousOwner) {
          throw new Error(`Duplicate extension command: ${name} (${previousOwner}, ${extension.id})`);
        }
        commandNames.set(name, extension.id);
      }
      commands.push({ ...command, extensionId: extension.id });
    }
  }

  return {
    extensions,
    listCommands: () => commands,
  };
}

function normalizeCommandNames(command: ExtensionCommandDefinition): string[] {
  return [command.name, ...(command.aliases ?? [])]
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}
