/**
 * 职责: 覆盖 docx 模板填充。
 * 关注点: docxtemplater 集成、缺口清单、输出文件有效性。
 */
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import PizZip from "pizzip";

import { fillDocxTemplate } from "../src/workspace/docx-template.js";

/** 创建一个包含 {name} 和 {date} 占位符的最小 docx 模板。 */
function createMinimalDocxTemplate(): Buffer {
  const zip = new PizZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>甲方：{name}</w:t></w:r></w:p>
    <w:p><w:r><w:t>日期：{date}</w:t></w:r></w:p>
  </w:body>
</w:document>`);
  return zip.generate({ type: "nodebuffer" });
}

describe("fillDocxTemplate", () => {
  it("fills docx template and returns gap analysis", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "docx-template-"));
    try {
      const templatePath = path.join(dir, "template.docx");
      const outputPath = path.join(dir, "output.docx");
      const templateBuffer = createMinimalDocxTemplate();
      await writeFile(templatePath, templateBuffer);

      const result = await fillDocxTemplate(
        templatePath,
        { name: "张三", date: "2026-05-29" },
        outputPath,
      );

      expect(result.allPlaceholders).toContain("name");
      expect(result.allPlaceholders).toContain("date");
      expect(result.missingFields).toEqual([]);
      expect(result.outputPath).toBe(outputPath);

      // 输出文件应存在且是有效 zip（docx 是 zip 格式）
      const outputBuffer = await readFile(outputPath);
      expect(outputBuffer.length).toBeGreaterThan(0);
      const zip = new PizZip(outputBuffer);
      const docXml = zip.file("word/document.xml")?.asText() ?? "";
      expect(docXml).toContain("张三");
      expect(docXml).toContain("2026-05-29");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports missing fields in gap analysis", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "docx-template-gap-"));
    try {
      const templatePath = path.join(dir, "template.docx");
      const outputPath = path.join(dir, "output.docx");
      await writeFile(templatePath, createMinimalDocxTemplate());

      const result = await fillDocxTemplate(
        templatePath,
        { name: "张三" },
        outputPath,
      );

      expect(result.missingFields).toContain("date");
      expect(result.providedFields).toContain("name");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
