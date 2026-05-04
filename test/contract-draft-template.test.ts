/**
 * 职责: 覆盖合同模板匹配和文档生成流程。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildContractTemplateRenderData,
  ContractAssistantService,
  inferFeeModeFromRequest,
  normalizeBitableDateValue,
  normalizeCaseRecord,
  normalizeInvoiceRecord,
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

  it("parses the labor demo one-shot委托代理合同 request without colon separators", () => {
    const request = "使用《委托代理合同-民事》模板。甲方张某某，身份证号330100199003010011，住址杭州市西湖区文三路附近，联系电话13800000000；对方为杭州XX科技有限公司；案由为违法解除劳动合同争议；委托程序选择劳动仲裁、调解和解；授权方式为一般授权；收费模式为按阶段收费，仲裁阶段律师费20000元，办案费用实报实销；承办律师刘达律师；特别约定：AI 生成文本仅作为合同草稿，需经承办律师复核后签署。";

    const parsed = parseContractDraftRequest(request);
    const renderData = buildContractTemplateRenderData(request, null, null, "stage_fixed");

    expect(() => validateContractDraftRequest("委托代理合同-民事", request)).not.toThrow();
    expect(parsed.clientName).toBe("张某某");
    expect(parsed.clientIdCode).toBe("330100199003010011");
    expect(parsed.clientAddress).toBe("杭州市西湖区文三路附近");
    expect(parsed.clientPhone).toBe("13800000000");
    expect(parsed.counterpartyName).toBe("杭州XX科技有限公司");
    expect(parsed.caseCause).toBe("违法解除劳动合同争议");
    expect(parsed.leadLawyer).toBe("刘达律师");
    expect(parsed.arbitrationFee).toBe(20000);
    expect(renderData.client_representative_line).toBe("");
    expect(renderData.sign_client_line).toBe("甲方：                                   乙方：北京市隆安（深圳）律师事务所");
    expect(renderData.signature_line).toContain("法定代表人/负责人/授权代表：__________");
    expect(renderData.signature_line).toContain("承办律师：_____________");
    expect(renderData.sign_date_line).toBe("签约时间：  202 年   月     日           ");
    expect(renderData.arbitration_line).toContain("☑仲裁阶段");
    expect(renderData.settlement_line).toContain("调解、和解");
    expect(renderData.special_terms_clause).toContain("办案费用实报实销");
    expect(renderData.special_terms_clause).toContain("AI 生成文本仅作为合同草稿");
  });

  it("requires identity, address and phone for 委托代理合同", () => {
    expect(() => validateContractDraftRequest("委托代理合同-民事", "甲方：张三")).toThrow(/缺少必填信息/);
  });

  it("normalizes case date fields and maps 受理机构 to 审理法院", () => {
    const record = normalizeCaseRecord({
      类型: "劳动仲裁",
      案由: "违法解除劳动合同争议",
      委托人: "张某某",
      对方当事人: "杭州XX科技有限公司",
      受理机构: "杭州市西湖区劳动人事争议仲裁委员会",
      程序阶段: "劳动仲裁",
      案件状态: "证据整理中",
      重要紧急程度: "高",
      举证截止日: "2026-01-20",
      开庭日: "2026-02-05 09:30",
      承办律师: "刘达律师",
    });

    expect(record.审理法院).toBe("杭州市西湖区劳动人事争议仲裁委员会");
    expect(record.案由).toBe("劳动争议");
    expect(record.程序阶段).toEqual(["仲裁阶段"]);
    expect(record.案件状态).toBe("进行中");
    expect(record.重要紧急程度).toBe("重要紧急");
    expect(record.主办律师).toEqual(["刘达"]);
    expect(record.进展).toBe("证据整理中");
    expect(record.举证截止日).toEqual(expect.any(Number));
    expect(record.开庭日).toEqual(expect.any(Number));
  });

  it("normalizes invoice payer from buyer aliases instead of the law firm seller", () => {
    const record = normalizeInvoiceRecord({
      付款方: "北京市隆安（深圳）律师事务所",
      购买方: "张某某",
      发票号: "032001900104",
      开票日期: "2026-04-10",
      发票金额: "20000",
    });

    expect(record["付款方"]).toBe("张某某");
    expect(typeof record["开票日期"]).toBe("number");
    expect(record["发票金额"]).toBe(20000);
  });

  it("normalizes invoice payer from match hints when record only contains the law firm", () => {
    const record = normalizeInvoiceRecord({
      付款方: "北京市隆安（深圳）律师事务所",
      发票号: "032001900104",
      开票日期: "2026-04-10",
      发票金额: "20000",
    }, {
      matchHints: {
        clientName: "张某某",
      },
    });

    expect(record["付款方"]).toBe("张某某");
  });

  it("normalizes invoice payer from summary when model omits buyer aliases", () => {
    const record = normalizeInvoiceRecord({
      付款方: "北京市隆安（深圳）律师事务所",
      发票号: "032001900104",
    }, {
      summary: "付款方 张某某，身份证号 330100199003010011，增值税普通发票。",
    });

    expect(record["付款方"]).toBe("张某某");
  });

  it("adds a reminder to the most recent case when no target is provided", async () => {
    const updateBitableRecord = vi.fn(async () => undefined);
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
      "/tmp",
      {
        createBitableRecord: async () => "rec_1",
        listBitableRecords: async () => [
          {
            recordId: "rec_old",
            fields: {
              委托人: "李四",
              创建时间: new Date(2026, 3, 14).getTime(),
            },
          },
          {
            recordId: "rec_latest",
            fields: {
              委托人: "张某某",
              对方当事人: "杭州XX科技有限公司",
              案由: "劳动争议",
              待做事项: "补充社保欠缴证据",
              创建时间: new Date(2026, 3, 16).getTime(),
            },
          },
        ],
        updateBitableRecord,
        resolveFileToLocalPath: async () => {
          throw new Error("not needed");
        },
      } as never,
      {
        createSession: async () => ({ id: "ses_1", title: "test" }),
        postMessageSync: async () => {
          throw new Error("not needed");
        },
        deleteSession: async () => undefined,
      } as never,
      {
        log: () => undefined,
      } as never,
    );

    const result = await service.addCaseReminder("举证截止日 2026-04-18 待做事项 准备仲裁申请书");

    expect(result.matchedLabel).toContain("张某某");
    expect(updateBitableRecord).toHaveBeenCalledWith(
      "app_token",
      "tbl_case",
      "rec_latest",
      expect.objectContaining({
        举证截止日: new Date(2026, 3, 18).getTime(),
        待做事项: "补充社保欠缴证据、准备仲裁申请书",
      }),
    );
  });

  it("builds case reminders directly from case table deadlines and todos", async () => {
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
      "/tmp",
      {
        createBitableRecord: async () => "rec_1",
        listBitableRecords: async () => [
          {
            recordId: "rec_case_1",
            fields: {
              委托人: "张某某",
              对方当事人: "杭州XX科技有限公司",
              案件状态: "进行中",
              程序阶段: ["仲裁阶段"],
              举证截止日: new Date(2026, 3, 18).getTime(),
              待做事项: "补充社保欠缴证据、准备仲裁申请书",
              创建时间: new Date(2026, 3, 16).getTime(),
            },
          },
        ],
        updateBitableRecord: async () => undefined,
        resolveFileToLocalPath: async () => {
          throw new Error("not needed");
        },
      } as never,
      {
        createSession: async () => ({ id: "ses_1", title: "test" }),
        postMessageSync: async () => {
          throw new Error("not needed");
        },
        deleteSession: async () => undefined,
      } as never,
      {
        log: () => undefined,
      } as never,
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 16, 9, 0, 0));
    try {
      const result = await service.listCaseReminders("", 7);
      expect(result.lines).toContain("张某某 vs 杭州XX科技有限公司：举证截止日 2026-04-18；当前状态 进行中；程序阶段 仲裁阶段；待做事项 补充社保欠缴证据、准备仲裁申请书");
      expect(result.lines).toContain("张某某 vs 杭州XX科技有限公司：待做事项 补充社保欠缴证据；截止 2026-04-18；当前状态 进行中；程序阶段 仲裁阶段");
      expect(result.lines).toContain("张某某 vs 杭州XX科技有限公司：待做事项 准备仲裁申请书；截止 2026-04-18；当前状态 进行中；程序阶段 仲裁阶段");
    } finally {
      vi.useRealTimers();
    }
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
    const createBitableRecord = vi.fn(async () => "rec_1");
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
        createBitableRecord,
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
      const result = await service.draftContract(request, { requesterOpenId: "ou_liu_da" });
      const textResult = await spawnPythonTool<{ text: string; format: string }>("doc_to_text", {
        inputPath: result.wordPath,
      });

      expect(textResult.ok).toBe(true);
      if (!textResult.ok) {
        return;
      }

      const text = textResult.data.text;
      expect(text).toContain("聘请方（甲方）：张三");
      expect(text).toContain("甲方：");
      expect(text).toContain("证件号/社会统一信用代码：110101199001010011");
      expect(text).toContain("地址：北京市朝阳区建国路88号");
      expect(text).toContain("联系电话：13800000000");
      expect(text).toContain("法定代表人/负责人/授权代表：__________");
      expect(text).toContain("承办律师：_____________");
      expect(text).not.toContain("承办律师：刘达律师");
      expect(text).not.toContain("签约时间：【待补】");
      expect(text).toContain("签约时间：  202 年   月     日");
      expect(text).toContain("☑仲裁阶段；");
      expect(text).not.toContain("☐一审诉讼；");
      expect(text).not.toContain("☐二审诉讼；");
      expect(text).not.toContain("☐执行程序；");
      expect(text).toContain("律师代理费为￥20,000.00元（大写人民币贰万元整）");
      expect(text).not.toContain("2.一审阶段：律师代理费为【待补】");
      expect(text).not.toContain("☐基础收费+风险收费");
      expect(text).not.toContain("风险代理告知书");
      expect(result.warnings).toContain("模型暂不可用，已按本地规则生成合同初稿。");
      const recordFields = ((createBitableRecord.mock.calls as unknown) as Array<[string, string, Record<string, unknown>]>)[0]?.[2];
      expect(recordFields?.["项目名称"]).toBe("张三 vs 相关单位劳动仲裁");
      expect(recordFields?.["承揽人"]).toEqual([{ id: "ou_liu_da" }]);
      expect(recordFields?.["承办人"]).toEqual([{ id: "ou_liu_da" }]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);
});
