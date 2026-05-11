/**
 * 职责: 识别司法文书并把类案要旨规整为知识库 case_digest 条目。
 * 关注点:
 * - 在通用问答抽取前分流判决书、裁定书和仲裁裁决书。
 * - 校验司法文书结构、案号、脱敏和法院说理原文回指。
 * - 输出兼容 knowledge_entries 的 question/answer/tags/statute/fieldsJson 映射。
 */
import crypto from "node:crypto";

import type { ParsedKnowledgeSection } from "../parser.js";

export type JudicialDocumentKind = "judgment" | "ruling" | "arbitration_award";

export type JudicialDocumentDetection = {
  matched: boolean;
  kind?: JudicialDocumentKind | undefined;
  caseNumber?: string | undefined;
  court?: string | undefined;
  cause?: string | undefined;
  judgmentDate?: string | undefined;
  level?: "一审" | "二审" | "再审" | "仲裁" | "未知" | undefined;
  sections: JudicialDocumentSections;
  reason?: string | undefined;
};

export type JudicialDocumentSections = {
  claims?: string | undefined;
  facts?: string | undefined;
  reasoning?: string | undefined;
  outcome?: string | undefined;
};

export type CaseDigestRawItem = {
  issue?: unknown;
  reasoning?: unknown;
  rule?: unknown;
  outcome?: unknown;
  statutes?: unknown;
  tags?: unknown;
  weight?: unknown;
};

export type CaseDigestCandidate = {
  question: string;
  answer: string;
  tags: string[];
  statute?: string | undefined;
  pageSection: string;
  entryType: "case_digest";
  confidence: number;
  reviewRequired: boolean;
  effectiveStatus: "current" | "unknown" | "expired";
  dedupKey: string;
  fieldsJson: string;
};

type NormalizedCaseDigest = {
  issue: string;
  reasoning: string;
  rule: string;
  outcome: string;
  statutes: string[];
  tags: string[];
  weight: "guidance" | "typical" | "reference";
};

const CASE_NUMBER_PATTERN = /[（(]\d{4}[）)][\u4e00-\u9fa5A-Za-z0-9]+(?:民|商|知|行|劳|仲|执|赔|破|申|再|终|初|裁)[\u4e00-\u9fa5A-Za-z0-9]*\d+(?:-\d+)?号/;
const COURT_PATTERN = /([\u4e00-\u9fa5]{2,}(?:人民法院|仲裁委员会|劳动人事争议仲裁委员会))/;
const DATE_PATTERN = /(?:二〇|二○|二零|[一二三四五六七八九〇零○]{4}|\d{4})年[一二三四五六七八九十\d]{1,2}月[一二三四五六七八九十\d]{1,3}日/;
const SENSITIVE_PATTERN = /未成年人|未成年子女|国家秘密|商业秘密|不公开审理|身份证(?:号|号码)?[:：]?\s*\d{6,}|(?:1[3-9]\d{9})|[\w.+-]+@[\w.-]+\.\w+/;
const ADDRESS_PATTERN = /(?:住址|住所地|户籍地|身份证住址)[:：][^\n，。；;]{8,}/;

export function detectJudicialDocument(markdown: string, sections: ParsedKnowledgeSection[]): JudicialDocumentDetection {
  const text = normalizeDocumentText(markdown || sections.map((section) => section.text).join("\n\n"));
  const caseNumber = text.match(CASE_NUMBER_PATTERN)?.[0];
  if (!caseNumber) {
    return { matched: false, sections: {}, reason: "missing-case-number" };
  }
  const kind = detectJudicialKind(text);
  if (!kind) {
    return { matched: false, caseNumber, sections: {}, reason: "unsupported-document-kind" };
  }
  if (/民事调解书|调解协议/.test(text) && !/指导性案例|典型案例|最高人民法院/.test(text)) {
    return { matched: false, caseNumber, kind, sections: {}, reason: "mediation-out-of-scope" };
  }
  if (SENSITIVE_PATTERN.test(text) || ADDRESS_PATTERN.test(text)) {
    return { matched: false, caseNumber, kind, sections: {}, reason: "sensitive-material" };
  }
  const extractedSections = extractJudicialSections(text);
  if (!extractedSections.reasoning || !extractedSections.outcome) {
    return { matched: false, caseNumber, kind, sections: extractedSections, reason: "missing-reasoning-or-outcome" };
  }
  return {
    matched: true,
    kind,
    caseNumber,
    court: text.match(COURT_PATTERN)?.[1],
    cause: extractCause(text),
    judgmentDate: normalizeJudgmentDate(text.match(DATE_PATTERN)?.[0]),
    level: detectCaseLevel(caseNumber, kind),
    sections: extractedSections,
  };
}

