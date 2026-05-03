/**
 * 职责: 保护推广前 Hero 素材的可用性与脱敏边界。
 * 关注点:
 * - 确保新手引导引用的素材文件存在。
 * - 防止示例材料混入明显真实密钥、真实飞书 token 或真实案号格式。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const HERO_FILES = [
  "README.md",
  "contract-draft-prompt.txt",
  "labor-contract.txt",
  "labor-arbitration-case.txt",
  "labor-law-faq.md",
];

describe("hero assets", () => {
  it("keeps reproducible onboarding materials checked in", async () => {
    for (const file of HERO_FILES) {
      const content = await readFile(path.resolve("examples/hero", file), "utf8");
      expect(content.trim().length).toBeGreaterThan(20);
    }
  });

  it("does not contain obvious real secrets or non-placeholder case numbers", async () => {
    const joined = (await Promise.all(HERO_FILES.map((file) => readFile(path.resolve("examples/hero", file), "utf8")))).join("\n");

    expect(joined).not.toMatch(/cli_[a-zA-Z0-9]{10,}/);
    expect(joined).not.toMatch(/(?:sk|ak)-[a-zA-Z0-9]{12,}/i);
    expect(joined).not.toMatch(/app[a-zA-Z0-9]{12,}/);
    expect(joined).not.toMatch(/\(20\d{2}\)[\u4e00-\u9fa5]{1,3}\d{2,4}(?:民初|仲|劳人仲)\d{4,}号/);
    expect(joined).toContain("XX科技公司");
    expect(joined).toContain("(2026)京XX民初0001号");
  });
});
