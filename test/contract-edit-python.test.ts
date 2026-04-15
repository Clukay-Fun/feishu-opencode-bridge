import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { spawnPythonTool } from "../src/utils/python-tool.js";

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
});
