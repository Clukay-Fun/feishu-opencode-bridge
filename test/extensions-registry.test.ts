/**
 * 职责: 覆盖内置扩展 manifest 注册校验。
 * 关注点: 验证 data-only meta、runtime registry 和命令声明边界。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { BuiltinExtensionMetaDefinition } from "../src/extensions/definition.js";
import { builtinExtensionRegistry, builtinExtensions } from "../src/extensions/builtin.js";
import { builtinExtensionCommands, builtinExtensionMetaRegistry } from "../src/extensions/builtin-meta.js";
import { createBuiltinExtensionMetaRegistry, createBuiltinExtensionRegistry } from "../src/extensions/registry.js";
import { routeIncomingText } from "../src/bridge/router.js";

describe("builtin extension registry", () => {
  it("lists commands from data-only meta without changing router dispatch", () => {
    expect(builtinExtensionCommands).toEqual(expect.arrayContaining([
      expect.objectContaining({ extensionId: "knowledge-base", name: "法律咨询开始" }),
      expect.objectContaining({ extensionId: "contract-assistant", name: "合同起草开始" }),
      expect.objectContaining({ extensionId: "labor-skill", name: "劳动分析" }),
    ]));

    expect(routeIncomingText("/法律咨询开始")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "法律咨询开始", arguments: [] },
    });
  });

  it("registers runtime extensions separately from data-only meta", () => {
    expect(builtinExtensionRegistry.extensions.map((extension) => extension.id)).toEqual([
      "knowledge-base",
      "contract-assistant",
      "labor-skill",
      "memory",
    ]);
    expect(builtinExtensionMetaRegistry.metas.map((meta) => meta.id)).toEqual(builtinExtensions.map((extension) => extension.id));
  });

  it("rejects duplicate extension command names and aliases", () => {
    expect(() => createBuiltinExtensionMetaRegistry([
      createMeta("one", { name: "demo", aliases: ["shared"] }),
      createMeta("two", { name: "shared" }),
    ])).toThrow("Duplicate extension command: shared");
  });

  it("rejects mismatched extension configKey and configDefinition key", () => {
    expect(() => createBuiltinExtensionMetaRegistry([
      {
        ...createMeta("broken", { name: "demo" }, "knowledgeBase"),
        configDefinition: {
          key: "contractAssistant",
          schema: z.object({}),
          normalize: () => ({}),
        },
      },
    ])).toThrow(
      "Extension broken configKey knowledgeBase does not match configDefinition.key contractAssistant",
    );
  });

  it("rejects duplicate runtime extension ids", () => {
    expect(() => createBuiltinExtensionRegistry([
      { id: "dup", createModule: () => null },
      { id: "dup", createModule: () => null },
    ])).toThrow("Duplicate builtin extension id: dup");
  });
});

function createMeta(
  id: string,
  command: { name: string; aliases?: readonly string[] },
  configKey?: BuiltinExtensionMetaDefinition["configKey"],
): BuiltinExtensionMetaDefinition {
  return {
    id,
    ...(configKey ? { configKey } : {}),
    commands: [{ ...command, owner: "business", description: "demo" }],
  };
}
