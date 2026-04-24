/**
 * 职责: 提供共享工作台输出能力。
 * 关注点:
 * - 创建飞书文档工作台。
 * - 将 Mermaid 图更新到文档中的白板占位。
 */
import { spawn } from "node:child_process";

export type WorkbenchDocumentResult = {
  docUrl?: string | undefined;
  boardTokens: string[];
};

export type WorkbenchDiagram = {
  source: string;
};

export async function createWorkbenchDocument(title: string, markdown: string): Promise<WorkbenchDocumentResult> {
  const output = await runLarkCli(["docs", "+create", "--title", title, "--markdown", "-"], markdown);
  const parsed = parseJsonObject(output);
  const boardTokens = readStringArray(parsed, "board_tokens");
  const data = readRecord(parsed, "data");
  return {
    docUrl: readString(parsed, "doc_url") ?? readString(data, "doc_url"),
    boardTokens: boardTokens.length > 0 ? boardTokens : readStringArray(data, "board_tokens"),
  };
}

export async function updateWorkbenchBoards(boardTokens: string[], diagrams: WorkbenchDiagram[]): Promise<void> {
  for (const [index, boardToken] of boardTokens.slice(0, diagrams.length).entries()) {
    const source = withWhiteboardDslInstruction(diagrams[index]?.source ?? "");
    if (!source.trim()) {
      continue;
    }
    await runLarkCli([
      "whiteboard",
      "+update",
      "--whiteboard-token",
      boardToken,
      "--input_format",
      "mermaid",
      "--overwrite",
      "--yes",
      "--source",
      "-",
    ], source);
  }
}

export function withWhiteboardDslInstruction(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return trimmed;
  }
  return `%% 使用飞书白板内置DSL精确控制样式\n${trimmed}`;
}

async function runLarkCli(args: string[], stdinText?: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("lark-cli", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr || stdout || `lark-cli exited with code ${code ?? -1}`));
    });
    if (stdinText) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

function parseJsonObject(text: string): Record<string, unknown> {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return {};
  }
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readString(value: Record<string, unknown> | null, key: string): string | undefined {
  if (!value) return undefined;
  const target = value[key];
  return typeof target === "string" && target.trim() ? target.trim() : undefined;
}

function readStringArray(value: Record<string, unknown> | null, key: string): string[] {
  if (!value) return [];
  const target = value[key];
  if (!Array.isArray(target)) {
    return [];
  }
  return target.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function readRecord(value: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  if (!value) return null;
  const target = value[key];
  return target && typeof target === "object" && !Array.isArray(target)
    ? target as Record<string, unknown>
    : null;
}
