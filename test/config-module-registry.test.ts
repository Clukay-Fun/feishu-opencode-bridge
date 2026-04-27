/**
 * 职责: 覆盖配置模块注册表行为。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createModuleConfigRegistry,
  type ConfigLoadContext,
  type ModuleConfigDefinition,
} from "../src/config/module-registry.js";
import { moduleConfigRegistry } from "../src/config/modules.js";
import { knowledgeBaseConfigDefinition } from "../src/knowledge/config.js";

describe("module config registry", () => {
  it("derives module config definitions from extension meta", () => {
    expect(moduleConfigRegistry.definitions.map((definition) => definition.key)).toEqual([
      "knowledgeBase",
      "contractAssistant",
      "laborSkill",
    ]);
  });

  it("rejects duplicate config keys", () => {
    const definition = createDefinition("demo");

    expect(() => createModuleConfigRegistry([definition, definition])).toThrow("Duplicate module config key: demo");
  });

  it("normalizes registered modules with the shared load context", () => {
    const normalize = vi.fn((parsed: { enabled: boolean }, context: ConfigLoadContext) => ({
      enabled: parsed.enabled,
      dataDir: context.dataDir,
    }));
    const registry = createModuleConfigRegistry([createDefinition("demo", normalize)]);
    const context = createContext();

    const result = registry.normalize<{ demo: { enabled: boolean; dataDir: string } }>({
      demo: { enabled: true },
    }, context);

    expect(result).toEqual({ demo: { enabled: true, dataDir: "/base/data" } });
    expect(normalize).toHaveBeenCalledWith({ enabled: true }, context);
  });

  it("keeps module validate scoped to the module parsed config", () => {
    expect(knowledgeBaseConfigDefinition.validate?.length).toBe(2);
  });
});

function createDefinition(
  key: string,
  normalize: ModuleConfigDefinition<{ enabled: boolean }, { enabled: boolean }>["normalize"] = (parsed) => parsed,
): ModuleConfigDefinition<{ enabled: boolean }, { enabled: boolean }> {
  return {
    key,
    schema: z.object({ enabled: z.boolean() }),
    normalize,
  };
}

function createContext(): ConfigLoadContext {
  return {
    baseDir: "/base",
    dataDir: "/base/data",
    resolveRelative(baseDir, value) {
      return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
    },
  };
}