export function buildCaseDigestPrompt(input: {
  fileName: string;
  detection: JudicialDocumentDetection;
}): string {
  const detection = input.detection;
  const sections = detection.sections;
  return [
    "你是司法文书要旨提取助手。",
    "请按争议焦点把以下司法文书拆成多条 case_digest 条目，输出 JSON 数组，不要输出额外说明。",
    "类案只供说理参考，不是法律依据；不要把当事人姓名、身份证号、手机号、邮箱或详细地址写入结果。",
    "输出字段：issue、reasoning、rule、outcome、statutes、tags、weight。",
    "字段规则：",
    "1. issue 是单一争议焦点，30 字以内。",
    "2. reasoning 必须从输入的“本院认为/裁判理由”中原文摘录，不要改写。",
    "3. rule 可以提炼，但不能引入原文未出现的概念，80 字以内。",
    "4. outcome 写该焦点对应的判决/裁定/裁决结果要点。",
    "5. statutes 为字符串数组，例如 [\"《劳动合同法》第 19 条\"]；没有明确法条则为空数组。",
    "6. tags 为 1-3 个标签，优先使用案由和争议焦点关键词。",
    "7. weight 只能是 guidance、typical、reference；普通上传材料默认 reference。",
    `源文件：${input.fileName}`,
    `案号：${detection.caseNumber ?? "未识别"}`,
    `法院/机构：${detection.court ?? "未识别"}`,
    `案由：${detection.cause ?? "未识别"}`,
    "---必要事实背景---",
    truncateForPrompt([sections.claims, sections.facts].filter(Boolean).join("\n\n"), 2_000),
    "---本院认为/裁判理由---",
    truncateForPrompt(sections.reasoning ?? "", 5_000),
    "---判决/裁定/裁决结果---",
    truncateForPrompt(sections.outcome ?? "", 1_500),
    "只输出 JSON 数组，不要输出其他内容。",
  ].join("\n\n");
}

export function normalizeCaseDigestItems(input: {
  rawItems: unknown[];
  detection: JudicialDocumentDetection;
  sourceText: string;
}): CaseDigestCandidate[] {
  const normalizedSource = normalizeForEvidence(input.sourceText);
  const candidates: CaseDigestCandidate[] = [];
  const seen = new Set<string>();
  for (const item of input.rawItems) {
    const digest = normalizeRawDigest(item);
    if (!digest) {
      continue;
    }
    const span = locateReasoningSpan(normalizedSource, digest.reasoning);
    if (!span) {
      continue;
    }
    const dedupKey = buildCaseDigestDedupKey(input.detection.caseNumber!, digest.issue);
    if (seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);
    const fields = {
      schemaVersion: 1,
      type: "case_digest",
      caseNumber: input.detection.caseNumber,
      court: input.detection.court,
      cause: input.detection.cause,
      level: input.detection.level,
      judgmentDate: input.detection.judgmentDate,
      issue: digest.issue,
      reasoning: digest.reasoning,
      reasoningSpan: span,
      rule: digest.rule,
      outcome: digest.outcome,
      statutes: digest.statutes,
      weight: digest.weight,
      redactionApplied: true,
      extractedAt: new Date().toISOString(),
      extractorVersion: "case-digest-v1",
      promptVersion: "case-digest-prompt-v1",
    };
    candidates.push({
      question: digest.issue,
      answer: buildCaseDigestAnswer(digest),
      tags: digest.tags,
      statute: digest.statutes.length > 0 ? digest.statutes.join("；") : undefined,
      pageSection: `${input.detection.caseNumber} · ${digest.issue}`,
      entryType: "case_digest",
      confidence: 0.9,
      reviewRequired: false,
      effectiveStatus: input.detection.level === "一审" ? "unknown" : "current",
      dedupKey,
      fieldsJson: JSON.stringify(fields),
    });
  }
  return candidates;
}

export function buildCaseDigestDedupKey(caseNumber: string, issue: string): string {
  const hash = crypto.createHash("sha256").update(normalizeForEvidence(issue)).digest("hex").slice(0, 16);
  return `case_digest:${caseNumber}:${hash}`;
}

function detectJudicialKind(text: string): JudicialDocumentKind | undefined {
  if (/民事判决书|行政判决书|刑事附带民事判决书/.test(text)) {
    return "judgment";
  }
  if (/民事裁定书|行政裁定书/.test(text)) {
    return "ruling";
  }
  if (/仲裁裁决书|裁决书/.test(text) && /仲裁/.test(text)) {
    return "arbitration_award";
  }
  return undefined;
}

function detectCaseLevel(caseNumber: string | undefined, kind: JudicialDocumentKind): "一审" | "二审" | "再审" | "仲裁" | "未知" {
  if (kind === "arbitration_award") {
    return "仲裁";
  }
  if (!caseNumber) {
    return "未知";
  }
  if (/再|申/.test(caseNumber)) {
    return "再审";
  }
  if (/终/.test(caseNumber)) {
    return "二审";
  }
  if (/初/.test(caseNumber)) {
    return "一审";
  }
  return "未知";
}

