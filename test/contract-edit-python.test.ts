/**
 * 职责: 覆盖Python 合同编辑脚本调用链路。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePythonCommand, spawnPythonTool } from "../src/utils/python-tool.js";

describe("contract_edit python tool", () => {
  it("deletes appendix content by heading and preserves edited docx output", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "contract-edit-python-"));
    try {
      const inputPath = path.resolve(process.cwd(), "templates/contracts/委托代理合同-民事.docx");
      const outputPath = path.join(tempDir, "edited.docx");

      const editResult = await spawnPythonTool<{
        outputPath: string;
        appliedOps: number;
        skippedOps: Array<Record<string, unknown>>;
      }>("contract_edit", {
        inputPath,
        outputPath,
        operations: [
          {
            type: "delete_by_heading",
            heading: "风险代理告知书",
          },
        ],
      });

      expect(editResult.ok).toBe(true);
      if (!editResult.ok) {
        return;
      }
      expect(editResult.data.appliedOps).toBe(1);

      const textResult = await spawnPythonTool<{ text: string; format: string }>("doc_to_text", {
        inputPath: editResult.data.outputPath,
      });
      expect(textResult.ok).toBe(true);
      if (!textResult.ok) {
        return;
      }
      expect(textResult.data.text).not.toContain("风险代理告知书");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("deletes a logical page split by explicit page breaks", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "contract-edit-page-delete-"));
    try {
      const inputPath = path.join(tempDir, "paged.docx");
      const outputPath = path.join(tempDir, "paged-edited.docx");
      await createPagedDocx(inputPath);

      const editResult = await spawnPythonTool<{
        outputPath: string;
        appliedOps: number;
        skippedOps: Array<Record<string, unknown>>;
      }>("contract_edit", {
        inputPath,
        outputPath,
        operations: [
          {
            type: "delete_pages",
            pageRange: [2, 2],
          },
        ],
      });

      expect(editResult.ok).toBe(true);
      if (!editResult.ok) {
        return;
      }
      expect(editResult.data.appliedOps).toBe(1);

      const textResult = await spawnPythonTool<{ text: string; format: string }>("doc_to_text", {
        inputPath: editResult.data.outputPath,
      });
      expect(textResult.ok).toBe(true);
      if (!textResult.ok) {
        return;
      }
      expect(textResult.data.text).toContain("第一页内容");
      expect(textResult.data.text).not.toContain("第二页内容");
      expect(textResult.data.text).toContain("第三页内容");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function createPagedDocx(inputPath: string): Promise<void> {
  const python = await resolvePythonCommand();
  if (!python) {
    throw new Error("未找到可用的 Python 解释器");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, ["-", inputPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `python exited with ${code ?? "unknown"}`));
    });
    child.stdin.write([
      "import sys",
      "from docx import Document",
      "doc = Document()",
      "doc.add_paragraph('第一页内容')",
      "doc.add_page_break()",
      "doc.add_paragraph('第二页内容')",
      "doc.add_page_break()",
      "doc.add_paragraph('第三页内容')",
      "doc.save(sys.argv[1])",
    ].join("\n"));
    child.stdin.end();
  });
}
