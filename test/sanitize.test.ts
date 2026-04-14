import { describe, expect, it } from "vitest";

import { cleanAssistantReply, redactEvidenceRecord, redactEvidenceText } from "../src/runtime/sanitize.js";

describe("cleanAssistantReply", () => {
  it("removes system reminders", () => {
    const value = cleanAssistantReply("hello\n<system-reminder>internal</system-reminder>\nworld");
    expect(value).toBe("hello\n\nworld");
  });
});

describe("redactEvidenceText", () => {
  it("redacts common personal identifiers in free text", () => {
    const value = redactEvidenceText("姓名：张三 联系方式：13812345678 身份证号：310101199001011234 邮箱：zhangsan@example.com 甲方：网新集团有限公司");
    expect(value).toContain("姓名：XXX");
    expect(value).toContain("138****5678");
    expect(value).toContain("310101********1234");
    expect(value).toContain("z***@example.com");
    expect(value).toContain("甲方：XXX公司");
  });

  it("redacts bank cards and labeled addresses", () => {
    const value = redactEvidenceText("银行卡号：6222021234567890123；收件地址：上海市浦东新区世纪大道100号");
    expect(value).toContain("6222 **** **** 0123");
    expect(value).toContain("上海市浦东新****");
  });

  it("redacts organization names in plain text", () => {
    const value = redactEvidenceText("劳动者与安徽网新计算机有限公司发生争议，并委托北京市某某律师事务所提供服务。");
    expect(value).toContain("XXX公司");
    expect(value).toContain("XXX机构");
  });
});

describe("redactEvidenceRecord", () => {
  it("redacts sensitive fields in structured evidence records", () => {
    const value = redactEvidenceRecord({
      证据名称: "工资单截图",
      联系方式: "13812345678",
      联系人: "李四",
      客户名称: "网新集团有限公司",
      备注: "申请人邮箱 test.user@example.com",
    });

    expect(value.证据名称).toBe("工资单截图");
    expect(value.联系方式).toBe("138****5678");
    expect(value.联系人).toBe("XXX");
    expect(value.客户名称).toBe("XXX公司");
    expect(value.备注).toContain("t***@example.com");
  });
});
