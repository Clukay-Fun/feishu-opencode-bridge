/**
 * 职责: 覆盖北大法宝 law-semantic 适配层。
 * 关注点:
 * - 验证 CLI 输出归一化、缓存和降级状态。
 * - 确认缓存命中不重复记录外部调用成本。
 */
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
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
