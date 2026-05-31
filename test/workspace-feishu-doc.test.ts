/**
 * 职责: 覆盖飞书云文档 URL 解析和适配器基础行为。
 * 关注点: URL 解析、lark-cli 不可用降级。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseFeishuDocUrl, FeishuDocAdapter } from "../src/workspace/feishu-doc-adapter.js";
import { DocumentOperationJournal } from "../src/workspace/journal-db.js";

function createLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), logTranscript: vi.fn() };
}

describe("parseFeishuDocUrl", () => {
  it("parses docx URL", () => {
    const result = parseFeishuDocUrl("https://xxx.feishu.cn/docx/ABC123");
    expect(result).toEqual({ type: "docx", token: "ABC123" });
  });

  it("parses wiki URL", () => {
    const result = parseFeishuDocUrl("https://xxx.feishu.cn/wiki/DEF456");
    expect(result).toEqual({ type: "wiki", token: "DEF456" });
  });

  it("parses sheet URL", () => {
    const result = parseFeishuDocUrl("https://xxx.feishu.cn/sheets/GHI789");
    expect(result).toEqual({ type: "sheet", token: "GHI789" });
  });

  it("parses base URL", () => {
    const result = parseFeishuDocUrl("https://xxx.feishu.cn/base/JKL012");
    expect(result).toEqual({ type: "base", token: "JKL012" });
  });

  it("returns null for non-feishu URLs", () => {
    expect(parseFeishuDocUrl("https://example.com/doc")).toBeNull();
  });

  it("returns null for malformed URLs", () => {
    expect(parseFeishuDocUrl("not-a-url")).toBeNull();
  });
});

describe("FeishuDocAdapter", () => {
  it("degrades gracefully when lark-cli is unavailable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "feishu-doc-adapter-"));
    try {
      const logger = createLogger();
      const journal = new DocumentOperationJournal(path.join(dir, "journal.db"));
      const adapter = new FeishuDocAdapter(logger as never, journal);

      // 强制标记为不可用
      (adapter as any).larkCliAvailable = false;

      await expect(adapter.fetch("https://xxx.feishu.cn/docx/ABC123"))
        .rejects.toThrow("lark-cli 不可用");

      journal.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid URLs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "feishu-doc-invalid-"));
    try {
      const logger = createLogger();
      const journal = new DocumentOperationJournal(path.join(dir, "journal.db"));
      const adapter = new FeishuDocAdapter(logger as never, journal);

      await expect(adapter.fetch("https://example.com/not-feishu"))
        .rejects.toThrow("不是有效的飞书云文档 URL");

      journal.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
