import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PDF_TO_MD_SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/pdf_to_md.py",
);

export type PdfMarkdownResult = {
  markdown: string;
  parserUsed: "pymupdf4llm" | "docling";
};

export async function spawnPdfToMarkdown(inputPath: string): Promise<PdfMarkdownResult> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "bridge-pdf-md-"));
  const outputPath = path.join(tempDir, "output.md");
  const pythonCommands = dedupeCommands([
    process.env.KNOWLEDGE_PDF_TO_MD_PYTHON,
    process.env.PYTHON,
    "python3",
    "python",
  ]);

  let lastError: Error | null = null;
  try {
    for (const command of pythonCommands) {
      try {
        const parserUsed = await runPdfToMarkdownCommand(command, inputPath, outputPath);
        const markdown = (await readFile(outputPath, "utf8")).trim();
        if (!markdown) {
          throw new Error("Python PDF 转 Markdown 脚本未生成内容");
        }
        return { markdown, parserUsed };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  throw lastError ?? new Error("未找到可用的 Python 解释器");
}

async function runPdfToMarkdownCommand(
  command: string,
  inputPath: string,
  outputPath: string,
): Promise<"pymupdf4llm" | "docling"> {
  return await new Promise<"pymupdf4llm" | "docling">((resolve, reject) => {
    const child = spawn(command, [PDF_TO_MD_SCRIPT_PATH, inputPath, outputPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        const parserUsed = stdout.trim();
        if (parserUsed === "pymupdf4llm" || parserUsed === "docling") {
          resolve(parserUsed);
          return;
        }
        reject(new Error("Python PDF 转 Markdown 未返回解析器标识"));
        return;
      }
      reject(new Error(stderr.trim() || `Python PDF 转 Markdown 失败（退出码 ${code ?? "unknown"}）`));
    });
  });
}

function dedupeCommands(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}
