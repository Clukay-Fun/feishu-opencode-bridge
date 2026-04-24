/**
 * 职责: 串联案件工作流中的共享输出步骤。
 * 关注点:
 * - 接收领域模块生成的 Markdown 与图表。
 * - 统一创建工作台文档并更新白板图。
 */
import type { Logger } from "../logging/logger.js";
import {
  createWorkbenchDocument,
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
  createDocument?: ((title: string, markdown: string) => Promise<WorkbenchDocumentResult>) | undefined;
  updateBoards?: ((boardTokens: string[], diagrams: WorkbenchDiagram[]) => Promise<void>) | undefined;
}): Promise<CaseWorkflowWorkbenchResult> {
  await input.onProgress?.("正在生成飞书工作台文档");
  const createDocument = input.createDocument ?? createWorkbenchDocument;
  const updateBoards = input.updateBoards ?? updateWorkbenchBoards;
  const docResult = await createDocument(input.title, input.markdown).catch((error) => {
    input.logger.log(input.logScope, "create workbench document failed", {
      detail: error instanceof Error ? error.message : String(error),
    }, "warn");
    return undefined;
  });

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
