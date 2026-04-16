import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildContractTemplateRenderData,
  ContractAssistantService,
  inferFeeModeFromRequest,
  normalizeBitableDateValue,
  parseContractDraftRequest,
  postProcessContractDraftMarkdown,
  resolveNumberedOutputPath,
  splitRiskNotice,
  validateContractDraftRequest,
} from "../src/contract-assistant/index.js";
import { spawnPythonTool } from "../src/utils/python-tool.js";

describe("contract draft template helpers", () => {
  it("splits risk notice attachment from main template", () => {
    const source = [
      "第一条 主合同",
      "第二条 主合同",
      "附件",
      "风险代理告知书",
      "这里是风险附件",
    ].join("\n");

    const result = splitRiskNotice(source);

    expect(result.mainText).toContain("第一条 主合同");
    expect(result.mainText).not.toContain("风险代理告知书");
    expect(result.riskNoticeText).toContain("风险代理告知书");
  });

  it("removes risk notice section when fee mode is stage_fixed", () => {
    const markdown = [
      "### 合同正文",
      "",
      "第一条 内容",
      "",
      "附件",
      "风险代理告知书",
      "附件内容",
    ].join("\n");

    expect(postProcessContractDraftMarkdown(markdown, "stage_fixed")).not.toContain("风险代理告知书");
    expect(postProcessContractDraftMarkdown(markdown, "base_plus_risk")).toContain("风险代理告知书");
  });

  it("infers risk fee mode from request keywords", () => {
    expect(inferFeeModeFromRequest("采用风险代理，按回款比例收取律师费")).toBe("base_plus_risk");
    expect(inferFeeModeFromRequest("仲裁阶段固定收费 8000 元")).toBe("stage_fixed");
  });

  it("normalizes natural-language contract dates for bitable", () => {
    const today = normalizeBitableDateValue("今天", new Date(2026, 3, 15, 9, 30, 0));
    const explicit = normalizeBitableDateValue("2026-04-15");

    expect(today).toBe(new Date(2026, 3, 15).getTime());
    expect(explicit).toBe(new Date(2026, 3, 15).getTime());
  });

  it("allocates numbered draft paths without embedding timestamps", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "contract-draft-template-"));
    const outputDir = path.join(tempDir, "contract-drafts");
    await mkdir(outputDir, { recursive: true });

    try {
      const first = await resolveNumberedOutputPath(outputDir, "委托代理合同（XXXvsXXX公司）", ".docx");
      await writeFile(first, "stub");
      const second = await resolveNumberedOutputPath(outputDir, "委托代理合同（XXXvsXXX公司）", ".docx");

      expect(path.basename(first)).toBe("委托代理合同（XXXvsXXX公司）.docx");
      expect(path.basename(second)).toBe("委托代理合同（XXXvsXXX公司）-2.docx");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses required fields and stage fee from one-shot委托代理合同 request", () => {
    const request = "甲方（委托人）：张三，身份证号：110101199001010011，住址：北京市朝阳区建国路88号，联系电话：13800000000。甲方因与相关单位发生劳动争议，现委托乙方作为其代理人，代理处理劳动仲裁相关事宜。双方经协商一致，确认本次代理事项为劳动仲裁，代理费用为人民币20,000元（大写：贰万元整）。";

    const parsed = parseContractDraftRequest(request);

    expect(parsed.clientName).toBe("张三");
    expect(parsed.clientIdCode).toBe("110101199001010011");
    expect(parsed.clientAddress).toBe("北京市朝阳区建国路88号");
    expect(parsed.clientPhone).toBe("13800000000");
    expect(parsed.counterpartyName).toBe("相关单位");
    expect(parsed.caseCause).toBe("劳动争议");
    expect(parsed.engageArbitration).toBe(true);
    expect(parsed.arbitrationFee).toBe(20000);
    expect(parsed.arbitrationFeeChinese).toBe("贰万元整");
  });

  it("requires identity, address and phone for 委托代理合同", () => {
    expect(() => validateContractDraftRequest("委托代理合同-民事", "甲方：张三")).toThrow(/缺少必填信息/);
  });

  it("prefers deterministic request fields and removes unselected fee blocks", () => {
    const request = "甲方（委托人）：张三，身份证号：110101199001010011，住址：北京市朝阳区建国路88号，联系电话：13800000000。甲方因与相关单位发生劳动争议，现委托乙方作为其代理人，代理处理劳动仲裁及调解和解事宜。双方经协商一致，确认本次代理事项为劳动仲裁，代理费用为人民币20,000元（大写：贰万元整）。";

    const renderData = buildContractTemplateRenderData(request, null, null, "stage_fixed");

    expect(renderData.client_name).toBe("张三");
    expect(renderData.client_id_code).toBe("110101199001010011");
    expect(renderData.client_address).toBe("北京市朝阳区建国路88号");
    expect(renderData.client_phone).toBe("13800000000");
    expect(renderData.arbitration_line).toContain("☑仲裁阶段");
    expect(renderData.first_instance_line).toBe("");
    expect(renderData.risk_fee_line).toBe("");
    expect(renderData.fee_arbitration_clause).toContain("￥20,000.00元");
    expect(renderData.fee_first_instance_clause).toBe("");
    expect(renderData.show_risk_notice).toBe(false);
    expect(renderData.risk_notice_client_name).toBe("");
  });

  it("fills required fields and removes unselected sections in generated 委托代理合同 word", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "contract-draft-render-"));
    const service = new ContractAssistantService(
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
      tempDir,
      {
        createBitableRecord: async () => "rec_1",
        listBitableRecords: async () => [],
        updateBitableRecord: async () => undefined,
        resolveFileToLocalPath: async () => {
          throw new Error("not needed");
        },
      } as never,
      {
        createSession: async () => ({ id: "ses_1", title: "test" }),
        postMessageSync: async () => {
          throw new Error("fetch failed");
        },
        deleteSession: async () => undefined,
      } as never,
      {
        log: () => undefined,
      } as never,
    );
    const request = "/起草合同 甲方（委托人）：张三，身份证号：110101199001010011，住址：北京市朝阳区建国路88号，联系电话：13800000000。甲方因与相关单位发生劳动争议，现委托乙方作为其代理人，代理处理劳动仲裁相关事宜。双方经协商一致，确认本次代理事项为劳动仲裁，代理费用为人民币20,000元（大写：贰万元整）。";

    try {
      const result = await service.draftContract(request);
      const textResult = await spawnPythonTool<{ text: string; format: string }>("doc_to_text", {
        inputPath: result.wordPath,
      });

      expect(textResult.ok).toBe(true);
      if (!textResult.ok) {
        return;
      }

      const text = textResult.data.text;
      expect(text).toContain("聘请方（甲方）：张三");
      expect(text).toContain("甲方：张三");
      expect(text).toContain("证件号/社会统一信用代码：110101199001010011");
      expect(text).toContain("地址：北京市朝阳区建国路88号");
      expect(text).toContain("联系电话：13800000000");
      expect(text).toContain("☑仲裁阶段；");
      expect(text).not.toContain("☐一审诉讼；");
      expect(text).not.toContain("☐二审诉讼；");
      expect(text).not.toContain("☐执行程序；");
      expect(text).toContain("律师代理费为￥20,000.00元（大写人民币贰万元整）");
      expect(text).not.toContain("2.一审阶段：律师代理费为【待补】");
      expect(text).not.toContain("☐基础收费+风险收费");
      expect(text).not.toContain("风险代理告知书");
      expect(result.warnings).toContain("模型暂不可用，已按本地规则生成合同初稿。");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
