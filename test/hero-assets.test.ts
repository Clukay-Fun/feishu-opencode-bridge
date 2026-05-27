/**
 * 职责: 保护 README 门面、发布包边界和公开文档导航。
 * 关注点:
 * - README 保持轻量，把长命令和功能说明导向 docs。
 * - 本地卫生指南明确 runtime 数据与发布包边界。
 * - 公开文档不应重新承诺已删除的仓库 examples 目录。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PUBLIC_DOC_FILES = [
  "README.md",
  "README.en.md",
  "docs/README.md",
  "docs/commands.md",
  "docs/features.md",
  "docs/guidelines/local-hygiene.md",
  "docs/privacy-and-data-flow.md",
  "docs/guidelines/business-extension-development.md",
];

describe("repository launch docs", () => {
  it("does not contain obvious real secrets or non-placeholder case numbers", async () => {
    const joined = (await Promise.all(PUBLIC_DOC_FILES.map((file) => readFile(path.resolve(file), "utf8")))).join("\n");

    expect(joined).not.toMatch(/cli_[a-zA-Z0-9]{10,}/);
    expect(joined).not.toMatch(/(?:sk|ak)-[a-zA-Z0-9]{12,}/i);
    expect(joined).not.toMatch(/app[a-zA-Z0-9]{12,}/);
    expect(joined).not.toMatch(/\(20\d{2}\)[\u4e00-\u9fa5]{1,3}\d{2,4}(?:民初|仲|劳人仲)\d{4,}号/);
  });

  it("keeps README lightweight and points readers to split docs", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    const englishReadme = await readFile(path.resolve("README.en.md"), "utf8");

    expect(readme).toContain("## 仓库、发布包与用户数据");
    expect(readme).toContain("[功能说明](docs/features.md)");
    expect(readme).toContain("[命令手册](docs/commands.md)");
    expect(readme).toContain("[本地卫生清理指南](docs/guidelines/local-hygiene.md)");
    expect(readme).not.toContain("examples/hero/");
    expect(englishReadme).toContain("## Repository, Release Package, And User Data");
    expect(englishReadme).toContain("[Features](docs/features.md)");
    expect(englishReadme).toContain("[Commands](docs/commands.md)");
  });

  it("documents release-package and local-hygiene boundaries", async () => {
    const hygiene = await readFile(path.resolve("docs/guidelines/local-hygiene.md"), "utf8");
    const extensionGuide = await readFile(path.resolve("docs/guidelines/business-extension-development.md"), "utf8");

    expect(hygiene).toContain("portable 发布包边界");
    expect(hygiene).toContain("src/`、`test/`、`docs/`、`examples/");
    expect(hygiene).toContain("batch-*.json");
    expect(extensionGuide).toContain("实验性能力");
    expect(extensionGuide).toContain("受信代码");
    expect(extensionGuide).toContain("API 不稳定");
    expect(extensionGuide).not.toContain("仓库内的最小示例位于 `examples/extensions/hello-world/`");
  });
});
