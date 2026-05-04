/**
 * 职责: 覆盖发票结构化 detector 与字段抽取。
 * 关注点:
 * - OCR 噪声下仍能命中发票信号。
 * - 非发票材料因反信号和低置信被拦截。
 * - LLM 修补 prompt 只允许返回待补字段 diff。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildInvoiceRepairPrompt,
  detectInvoiceDocument,
  extractStructuredInvoice,
  fuzzySignalMatch,
  normalizeTextForSignal,
} from "../src/contract-assistant/invoice-structured.js";

const fixture = (name: string) => path.resolve("test/fixtures/invoice-structured", name);

describe("invoice structured detector", () => {
  it("normalizes spaces and punctuation before matching signals", () => {
    expect(normalizeTextForSignal("发 票 号 码：0320-019")).toContain("发票号码");
    expect(fuzzySignalMatch("发票号 码 032001900105", ["发票号码"])).toBe("发票号码");
  });

  it("detects a clean electronic invoice and extracts core fields", async () => {
    const text = await readFile(fixture("invoices/e-invoice-common.txt"), "utf8");
    const result = extractStructuredInvoice(text);

    expect(result.detection.isInvoice).toBe(true);
    expect(result.detection.confidence).toBeGreaterThanOrEqual(0.75);
    expect(result.fields).toMatchObject({
      发票号: "032001900104",
      开票日期: "2026-04-10",
      购买方: "张三",
      发票金额: 20000,
    });
    expect(result.missingFields).toEqual([]);
  });

  it("detects noisy photo OCR invoice text through fuzzy signals", async () => {
    const text = await readFile(fixture("invoices/noisy-photo-invoice.txt"), "utf8");
    const detection = detectInvoiceDocument(text);

    expect(detection.isInvoice).toBe(true);
    expect(detection.matchedStrongSignals.map((item) => item.name)).toContain("发票号码");
    expect(detection.matchedStrongSignals.map((item) => item.name)).toContain("购买方信息");
  });

  it("rejects contract and case materials as non-invoices", async () => {
    const contract = detectInvoiceDocument(await readFile(fixture("non-invoices/contract.txt"), "utf8"));
    const caseMaterial = detectInvoiceDocument(await readFile(fixture("non-invoices/case-material.txt"), "utf8"));

    expect(contract.isInvoice).toBe(false);
    expect(contract.matchedNegativeSignals.map((item) => item.name)).toContain("合同材料");
    expect(caseMaterial.isInvoice).toBe(false);
    expect(caseMaterial.matchedNegativeSignals.map((item) => item.name)).toContain("诉讼材料");
  });

  it("builds a repair prompt that freezes confirmed fields and asks for patch only", () => {
    const prompt = buildInvoiceRepairPrompt({
      text: "发票号码 032001900104",
      confirmedFields: { 发票号: "032001900104" },
      missingFields: ["购买方"],
    });

    expect(prompt).toContain("已确认字段禁止修改");
    expect(prompt).toContain("\"patch\"");
    expect(prompt).toContain("patch 只能包含待补字段");
    expect(prompt).toContain("购买方");
  });
});
