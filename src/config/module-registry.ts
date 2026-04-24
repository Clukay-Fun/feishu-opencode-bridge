/**
 * 职责: 管理内置模块的配置定义。
 * 关注点:
 * - 提供静态 registry，避免中央 schema/loader 持续吸收模块配置细节。
 * - 保持接口内部使用，不作为第三方 plugin API。
 */
import type { z } from "zod";

export type EmbeddingProviderConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

/** @internal 字段集本期冻结；新增字段视为 breaking change。 */
export type ConfigLoadContext = {
  baseDir: string;
  dataDir: string;
  resolveRelative(baseDir: string, value: string): string;
  resolvedEmbeddingProvider?: EmbeddingProviderConfig;
};

/** @internal 仅供 bridge 内置模块配置注册使用，不作为插件公共 API。 */
export type ModuleConfigDefinition<Parsed, Normalized> = {
  key: string;
  schema: z.ZodType<Parsed, z.ZodTypeDef, unknown>;
  validate?(parsed: Parsed, context: z.RefinementCtx): void;
  normalize(parsed: Parsed, context: ConfigLoadContext): Normalized;
};

type AnyModuleConfigDefinition = ModuleConfigDefinition<unknown, unknown>;

export function createModuleConfigRegistry(definitions: readonly AnyModuleConfigDefinition[]) {
  const keys = new Set<string>();
  for (const definition of definitions) {
    if (keys.has(definition.key)) {
      throw new Error(`Duplicate module config key: ${definition.key}`);
    }
    keys.add(definition.key);
  }

  return {
    definitions,

    getSchemaShape<T extends Record<string, z.ZodTypeAny>>(): T {
      return Object.fromEntries(definitions.map((definition) => [definition.key, definition.schema])) as T;
    },

    normalize<T extends Record<string, unknown>>(
      parsed: Record<string, unknown>,
      context: ConfigLoadContext,
    ): T {
      return Object.fromEntries(definitions.map((definition) => [
        definition.key,
        definition.normalize(parsed[definition.key], context),
      ])) as T;
    },
  };
}