function extractJudicialSections(text: string): JudicialDocumentSections {
  return {
    claims: sliceBetween(text, ["诉称", "上诉请求", "原告诉称", "上诉人上诉请求"], ["辩称", "本院查明", "本院认为"]),
    facts: sliceBetween(text, ["本院查明", "经审理查明", "本院经审理查明", "查明"], ["本院认为", "裁判理由", "仲裁庭认为"]),
    reasoning: sliceBetween(text, ["本院认为", "裁判理由", "仲裁庭认为", "本委认为"], ["判决如下", "裁定如下", "裁决如下", "审判长", "仲裁员"]),
    outcome: sliceBetween(text, ["判决如下", "裁定如下", "裁决如下"], ["审判长", "审判员", "人民陪审员", "书记员", "仲裁员"]),
  };
}

function sliceBetween(text: string, startMarkers: string[], endMarkers: string[]): string | undefined {
  const start = findFirstMarker(text, startMarkers);
  if (!start) {
    return undefined;
  }
  const from = start.index;
  const nextEnd = endMarkers
    .map((marker) => {
      const index = text.indexOf(marker, from + start.marker.length);
      return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
    })
    .reduce((min, index) => Math.min(min, index), Number.MAX_SAFE_INTEGER);
  return text.slice(from, nextEnd === Number.MAX_SAFE_INTEGER ? undefined : nextEnd).trim();
}

function findFirstMarker(text: string, markers: string[]): { marker: string; index: number } | undefined {
  return markers
    .map((marker) => ({ marker, index: text.indexOf(marker) }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index)[0];
}

function extractCause(text: string): string | undefined {
  const patterns = [
    /案由[:：]\s*([^\n，。；;]{2,30})/,
    /(?:劳动争议|合同纠纷|买卖合同纠纷|民间借贷纠纷|侵害商标权纠纷|公司决议纠纷|股东资格确认纠纷)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1] ?? match?.[0];
    if (value) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeJudgmentDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/\s+/g, "");
}

function normalizeRawDigest(value: unknown): NormalizedCaseDigest | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as CaseDigestRawItem;
  const issue = readString(record.issue);
  const reasoning = readString(record.reasoning);
  const rule = readString(record.rule);
  const outcome = readString(record.outcome);
  if (!issue || !reasoning || !rule || !outcome || issue.length > 60) {
    return null;
  }
  return {
    issue: issue.slice(0, 60),
    reasoning,
    rule: rule.slice(0, 120),
    outcome,
    statutes: readStringArray(record.statutes).map(normalizeStatuteText).filter(Boolean),
    tags: normalizeDigestTags(readStringArray(record.tags), issue),
    weight: normalizeWeight(record.weight),
  };
}

function buildCaseDigestAnswer(digest: NormalizedCaseDigest): string {
  return [
    `裁判规则：${digest.rule}`,
    `裁判结果：${digest.outcome}`,
    `法院说理：${digest.reasoning}`,
    "类案参考：本条仅供说理思路参考，非法律依据。",
  ].join("\n\n");
}

function normalizeDigestTags(tags: string[], issue: string): string[] {
  const unique = new Set<string>();
  for (const tag of tags) {
    const normalized = tag.replace(/\s+/g, "").trim();
    if (normalized && normalized.length <= 12) {
      unique.add(normalized);
    }
    if (unique.size >= 3) {
      break;
    }
  }
  if (unique.size === 0) {
    unique.add(issue.slice(0, 12));
  }
  return [...unique];
}

function normalizeWeight(value: unknown): "guidance" | "typical" | "reference" {
  return value === "guidance" || value === "typical" || value === "reference" ? value : "reference";
}

function locateReasoningSpan(normalizedSource: string, reasoning: string): { start: number; end: number; normalizedHash: string } | null {
  const normalizedReasoning = normalizeForEvidence(reasoning);
  if (!normalizedReasoning || normalizedReasoning.length < 12) {
    return null;
  }
  const start = normalizedSource.indexOf(normalizedReasoning);
  if (start < 0) {
    return null;
  }
  return {
    start,
    end: start + normalizedReasoning.length,
    normalizedHash: crypto.createHash("sha256").update(normalizedReasoning).digest("hex"),
  };
}

function normalizeDocumentText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeForEvidence(text: string): string {
  return text.replace(/\s+/g, "").replace(/[，,。；;：:]/g, (match) => match).trim();
}

function truncateForPrompt(text: string, maxLength: number): string {
  const normalized = text.trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}\n……` : normalized;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(readString).filter(Boolean);
}

function normalizeStatuteText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
