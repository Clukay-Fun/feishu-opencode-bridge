/**
 * 职责: 覆盖合同工作台导出 Word 文档流程。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ContractAssistantService, type ContractState } from "../src/contract-assistant/index.js";

describe("ContractAssistantService exportWorkbenchWord", () => {
  it("renders a docx through the python pipeline", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "contract-workbench-export-"));
    try {
      const service = new ContractAssistantService(
        {
          enabled: true,
          storage: {
            baseToken: "",
            contractTableId: "",
            invoiceTableId: "",
            caseTableId: "",
          },
          models: {},
          ingest: {
            contractAllowedExtensions: [".pdf", ".docx", ".txt", ".md"],
            invoiceAllowedExtensions: [".pdf", ".png"],
            maxFileSizeMb: 20,
            pendingTtlMs: 60_000,
          },
        },
        tempDir,
        {
          downloadMessageResource: async () => {
            throw new Error("not used");
          },
          createBitableRecord: async () => {
            throw new Error("not used");
          },
          listBitableRecords: async () => [],
          updateBitableRecord: async () => undefined,
        },
        {
          createSession: async () => {
            throw new Error("not used");
          },
          postMessageSync: async () => {
            throw new Error("not used");
          },
          deleteSession: async () => true,
        },
        { log: () => undefined } as never,
      );

      const state: ContractState = {
        sessionId: "session-1",
        sourceMode: "freeform_prompt",
        title: "委托代理合同（XXXvsXXX公司）",
        parties: {
          clientName: "XXX",
          counterpartyName: "XXX公司",
          agencyName: "XXX机构",
          leadLawyer: "XXX律师",
          signDate: "2026-04-15",
        },
        clauses: [
          {
            id: "clause-1",
            number: "第一条",
            title: "委托事项",
            content: "甲方委托乙方处理劳动争议仲裁事宜。",
          },
          {
            id: "clause-2",
            number: "第二条",
            title: "收费方式",
            content: "按阶段收费，仲裁阶段律师费为 8000 元。",
          },
        ],
        appendices: [
          {
            id: "appendix-1",
            title: "附件一：特别约定",
            content: "本合同导出后用于合同工作台演示。",
          },
        ],
        version: 2,
        history: [
          { version: 1, summary: "初始化完成", at: "2026-04-15T00:00:00.000Z" },
          { version: 2, summary: "删除风险收费部分", at: "2026-04-15T00:10:00.000Z" },
        ],
      };

      const result = await service.exportWorkbenchWord(state, {
        suggestedFileName: "委托代理合同（XXXvsXXX公司）-工作台",
      });

      expect(result.wordPath.endsWith(".docx")).toBe(true);
      await expect(stat(result.wordPath)).resolves.toBeTruthy();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
