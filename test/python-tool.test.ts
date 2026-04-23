import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { spawnPythonTool } from "../src/utils/python-tool.js";

describe("spawnPythonTool", () => {
  it("runs doc_to_text with unified stdin/stdout JSON protocol", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "python-tool-doc-to-text-"));
    try {
      const inputPath = path.join(tempDir, "demo.md");
      await writeFile(inputPath, "# 标题\n\n这里是正文。\n", "utf8");

      const result = await spawnPythonTool<{ text: string; format: string }>("doc_to_text", {
        inputPath,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.format).toBe("md");
        expect(result.data.text).toContain("这里是正文");
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs convert_document with the unified Markdown/text result protocol", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "python-tool-convert-document-"));
    try {
      const inputPath = path.join(tempDir, "demo.html");
      await writeFile(inputPath, "<h1>标题</h1><p>这里是正文。</p>", "utf8");

      const result = await spawnPythonTool<{
        markdown: string;
        plainText: string;
        sourceFormat: string;
        tool: string;
        fallbackChain: string[];
      }>("convert_document", {
        inputPath,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.sourceFormat).toBe("html");
        expect(result.data.markdown).toContain("这里是正文");
        expect(result.data.fallbackChain).toContain("html-text");
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs contract_parse on the bundled docx template", async () => {
    const inputPath = path.resolve(process.cwd(), "templates/contracts/委托代理合同-民事.docx");

    const result = await spawnPythonTool<{
      title: string;
      clauses: Array<{ number: string; title: string; content: string }>;
      rawText: string;
    }>("contract_parse", {
      inputPath,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.title).toContain("合同");
      expect(Array.isArray(result.data.clauses)).toBe(true);
      expect(result.data.rawText.length).toBeGreaterThan(20);
    }
  });
});
