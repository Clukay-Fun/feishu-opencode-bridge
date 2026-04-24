import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePythonCommand, spawnPythonTool } from "../src/utils/python-tool.js";

const TEMPLATE_PATH = path.resolve(process.cwd(), "templates/contracts/委托代理合同-民事.docx");

type DocxInspectResult = {
  hasDocumentXml: boolean;
  headers: string[];
  footers: string[];
  hasRevisions: boolean;
  revisionParts: string[];
};

type DocxAnalyzeResult = {
  candidateCount: number;
  singleRunReachableCount: number;
  paragraphOnlyReachableCount: number;
  singleRunCoverageRate: number;
  items: Array<{
    candidate: string;
    singleRunReachable: boolean;
    paragraphReachable: boolean;
  }>;
};

type DocxReplaceResult = {
  outputPath: string;
  replacementCount: number;
  changedTextNodeCount: number;
  structureUnchanged: boolean;
  xmlDiffLineCount: number;
  hasRevisionsBefore: boolean;
  hasRevisionsAfter: boolean;
};

describe("docx_edit python PoC", () => {
  it("inspects a real contract docx and reports package boundaries", async () => {
    const result = await spawnPythonTool<DocxInspectResult>("docx_edit", {
      action: "inspect",
      inputPath: TEMPLATE_PATH,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.hasDocumentXml).toBe(true);
    expect(result.data.headers.length).toBeGreaterThan(0);
    expect(result.data.footers.length).toBeGreaterThan(0);
    expect(result.data.hasRevisions).toBe(true);
    expect(result.data.revisionParts).toContain("word/document.xml");
  });

  it("analyzes candidate phrases and quantifies single-run reachability", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "docx-edit-analyze-"));
    try {
      const candidatesPath = path.join(tempDir, "candidates.txt");
      await writeFile(candidatesPath, [
        "委托代理合同",
        "北京市隆安（深圳）律师事务所",
        "风险代理告知书",
        "聘请方（甲方）：",
        "甲方：",
        "乙方：",
      ].join("\n"), "utf8");

      const result = await spawnPythonTool<DocxAnalyzeResult>("docx_edit", {
        action: "analyze",
        inputPath: TEMPLATE_PATH,
        candidatesPath,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.data.candidateCount).toBe(6);
      expect(result.data.singleRunReachableCount).toBe(5);
      expect(result.data.paragraphOnlyReachableCount).toBe(1);
      expect(result.data.singleRunCoverageRate).toBeCloseTo(5 / 6, 5);
      expect(result.data.items.find((item) => item.candidate === "聘请方（甲方）：")).toEqual(expect.objectContaining({
        paragraphReachable: true,
        singleRunReachable: false,
      }));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("replaces only single-run text and keeps document structure stable", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "docx-edit-replace-"));
    try {
      const outputPath = path.join(tempDir, "edited.docx");
      const replaceResult = await spawnPythonTool<DocxReplaceResult>("docx_edit", {
        action: "replace",
        inputPath: TEMPLATE_PATH,
        outputPath,
        from: "风险代理告知书",
        to: "风险代理告知书（测试）",
      });

      expect(replaceResult.ok).toBe(true);
      if (!replaceResult.ok) {
        return;
      }
      expect(replaceResult.data.replacementCount).toBe(2);
      expect(replaceResult.data.changedTextNodeCount).toBe(2);
      expect(replaceResult.data.structureUnchanged).toBe(true);
      expect(replaceResult.data.xmlDiffLineCount).toBeLessThanOrEqual(10);
      expect(replaceResult.data.hasRevisionsBefore).toBe(true);
      expect(replaceResult.data.hasRevisionsAfter).toBe(true);

      const textResult = await spawnPythonTool<{ text: string; format: string }>("doc_to_text", {
        inputPath: replaceResult.data.outputPath,
      });
      expect(textResult.ok).toBe(true);
      if (!textResult.ok) {
        return;
      }
      expect(textResult.data.format).toBe("docx");
      expect(textResult.data.text).toContain("风险代理告知书（测试）");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("unpacks and repacks a docx package", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "docx-edit-pack-"));
    try {
      const unpackDir = path.join(tempDir, "unpacked");
      const repackedPath = path.join(tempDir, "repacked.docx");
      const unpackResult = await spawnPythonTool<{ hasDocumentXml: boolean; partCount: number }>("docx_edit", {
        action: "unpack",
        inputPath: TEMPLATE_PATH,
        outputDir: unpackDir,
      });
      expect(unpackResult.ok).toBe(true);
      if (!unpackResult.ok) {
        return;
      }
      expect(unpackResult.data.hasDocumentXml).toBe(true);

      const packResult = await spawnPythonTool<{ hasDocumentXml: boolean; partCount: number }>("docx_edit", {
        action: "pack",
        inputDir: unpackDir,
        outputPath: repackedPath,
      });
      expect(packResult.ok).toBe(true);
      if (!packResult.ok) {
        return;
      }
      expect(packResult.data.hasDocumentXml).toBe(true);
      expect(packResult.data.partCount).toBeGreaterThan(0);
      expect(packResult.data.partCount).toBeLessThanOrEqual(unpackResult.data.partCount);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns structured failures for unsupported and malformed inputs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "docx-edit-invalid-"));
    try {
      const nonDocxResult = await spawnPythonTool("docx_edit", {
        action: "inspect",
        inputPath: path.resolve(process.cwd(), "package.json"),
      });
      expect(nonDocxResult.ok).toBe(false);
      if (!nonDocxResult.ok) {
        expect(nonDocxResult.error).toContain(".docx");
      }

      const malformedPath = path.join(tempDir, "missing-document.docx");
      await createZipWithoutDocumentXml(malformedPath);
      const missingDocumentResult = await spawnPythonTool("docx_edit", {
        action: "inspect",
        inputPath: malformedPath,
      });
      expect(missingDocumentResult.ok).toBe(true);
      if (missingDocumentResult.ok) {
        expect((missingDocumentResult.data as { hasDocumentXml: boolean }).hasDocumentXml).toBe(false);
      }

      const replaceResult = await spawnPythonTool("docx_edit", {
        action: "replace",
        inputPath: malformedPath,
        outputPath: path.join(tempDir, "out.docx"),
        from: "missing",
        to: "value",
      });
      expect(replaceResult.ok).toBe(false);
      if (!replaceResult.ok) {
        expect(replaceResult.error).toContain("word/document.xml");
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function createZipWithoutDocumentXml(outputPath: string): Promise<void> {
  const python = await resolvePythonCommand();
  if (!python) {
    throw new Error("未找到可用的 Python 解释器");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, ["-", outputPath], {
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
      "import sys, zipfile",
      "with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as package:",
      "    package.writestr('[Content_Types].xml', '<Types></Types>')",
    ].join("\n"));
    child.stdin.end();
  });
}
