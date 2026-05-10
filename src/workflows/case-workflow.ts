/**
 * 职责: 串联案件工作流中的共享输出步骤。
 * 关注点:
 * - 接收领域模块生成的 Markdown 与图表。
 * - 统一创建工作台文档并更新白板图。
 */
import type { Logger } from "../logging/logger.js";
import {
  createWorkbenchPreviewDocument,
  updateWorkbenchDocument,
  updateWorkbenchBoards,
  type WorkbenchDiagram,
  type WorkbenchDocumentResult,
} from "./workbench-generate.js";

export type CaseWorkflowWorkbenchResult = {
  docUrl?: string | undefined;
};

export async function generateCaseWorkflowWorkbench(input: {
  title: string;
  markdown: string;
  diagrams: WorkbenchDiagram[];
  logger: Pick<Logger, "log">;
  logScope: string;
  onProgress?: ((step: string) => Promise<void> | void) | undefined;
  onPreviewCreated?: ((docUrl: string) => Promise<void> | void) | undefined;
  createDocument?: ((title: string, markdown: string) => Promise<WorkbenchDocumentResult>) | undefined;
  createPreviewDocument?: ((title: string) => Promise<WorkbenchDocumentResult>) | undefined;
  updateDocument?: ((docUrl: string, title: string, markdown: string) => Promise<WorkbenchDocumentResult>) | undefined;
  updateBoards?: ((boardTokens: string[], diagrams: WorkbenchDiagram[]) => Promise<void>) | undefined;
}): Promise<CaseWorkflowWorkbenchResult> {
  const createDocument = input.createDocument;
  const updateBoards = input.updateBoards ?? updateWorkbenchBoards;
  const docResult = createDocument
    ? await createWorkbenchDocumentOnce(input, createDocument)
    : await createWorkbenchDocumentProgressively(input);

  if (docResult?.boardTokens?.length) {
    await input.onProgress?.("正在生成时间线、关系图和思维导图");
    await updateBoards(docResult.boardTokens, input.diagrams).catch((error) => {
      input.logger.log(input.logScope, "update workbench boards failed", {
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
    });
  }

  return {
    docUrl: docResult?.docUrl,
  };
}

async function createWorkbenchDocumentOnce(
  input: {
    title: string;
    markdown: string;
    logger: Pick<Logger, "log">;
    logScope: string;
    onProgress?: ((step: string) => Promise<void> | void) | undefined;
  },
  createDocument: (title: string, markdown: string) => Promise<WorkbenchDocumentResult>,
): Promise<WorkbenchDocumentResult | undefined> {
  await input.onProgress?.("正在生成飞书工作台文档");
  return await createDocument(input.title, input.markdown).catch((error) => {
    input.logger.log(input.logScope, "create workbench document failed", {
      detail: error instanceof Error ? error.message : String(error),
    }, "warn");
    return undefined;
  });
}

async function createWorkbenchDocumentProgressively(input: {
  title: string;
  markdown: string;
  logger: Pick<Logger, "log">;
  logScope: string;
  onProgress?: ((step: string) => Promise<void> | void) | undefined;
  onPreviewCreated?: ((docUrl: string) => Promise<void> | void) | undefined;
  createPreviewDocument?: ((title: string) => Promise<WorkbenchDocumentResult>) | undefined;
  updateDocument?: ((docUrl: string, title: string, markdown: string) => Promise<WorkbenchDocumentResult>) | undefined;
}): Promise<WorkbenchDocumentResult | undefined> {
  const createPreviewDocument = input.createPreviewDocument ?? createWorkbenchPreviewDocument;
  const updateDocument = input.updateDocument ?? updateWorkbenchDocument;

  await input.onProgress?.("正在创建飞书工作台预览文档");
  const preview = await createPreviewDocument(input.title).catch((error) => {
    input.logger.log(input.logScope, "create workbench preview document failed", {
      detail: error instanceof Error ? error.message : String(error),
    }, "warn");
    return undefined;
  });
  if (!preview?.docUrl) {
    return undefined;
  }
  await input.onPreviewCreated?.(preview.docUrl);

  let latest: WorkbenchDocumentResult = preview;
  const stages = buildWorkbenchWriteStages(input.markdown);
  for (const [index, markdown] of stages.entries()) {
    await input.onProgress?.(`正在写入飞书工作台文档（${index + 1}/${stages.length}）`);
    const updated = await updateDocument(preview.docUrl, input.title, markdown).catch((error) => {
      input.logger.log(input.logScope, "update workbench document failed", {
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
      return undefined;
    });
    if (updated) {
      latest = {
        docUrl: updated.docUrl ?? preview.docUrl,
        boardTokens: updated.boardTokens.length > 0 ? updated.boardTokens : latest.boardTokens,
      };
    }
  }

  return latest;
}

function buildWorkbenchWriteStages(markdown: string): string[] {
  const lines = markdown.split("\n");
  if (lines.length < 30) {
    return [markdown];
  }
  const cutPoints = [
    Math.max(10, Math.floor(lines.length * 0.35)),
    Math.max(20, Math.floor(lines.length * 0.7)),
    lines.length,
  ];
  const stages: string[] = [];
  for (const cutPoint of cutPoints) {
    const content = lines.slice(0, cutPoint).join("\n").trim();
    if (content && stages[stages.length - 1] !== content) {
      stages.push(content);
    }
  }
  return stages.length > 0 ? stages : [markdown];
}
