/**
 * 职责: 覆盖证据提取工作流。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { EvidenceExtractService } from "../src/workflows/evidence-extract.js";

describe("EvidenceExtractService", () => {
  it("reuses one extraction pipeline for text-like evidence files", async () => {
    let promptSeen = "";
    const service = new EvidenceExtractService(
      {
        async downloadMessageResource() {
          return {
            fileName: "contract.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("合同编号 HT-001\n客户名称 张三公司\n合同金额 10000", "utf8"),
          };
        },
      },
      {
        async createSession() {
          return { id: "ses_extract" };
        },
        async postMessageSync(_sessionId, request) {
          promptSeen = String(request.parts[0]?.text ?? "");
          return {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "{\"summary\":\"ok\",\"record\":{\"律所合同号\":\"HT-001\"}}" }],
          };
        },
        async deleteSession() {
          return true;
        },
      },
      { log() {} } as never,
    );

    const { result, preparedFile } = await service.extractJson({
      file: {
        messageId: "om_1",
        fileKey: "file_1",
        fileName: "contract.txt",
      },
      allowedExtensions: [".txt"],
      maxFileSizeMb: 1,
      maxExtractedTextLength: 1000,
      buildPrompt: ({ fileName, extractedText }) => `文件名：${fileName}\n内容：${extractedText ?? ""}`,
    });

    expect(preparedFile.fileName).toBe("contract.txt");
    expect(preparedFile.extractedText).toContain("合同编号 HT-001");
    expect(promptSeen).toContain("内容：合同编号 HT-001");
    expect(result).toEqual({
      summary: "ok",
      record: {
        律所合同号: "HT-001",
      },
    });
  });

  it("rejects unsupported evidence extensions before extraction", async () => {
    const service = new EvidenceExtractService(
      {
        async downloadMessageResource() {
          return {
            fileName: "evidence.exe",
            mimeType: "application/octet-stream",
            buffer: Buffer.from("fake", "utf8"),
          };
        },
      },
      {
        async createSession() {
          return { id: "ses_extract" };
        },
        async postMessageSync() {
          throw new Error("should not be called");
        },
        async deleteSession() {
          return true;
        },
      },
      { log() {} } as never,
    );

    await expect(service.extractJson({
      file: {
        messageId: "om_2",
        fileKey: "file_2",
        fileName: "evidence.exe",
      },
      allowedExtensions: [".txt"],
      maxFileSizeMb: 1,
      buildPrompt: () => "noop",
    })).rejects.toThrow("仅支持 .txt 文件");
  });

  it("rejects spoofed pdf files that contain html payloads", async () => {
    const service = new EvidenceExtractService(
      {
        async downloadMessageResource() {
          return {
            fileName: "evidence.pdf",
            mimeType: "text/html",
            buffer: Buffer.from("<!doctype html><html><body>login required</body></html>", "utf8"),
          };
        },
      },
      {
        async createSession() {
          return { id: "ses_extract" };
        },
        async postMessageSync() {
          throw new Error("should not be called");
        },
        async deleteSession() {
          return true;
        },
      },
      { log() {} } as never,
    );

    await expect(service.extractJson({
      file: {
        messageId: "om_pdf",
        fileKey: "file_pdf",
        fileName: "evidence.pdf",
      },
      allowedExtensions: [".pdf"],
      maxFileSizeMb: 1,
      buildPrompt: () => "noop",
    })).rejects.toThrow("文件内容不像有效 PDF");
  });

  it("parses spreadsheet evidence into table-like text", async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["姓名", "岗位", "得分"],
      ["张三", "销售主管", "92"],
      ["李四", "客户经理", "88"],
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, "Q1");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

    let promptSeen = "";
    const service = new EvidenceExtractService(
      {
        async downloadMessageResource() {
          return {
            fileName: "score.xlsx",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            buffer,
          };
        },
      },
      {
        async createSession() {
          return { id: "ses_sheet" };
        },
        async postMessageSync(_sessionId, request) {
          promptSeen = String(request.parts[0]?.text ?? "");
          return {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "{\"summary\":\"ok\",\"record\":{\"材料类型\":\"表格\"}}" }],
          };
        },
        async deleteSession() {
          return true;
        },
      },
      { log() {} } as never,
    );

    const { preparedFile } = await service.extractJson({
      file: {
        messageId: "om_3",
        fileKey: "file_3",
        fileName: "score.xlsx",
      },
      allowedExtensions: [".xlsx"],
      maxFileSizeMb: 1,
      buildPrompt: ({ extractedText }) => extractedText ?? "",
    });

    expect(preparedFile.extractedText).toContain("工作表：Q1");
    expect(preparedFile.extractedText).toContain("销售主管");
    expect(promptSeen).toContain("姓名");
    expect(promptSeen).toContain("得分");
  });
});
