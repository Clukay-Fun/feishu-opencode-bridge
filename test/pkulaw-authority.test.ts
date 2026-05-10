/**
 * 职责: 覆盖北大法宝 law-semantic 适配层。
 * 关注点:
 * - 验证 CLI 输出归一化、缓存和降级状态。
 * - 确认缓存命中不重复记录外部调用成本。
 */
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { KnowledgeBaseConfig } from "../src/knowledge/config.js";
import { PkulawAuthorityService } from "../src/knowledge/pkulaw-authority.js";

describe("PkulawAuthorityService", () => {
  it("normalizes law-semantic results and caches successful calls", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pkulaw-authority-"));
    const cli = path.join(dir, "pkulaw-mcp");
    await writeExecutable(cli, [
      "#!/usr/bin/env node",
      "console.log('调用 law-semantic / search_article …');",
      "console.log(JSON.stringify([{ title: '劳动合同法', article: '违法解除劳动合同应承担赔偿责任', url: 'https://pkulaw.example/law' }]));",
    ].join("\n"));
    const recordExternalCall = vi.fn(async () => null);
    const service = new PkulawAuthorityService(createConfig(cli), dir, fakeLogger(), { recordExternalCall }, { ttlMs: 60_000 });

    const first = await service.searchLawSemantic({ query: "违法解除劳动合同", turnId: "turn_1", sessionId: "ses_1" });
    const second = await service.searchLawSemantic({ query: "违法解除劳动合同", turnId: "turn_2", sessionId: "ses_1" });

    expect(first.status).toBe("success");
    expect(first.items[0]).toMatchObject({ title: "劳动合同法", excerpt: expect.stringContaining("违法解除") });
    expect(second.status).toBe("cache-hit");
    expect(recordExternalCall).toHaveBeenCalledTimes(1);
  });

  it("downgrades failed CLI calls without throwing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pkulaw-authority-error-"));
    const cli = path.join(dir, "pkulaw-mcp");
    await writeExecutable(cli, "#!/usr/bin/env node\nprocess.exit(1);\n");
    const service = new PkulawAuthorityService(createConfig(cli), dir, fakeLogger());

    const result = await service.searchLawSemantic({ query: "违法解除劳动合同", turnId: "turn_1", sessionId: "ses_1" });

    expect(result.status).toBe("error");
    expect(result.items).toEqual([]);
  });

  it("normalizes law recognition, citation validation, and case number recognition skill outputs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pkulaw-authority-skills-"));
    const cli = path.join(dir, "pkulaw-mcp");
    await writeExecutable(cli, [
      "#!/usr/bin/env node",
      "const [tool, operation] = process.argv.slice(2);",
      "if (tool === 'law-recognition' && operation === 'law_recognition') {",
      "  console.log(JSON.stringify([{ text: '劳动合同法', original: '中华人民共和国劳动合同法', fulltext: '第三十九条 用人单位可以解除劳动合同...', source: 'https://pkulaw.example/chl' }]));",
      "} else if (tool === 'citation-validator' && operation === 'adjust_provisions') {",
      "  console.log(JSON.stringify([{ title: '中华人民共和国劳动合同法', article_number: '39', original_text: '第三十九条 劳动者有下列情形之一的...', url: '[《中华人民共和国劳动合同法》第39条](https://pkulaw.example/chl?tiao=39)', implement_date: '2008-01-01' }]));",
      "} else if (tool === 'case-number' && operation === 'anhao_recognition') {",
      "  console.log(JSON.stringify({ anhaoname: [{ text: '（2024）浙0114破1-6号之二', caseFlag: '（2024）浙0114破1-6号之二', court: '浙江省杭州市钱塘区人民法院', title: '指导性案例252号', lastInstanceDate: '2024.06.18', url: 'https://pkulaw.example/pfnl' }] }));",
      "} else {",
      "  process.exit(2);",
      "}",
    ].join("\n"));
    const service = new PkulawAuthorityService(createConfig(cli), dir, fakeLogger(), undefined, { ttlMs: 60_000 });

    const laws = await service.recognizeLawReferences({ text: "根据劳动合同法第39条", turnId: "turn_1", sessionId: "ses_1" });
    const citations = await service.validateCitations({
      param: { answerlaw: [{ title: "中华人民共和国劳动合同法", article_number: "39", text: "第三十九条..." }] },
      turnId: "turn_1",
      sessionId: "ses_1",
    });
    const cases = await service.recognizeCaseNumbers({ text: "参见（2024）浙0114破1-6号之二", turnId: "turn_1", sessionId: "ses_1" });

    expect(laws.status).toBe("success");
    expect(laws.items[0]).toMatchObject({ original: "中华人民共和国劳动合同法", source: "https://pkulaw.example/chl" });
    expect(citations.status).toBe("success");
    expect(citations.items[0]).toMatchObject({ title: "中华人民共和国劳动合同法", articleNumber: "39", url: "https://pkulaw.example/chl?tiao=39" });
    expect(cases.status).toBe("success");
    expect(cases.items[0]).toMatchObject({ court: "浙江省杭州市钱塘区人民法院", title: "指导性案例252号" });
  });

  it("cleans and limits rich markdown before calling text-based pkulaw tools", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pkulaw-authority-clean-"));
    const cli = path.join(dir, "pkulaw-mcp");
    const argvFile = path.join(dir, "argv.json");
    await writeExecutable(cli, [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      "fs.writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2)));",
      "console.log(JSON.stringify([{ text: '劳动合同法', original: '中华人民共和国劳动合同法', source: 'https://pkulaw.example/chl' }]));",
    ].join("\n"));
    const service = new PkulawAuthorityService(createConfig(cli), dir, fakeLogger(), undefined, { ttlMs: 60_000 });
    const previousArgvFile = process.env.ARGV_FILE;
    process.env.ARGV_FILE = argvFile;
    try {
      const richMarkdown = [
        "# XXX公司劳动合同解除争议｜证据链分析工作底稿",
        '<callout emoji="📌" background-color="light-blue" border-color="light-blue">',
        "根据《劳动合同法》第三十九条进行复核。",
        "</callout>",
        "```mermaid",
        "flowchart TD",
        "A[开始]",
        "```",
        "正文".repeat(4000),
      ].join("\n");

      const result = await service.recognizeLawReferences({ text: richMarkdown, turnId: "turn_1", sessionId: "ses_1" });
      const args = JSON.parse(await readFile(argvFile, "utf8")) as string[];
      const textArg = args[args.indexOf("--text") + 1] ?? "";

      expect(result.status).toBe("success");
      expect(textArg.length).toBeLessThanOrEqual(6000);
      expect(textArg).not.toContain("<callout");
      expect(textArg).not.toContain("```mermaid");
      expect(textArg).toContain("劳动合同法");
    } finally {
      if (previousArgvFile === undefined) {
        delete process.env.ARGV_FILE;
      } else {
        process.env.ARGV_FILE = previousArgvFile;
      }
    }
  });

  it("refreshes pkulaw tool cache once when dynamic tool commands are stale", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pkulaw-authority-retry-"));
    const cli = path.join(dir, "pkulaw-mcp");
    const stateFile = path.join(dir, "state");
    await writeExecutable(cli, [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      "const [tool, operation] = process.argv.slice(2);",
      "if (tool === 'update') { fs.writeFileSync(process.env.STATE_FILE, 'updated'); console.log('updated'); process.exit(0); }",
      "if (!fs.existsSync(process.env.STATE_FILE)) { console.error(\"error: unknown command 'law-semantic'\"); process.exit(1); }",
      "if (tool === 'law-semantic' && operation === 'search_article') {",
      "  console.log(JSON.stringify([{ title: '劳动合同法', article: '缓存刷新后可检索', url: 'https://pkulaw.example/law' }]));",
      "} else {",
      "  process.exit(2);",
      "}",
    ].join("\n"));
    const service = new PkulawAuthorityService(createConfig(cli), dir, fakeLogger(), undefined, { ttlMs: 60_000 });

    const previousStateFile = process.env.STATE_FILE;
    process.env.STATE_FILE = stateFile;
    try {
      const result = await service.searchLawSemantic({ query: "违法解除劳动合同", turnId: "turn_1", sessionId: "ses_1" });

      expect(result.status).toBe("success");
      expect(result.items[0]?.excerpt).toContain("缓存刷新后可检索");
    } finally {
      if (previousStateFile === undefined) {
        delete process.env.STATE_FILE;
      } else {
        process.env.STATE_FILE = previousStateFile;
      }
    }
  });
});

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);
}

function createConfig(cliCommand: string): KnowledgeBaseConfig {
  return {
    enabled: true,
    autoDetect: { enabled: false, minConfidence: 0.75 },
    query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
    storage: {
      sqlitePath: path.join(os.tmpdir(), "knowledge.db"),
      bitable: { appToken: "app", tableId: "tbl" },
    },
    models: {},
    ingest: {
      allowedExtensions: [".txt"],
      maxFileSizeMb: 20,
      pendingTtlMs: 60_000,
      sessionIdleMs: 60_000,
      concurrency: 1,
      maxExtractChunks: 10,
      maxExtractQas: 10,
    },
    parser: undefined,
    authoritySources: {
      pkulaw: {
        enabled: true,
        cliCommand,
        transport: "http",
        skills: {
          lawSemantic: { tool: "law-semantic", operation: "search_article" },
          lawRecognition: { tool: "law-recognition", operation: "law_recognition" },
          citationValidator: { tool: "citation-validator", operation: "adjust_provisions" },
          caseNumberRecognition: { tool: "case-number", operation: "anhao_recognition" },
        },
      },
    },
  };
}

function fakeLogger() {
  return {
    log: vi.fn(),
    logTranscript: vi.fn(),
  };
}
