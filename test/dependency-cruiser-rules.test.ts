/**
 * 职责: 覆盖 dependency-cruiser 业务目录反选边界。
 * 关注点:
 * - 验证规则不再靠枚举现有业务目录工作。
 * - 用 fake path 证明新增业务目录会自动命中边界护栏。
 */
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const depCruiserConfig = require("../.dependency-cruiser.cjs") as {
  forbidden: Array<{
    name: string;
    from?: { path?: string; pathNot?: string };
    to?: { path?: string; pathNot?: string; dependencyTypesNot?: readonly string[] };
  }>;
};

describe("dependency-cruiser rules", () => {
  it("uses framework whitelist reverse selection instead of hardcoded business directory enum", () => {
    const serializedRules = depCruiserConfig.forbidden
      .map((rule) => `${rule.from?.path ?? ""}\n${rule.to?.path ?? ""}\n${rule.to?.pathNot ?? ""}`)
      .join("\n");

    expect(serializedRules).not.toContain("contract-assistant|labor|memory");
    expect(serializedRules).toContain("(?!(?:bridge|config|document-pipeline");
  });

  it("treats unknown top-level src directories as business modules", () => {
    expect(matchesRule("core-must-not-import-domain-modules", {
      from: "src/runtime/app.ts",
      to: "src/fake-ext/runtime-module.ts",
      dependencyTypes: ["import"],
    })).toBe(true);
  });

  it("keeps knowledge and memory classified as shared service modules, not reverse-selected business modules", () => {
    expect(matchesRule("core-must-not-import-domain-modules", {
      from: "src/runtime/app.ts",
      to: "src/knowledge/runtime-module.ts",
      dependencyTypes: ["import"],
    })).toBe(false);
    expect(matchesRule("business-extensions-must-not-import-each-other", {
      from: "src/contract-assistant/runtime-module.ts",
      to: "src/knowledge/factory.ts",
      dependencyTypes: ["import"],
    })).toBe(false);
    expect(matchesRule("business-extensions-must-not-import-each-other", {
      from: "src/labor/runtime-module.ts",
      to: "src/memory/index.ts",
      dependencyTypes: ["import"],
    })).toBe(false);
  });

  it("blocks config layer from directly importing business runtime files", () => {
    expect(matchesRule("config-layer-must-not-import-runtime-domain", {
      from: "src/config/modules.ts",
      to: "src/fake-ext/runtime-module.ts",
      dependencyTypes: ["import"],
    })).toBe(true);
  });

  it("blocks cross-business imports while allowing same-module imports", () => {
    expect(matchesRule("business-extensions-must-not-import-each-other", {
      from: "src/fake-a/index.ts",
      to: "src/fake-b/index.ts",
      dependencyTypes: ["import"],
    })).toBe(true);

    expect(matchesRule("business-extensions-must-not-import-each-other", {
      from: "src/fake-a/index.ts",
      to: "src/fake-a/runtime-module.ts",
      dependencyTypes: ["import"],
    })).toBe(false);
  });

  it("blocks business modules from importing feishu template runtime directly", () => {
    expect(matchesRule("business-card-templates-only-via-family-adapters", {
      from: "src/fake-ext/runtime-module.ts",
      to: "src/feishu/templates/runtime.ts",
      dependencyTypes: ["import"],
    })).toBe(true);
  });

  it("keeps extension meta files data-only", () => {
    expect(matchesRule("extension-meta-must-stay-data-only", {
      from: "src/fake-ext/extension.meta.ts",
      to: "src/fake-ext/runtime-module.ts",
      dependencyTypes: ["import"],
    })).toBe(true);
  });

  it("allows external extensions to import extension-api only", () => {
    expect(matchesRule("external-extensions-must-only-import-extension-api", {
      from: "extensions/demo/dist/runtime.js",
      to: "src/extension-api/index.ts",
      dependencyTypes: ["import"],
    })).toBe(false);
  });

  it("blocks external extensions from importing bridge internals", () => {
    for (const target of [
      "src/runtime/app.ts",
      "src/bridge/module.ts",
      "src/feishu/templates/runtime.ts",
      "src/store/mappings.ts",
      "src/contract-assistant/index.ts",
    ]) {
      expect(matchesRule("external-extensions-must-only-import-extension-api", {
        from: "extensions/demo/dist/runtime.js",
        to: target,
        dependencyTypes: ["import"],
      })).toBe(true);
    }
  });
});

function matchesRule(
  ruleName: string,
  edge: { from: string; to: string; dependencyTypes: readonly string[] },
): boolean {
  const rule = depCruiserConfig.forbidden.find((candidate) => candidate.name === ruleName);
  if (!rule) {
    throw new Error(`Missing dependency-cruiser rule: ${ruleName}`);
  }
  const fromGroups = matchGroups(rule.from?.path, edge.from);
  if (!fromGroups || matchesPattern(rule.from?.pathNot, edge.from, fromGroups)) {
    return false;
  }

  if (!matchesPattern(rule.to?.path, edge.to, fromGroups)) {
    return false;
  }
  if (matchesPattern(rule.to?.pathNot, edge.to, fromGroups)) {
    return false;
  }

  const dependencyTypesNot = rule.to?.dependencyTypesNot;
  if (dependencyTypesNot?.some((type) => edge.dependencyTypes.includes(type))) {
    return false;
  }
  return true;
}

function matchGroups(pattern: string | undefined, value: string): RegExpMatchArray | null {
  if (!pattern) {
    return [value] as unknown as RegExpMatchArray;
  }
  return new RegExp(pattern).exec(value);
}

function matchesPattern(pattern: string | undefined, value: string, groups: readonly string[] = []): boolean {
  if (!pattern) {
    return false;
  }
  const expanded = groups.reduce((result, group, index) => result.replaceAll(`$${index}`, group), pattern);
  return new RegExp(expanded).test(value);
}
