/**
 * 职责: 管理内置扩展 manifest 注册与校验。
 * 关注点:
 * - 分别校验 data-only meta 与 runtime extension 的启动期注册。
 * - 仅提供启动期静态聚合，不做运行时热拔插或通用命令分发。
 */
import type { AnyBusinessCardTemplateDefinition } from "../feishu/templates/definition.js";
import type {
  BuiltinExtensionDefinition,
  BuiltinExtensionMetaDefinition,
  ExtensionCommandDefinition,
} from "./definition.js";

export type BuiltinExtensionRegistry = {
  extensions: readonly BuiltinExtensionDefinition[];
};

export type BuiltinExtensionMetaRegistry = {
  metas: readonly BuiltinExtensionMetaDefinition[];
  listCommands(): readonly (ExtensionCommandDefinition & { extensionId: string })[];
  listConfigDefinitions(): readonly NonNullable<BuiltinExtensionMetaDefinition["configDefinition"]>[];
  listCardTemplates(): readonly AnyBusinessCardTemplateDefinition[];
};

export function createBuiltinExtensionMetaRegistry(
  metas: readonly BuiltinExtensionMetaDefinition[],
): BuiltinExtensionMetaRegistry {
  const extensionIds = new Set<string>();
  const commandNames = new Map<string, string>();
  const commands: (ExtensionCommandDefinition & { extensionId: string })[] = [];
  const configDefinitions: NonNullable<BuiltinExtensionMetaDefinition["configDefinition"]>[] = [];
  const cardTemplates: AnyBusinessCardTemplateDefinition[] = [];

  for (const meta of metas) {
    if (extensionIds.has(meta.id)) {
      throw new Error(`Duplicate builtin extension id: ${meta.id}`);
    }
    extensionIds.add(meta.id);

    if (meta.configKey && meta.configDefinition && meta.configKey !== meta.configDefinition.key) {
      throw new Error(
        `Extension ${meta.id} configKey ${String(meta.configKey)} does not match configDefinition.key ${meta.configDefinition.key}`,
      );
    }

    if (meta.configDefinition) {
      configDefinitions.push(meta.configDefinition);
    }

    cardTemplates.push(...(meta.cardTemplates ?? []));

    for (const command of meta.commands ?? []) {
      for (const name of normalizeCommandNames(command)) {
        const previousOwner = commandNames.get(name);
        if (previousOwner) {
          throw new Error(`Duplicate extension command: ${name} (${previousOwner}, ${meta.id})`);
        }
        commandNames.set(name, meta.id);
      }
      commands.push({ ...command, extensionId: meta.id });
    }
  }

  return {
    metas,
    listCommands: () => commands,
    listConfigDefinitions: () => configDefinitions,
    listCardTemplates: () => cardTemplates,
  };
}

export function createBuiltinExtensionRegistry(
  extensions: readonly BuiltinExtensionDefinition[],
): BuiltinExtensionRegistry {
  const extensionIds = new Set<string>();
  for (const extension of extensions) {
    if (extensionIds.has(extension.id)) {
      throw new Error(`Duplicate builtin extension id: ${extension.id}`);
    }
    extensionIds.add(extension.id);
  }

  return {
    extensions,
  };
}

function normalizeCommandNames(command: ExtensionCommandDefinition): string[] {
  return [command.name, ...(command.aliases ?? [])]
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}
