import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ContractAssistantService } from "../src/contract-assistant/index.js";
import {
  buildPromptFromSkillOverride,
  buildPromptFromSkillOverrideAsync,
} from "../src/contract-assistant/prompt-overrides.js";

const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

async function createSkillFile(
  tempHome: string,
  skillName: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = path.join(tempHome, ".opencode", "skills", skillName, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

function createService(postMessageSync: (sessionId: string, request: { parts: Array<{ text?: string }> }) => Promise<unknown>) {
  return new ContractAssistantService(
    {
      enabled: true,
      storage: {
        baseToken: "app_token",
        contractTableId: "tbl_contract",
        invoiceTableId: "tbl_invoice",
        caseTableId: "tbl_case",
      },
      models: {},
      ingest: {
        contractAllowedExtensions: [".pdf", ".docx", ".txt", ".md"],
        invoiceAllowedExtensions: [".pdf", ".png", ".jpg", ".jpeg", ".webp"],
        maxFileSizeMb: 20,
        pendingTtlMs: 60_000,
      },
      reminder: {
        enabled: false,
        targetChatIds: [],
        hour: 9,
        minute: 0,
        lookaheadDays: 7,
      },
    },
    "/tmp",
    {
      createBitableRecord: async () => "rec_1",
      listBitableRecords: async () => [],
      updateBitableRecord: async () => undefined,
      downloadMessageResource: async () => {
        throw new Error("not needed");
      },
    } as never,
    {
      createSession: async () => ({ id: "ses_1", title: "test" }),
      postMessageSync,
      deleteSession: async () => undefined,
    } as never,
    {
      log: () => undefined,
    } as never,
  );
}

describe("contract prompt overrides", () => {
  it("loads sync and async prompt templates from the skill directory", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "contract-prompt-override-"));
    process.env.HOME = tempHome;

    try {
      await createSkillFile(tempHome, "contract-draft", "references/prompt.txt", "模板 {{name}}");
      await createSkillFile(tempHome, "case-manage", "references/create-prompt.txt", "案件 {{request}}");

      expect(buildPromptFromSkillOverride(
        "contract-draft",
        ["references/runtime-prompt.txt", "references/prompt.txt"],
        { name: "A" },
        () => "fallback",
      )).toBe("模板 A");

      await expect(buildPromptFromSkillOverrideAsync(
        "case-manage",
        ["references/create-prompt.txt"],
        { request: "更新" },
        () => "fallback",
      )).resolves.toBe("案件 更新");
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("falls back to built-in prompts when no skill override exists", () => {
    process.env.HOME = "/tmp/non-existent-home";

    expect(buildPromptFromSkillOverride(
      "contract-draft",
      ["references/prompt.txt"],
      { name: "A" },
      () => "fallback",
    )).toBe("fallback");
  });

  it("uses externalized contract-assistant prompts for workbench flows", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "contract-assistant-skill-"));
    process.env.HOME = tempHome;

    try {
      await createSkillFile(
        tempHome,
        "contract-assistant",
        "references/workbench-init-from-prompt.txt",
        [
          "外置初始化模板",
          "需求：{{request}}",
        ].join("\n"),
      );
      await createSkillFile(
        tempHome,
        "contract-assistant",
        "references/workbench-apply-prompt.txt",
        [
          "外置编辑模板",
          "{{recentMessagesBlock}}",
          "状态：{{contractStateJson}}",
          "指令：{{userMessage}}",
        ].join("\n"),
      );

      const seenPrompts: string[] = [];
      const responses = [
        JSON.stringify({
          state: {
            title: "外置初始化合同",
            sourceMode: "freeform_prompt",
            parties: {
              clientName: "甲方",
              counterpartyName: "乙方",
            },
            clauses: [
              { number: "第一条", title: "委托事项", content: "【待补】" },
            ],
            appendices: [],
          },
          message: "初始化完成",
        }),
        JSON.stringify({
          action: "reject",
          message: "仅测试外置编辑 prompt",
        }),
      ];

      const service = createService(async (_sessionId, request) => {
        seenPrompts.push(String(request.parts[0]?.text ?? ""));
        return {
          parts: [{ type: "text", text: responses.shift() ?? "{}" }],
        };
      });

      await service.initializeWorkbenchFromPrompt("session-1", "起草一份劳动仲裁委托代理合同");
      await service.applyWorkbenchMessage({
        sessionId: "session-1",
        sourceMode: "freeform_prompt",
        title: "合同草稿",
        parties: {
          clientName: "甲方",
          counterpartyName: "乙方",
        },
        clauses: [{ id: "c1", number: "第一条", title: "委托事项", content: "【待补】" }],
        appendices: [],
        version: 1,
        history: [],
      }, ["上一轮：查看第一条"], "删除风险条款");

      expect(seenPrompts[0]).toContain("外置初始化模板");
      expect(seenPrompts[0]).toContain("需求：起草一份劳动仲裁委托代理合同");
      expect(seenPrompts[1]).toContain("外置编辑模板");
      expect(seenPrompts[1]).toContain("最近上下文：");
      expect(seenPrompts[1]).toContain("1. 上一轮：查看第一条");
      expect(seenPrompts[1]).toContain("指令：删除风险条款");
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });
});
