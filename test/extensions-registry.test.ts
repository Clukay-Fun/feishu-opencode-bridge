/**
 * 职责: 覆盖内置扩展 manifest 注册校验。
 * 关注点: 验证 configKey 显式映射、命令声明冲突和只声明不分发的约束。
 */
import { describe, expect, it } from "vitest";

import type { BuiltinExtensionDefinition } from "../src/extensions/definition.js";
import { builtinExtensionRegistry } from "../src/extensions/builtin.js";
import { createBuiltinExtensionRegistry } from "../src/extensions/registry.js";
import { routeIncomingText } from "../src/bridge/router.js";

describe("builtin extension registry", () => {
  it("lists commands for documentation and future help without changing router dispatch", () => {
    expect(builtinExtensionRegistry.listCommands()).toEqual(expect.arrayContaining([
      expect.objectContaining({ extensionId: "knowledge-base", name: "法律咨询开始" }),
      expect.objectContaining({ extensionId: "contract-assistant", name: "合同起草开始" }),
      expect.objectContaining({ extensionId: "labor-skill", name: "劳动分析" }),
    ]));

    expect(routeIncomingText("/法律咨询开始")).toEqual({
      kind: "command",
      command: { kind: "passthrough", name: "法律咨询开始", arguments: [] },
    });
  });

  it("rejects duplicate extension command names and aliases", () => {
    expect(() => createBuiltinExtensionRegistry([
      createExtension("one", { name: "demo", aliases: ["shared"] }),
      createExtension("two", { name: "shared" }),
    ], { configKeys: [] })).toThrow("Duplicate extension command: shared");
  });

  it("rejects extension config keys not registered in AppConfig", () => {
    expect(() => createBuiltinExtensionRegistry([
      createExtension("broken", { name: "demo" }, "missing" as never),
    ], { configKeys: ["knowledgeBase"] })).toThrow("Extension broken declares unknown configKey: missing");
  });
});

function createExtension(
  id: string,
  command: { name: string; aliases?: readonly string[] },
  configKey?: BuiltinExtensionDefinition["configKey"],
): BuiltinExtensionDefinition {
  return {
    id,
    ...(configKey ? { configKey } : {}),
    commands: [{ ...command, owner: "business", description: "demo" }],
    createModule: () => null,
  };
}
