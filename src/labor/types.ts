import type { KnowledgeQueryResult } from "../knowledge/index.js";
import type { OpenCodeModelRef } from "../opencode/client.js";

export type LaborModelStep = "extract" | "analyze" | "render";

export type LaborSkillConfig = {
  enabled: boolean;
  models: {
    extract?: string | undefined;
    analyze?: string | undefined;
    render?: string | undefined;
  };
  ingest: {
    allowedExtensions: string[];
    maxFileSizeMb: number;
    pendingTtlMs: number;
    concurrency: number;
  };
};

export type LaborMaterialInput = {
  sourceFile: string;
  messageId: string;
  fileKey: string;
  size?: number | undefined;
};

export type LaborDownloadedMaterial = LaborMaterialInput & {
  mimeType: string;
  buffer: Buffer;
};

export type LaborParsedMaterial = LaborDownloadedMaterial & {
  markdown: string;
  parserUsed: string;
};

export type LaborCaseContext = {
  caseTitle?: string | undefined;
  notes: string[];
};

export type LaborConfidence = "high" | "medium" | "low";
export type LaborMaterialType = "contract" | "payroll" | "attendance" | "chat" | "notice" | "resignation" | "arbitration" | "other";
export type LaborSupportDirection = "supports_worker" | "supports_employer" | "neutral" | "unclear";
export type LaborProbativeStrength = "strong" | "medium" | "weak";
export type LaborRiskLevel = "high" | "medium" | "low";

export type LaborEvidenceRow = {
  evidenceName: string;
  evidenceType: string;
  proves: string;
  supportDirection: LaborSupportDirection;
  probativeStrength: LaborProbativeStrength;
  riskOrGap: string;
  note: string;
};

export type LaborMaterialExtraction = {
  sourceFile: string;
  materialType: LaborMaterialType;
  summary: string;
  facts: Array<{ fact: string; sourceLocation: string; confidence: LaborConfidence }>;
  timelineEvents: Array<{ date: string; event: string; sourceLocation: string; confidence: LaborConfidence }>;
  evidenceRows: LaborEvidenceRow[];
  contractRisks: Array<{ clauseOrContent: string; risk: string; possibleConsequence: string; suggestion: string }>;
  riskPoints: string[];
  missingEvidenceHints: string[];
};

export type LaborAnalysisReport = {
  caseTitle: string;
  disputeStage: "咨询中" | "仲裁前" | "仲裁中" | "诉讼中" | "未知";
  summary: {
    materialCount: number;
    currentConclusion: string;
    riskLevel: LaborRiskLevel | "unknown";
    recommendedAction: string;
  };
  coreJudgment: string[];
  evidenceRows: LaborEvidenceRow[];
  timeline: Array<{ date: string; event: string; evidence: string; confidence: LaborConfidence }>;
  issues: Array<{
    issue: string;
    proofBurden: string;
    supportingEvidence: string[];
    weakness: string;
    riskLevel: LaborRiskLevel;
    knowledgeQuery: string;
  }>;
  riskItems: Array<{ item: string; reason: string; possibleConsequence: string; suggestion: string }>;
  missingEvidence: Array<{ evidence: string; whyNeeded: string; priority: LaborRiskLevel }>;
  nextActions: string[];
};

export type LaborKnowledgeSupport = {
  issue: string;
  query: string;
  result: KnowledgeQueryResult;
};

export type LaborFailedMaterial = {
  sourceFile: string;
  reason: string;
};

export type LaborAnalysisResult = {
  report: LaborAnalysisReport;
  markdown: string;
  docTitle: string;
  timelineWhiteboardMermaid: string;
  evidenceMapWhiteboardMermaid: string;
  supports: LaborKnowledgeSupport[];
  failedMaterials: LaborFailedMaterial[];
};

export type LaborProgressStep = "parse" | "extract" | "analyze" | "knowledge" | "document";

export type LaborProgressUpdate = {
  step: LaborProgressStep;
  status: "pending" | "running" | "completed" | "error";
  detail?: string | undefined;
};

export type LaborAnalyzeOptions = {
  onProgress?: ((update: LaborProgressUpdate) => Promise<void> | void) | undefined;
};

export type LaborOpenCodePort = {
  createSession(title: string): Promise<{ id: string }>;
  postMessageSync(sessionId: string, request: {
    model?: OpenCodeModelRef;
    parts: Array<{ type: "text"; text: string }>;
  }): Promise<unknown>;
  deleteSession(sessionId: string): Promise<boolean>;
};
