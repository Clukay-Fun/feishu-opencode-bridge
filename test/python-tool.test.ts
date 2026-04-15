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
