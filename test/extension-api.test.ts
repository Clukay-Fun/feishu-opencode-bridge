/**
 * 职责: 覆盖 extension-api 公共契约面的 helper 与类型边界。
 * 关注点:
 * - 验证 helper 无运行时副作用且保留类型收窄。
 * - 锁定外部扩展上下文不会暴露深框架 API。
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  defineCardTemplate,
  defineExtension,
  type ExtensionRuntimeContext,
} from "../src/extension-api/index.js";

describe("extension-api", () => {
  it("defineExtension returns the original definition and preserves literal fields", () => {
    const extension = defineExtension({
      id: "demo-extension",
      configKey: "demoConfig",
      dependencies: ["knowledge-base"],
      commands: [
        { name: "demo", aliases: ["demo-alias"], owner: "business", description: "Demo command" },
      ],
      createModule() {
        return {
          name: "demo",
          priority: 50,
        };
      },
    });

    expect(extension.id).toBe("demo-extension");
    expect(extension.dependencies).toEqual(["knowledge-base"]);
    expectTypeOf(extension.configKey).toEqualTypeOf<"demoConfig">();
  });

  it("defineCardTemplate returns the original template and preserves schema inference", () => {
    const template = defineCardTemplate({
      id: "demo.card",
      schema: z.object({ title: z.string() }),
      render(input) {
        expectTypeOf(input.title).toEqualTypeOf<string>();
        return {
          title: input.title,
          template: "blue",
          iconToken: "chat_outlined",
          blocks: [{ kind: "title", content: input.title }],
        };
      },
    });

    expect(template.id).toBe("demo.card");
    expect(template.schema.parse({ title: "Demo" })).toEqual({ title: "Demo" });
  });

  it("keeps deep framework APIs out of ExtensionRuntimeContext", () => {
    expectTypeOf<Extract<
      keyof ExtensionRuntimeContext,
      "transport" | "whitelist" | "saveSessionWindow" | "createAndBindSession" | "getSessionWindow"
    >>().toEqualTypeOf<never>();

    expectTypeOf<ExtensionRuntimeContext>().toHaveProperty("config");
    expectTypeOf<ExtensionRuntimeContext>().toHaveProperty("outbound");
    expectTypeOf<ExtensionRuntimeContext>().toHaveProperty("logger");
    expectTypeOf<ExtensionRuntimeContext>().toHaveProperty("opencode");
    expectTypeOf<ExtensionRuntimeContext>().toHaveProperty("knowledge");
    expectTypeOf<ExtensionRuntimeContext>().toHaveProperty("window");
  });
});
