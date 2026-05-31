/**
 * 职责: 覆盖模板占位符识别、数据填充和缺口清单。
 */
import { describe, expect, it } from "vitest";

import { scanPlaceholders, fillTemplate } from "../src/workspace/template.js";

describe("scanPlaceholders", () => {
  it("finds all unique placeholders in text", () => {
    const text = "甲方：{{client_name}}，乙方：{{counterparty_name}}，日期：{{date}}";
    expect(scanPlaceholders(text)).toEqual(["client_name", "counterparty_name", "date"]);
  });

  it("deduplicates placeholders", () => {
    const text = "{{name}} 与 {{name}} 签订合同";
    expect(scanPlaceholders(text)).toEqual(["name"]);
  });

  it("returns empty for text without placeholders", () => {
    expect(scanPlaceholders("没有占位符的文本")).toEqual([]);
  });
});

describe("fillTemplate", () => {
  it("fills placeholders with provided data", () => {
    const text = "甲方：{{client_name}}，日期：{{date}}";
    const result = fillTemplate(text, { client_name: "张三", date: "2026-05-29" });
    expect(result.filledText).toBe("甲方：张三，日期：2026-05-29");
    expect(result.missingFields).toEqual([]);
  });

  it("reports missing fields in gap analysis", () => {
    const text = "甲方：{{client_name}}，乙方：{{counterparty_name}}";
    const result = fillTemplate(text, { client_name: "张三" });
    expect(result.missingFields).toEqual(["counterparty_name"]);
    expect(result.filledText).toContain("张三");
    expect(result.filledText).toContain("{{counterparty_name}}");
  });

  it("handles whitespace in placeholders", () => {
    const text = "{{ client_name }}";
    const result = fillTemplate(text, { client_name: "张三" });
    expect(result.filledText).toBe("张三");
  });
});
