/**
 * 职责: 提供案件证据台账的共享写入能力。
 * 关注点:
 * - 将结构化证据项与缺口项同步到同一张多维表。
 * - 统一生成总表、关键证据视图和缺口视图链接。
 */

export type EvidenceLedgerConfig = {
  appToken: string;
  tableId: string;
  keyEvidenceViewId?: string | undefined;
  missingEvidenceViewId?: string | undefined;
};

export type EvidenceLedgerResourcePort = {
  createBitableRecord(appToken: string, tableId: string, fields: Record<string, unknown>): Promise<string>;
};

export type EvidenceLedgerItem = {
  kind: "evidence" | "gap";
  caseTitle: string;
  disputeStage?: string | undefined;
  name: string;
  evidenceType?: string | undefined;
  proves: string;
  support?: string | undefined;
  strength?: string | undefined;
  risk?: string | undefined;
  remarks?: string | undefined;
  status?: string | undefined;
};

export type EvidenceLedgerSyncResult = {
  ledgerUrl: string;
  keyEvidenceViewUrl?: string | undefined;
  missingEvidenceViewUrl?: string | undefined;
  syncedEvidenceCount: number;
  syncedGapCount: number;
};

export async function syncEvidenceLedger(
  resources: EvidenceLedgerResourcePort,
  config: EvidenceLedgerConfig,
  items: EvidenceLedgerItem[],
): Promise<EvidenceLedgerSyncResult> {
  let syncedEvidenceCount = 0;
  let syncedGapCount = 0;

  for (const item of items) {
    await resources.createBitableRecord(config.appToken, config.tableId, buildEvidenceLedgerFields(item));
    if (item.kind === "evidence") {
      syncedEvidenceCount += 1;
    } else {
      syncedGapCount += 1;
    }
  }

  return {
    ledgerUrl: buildBitableViewUrl(config.appToken, config.tableId),
    keyEvidenceViewUrl: config.keyEvidenceViewId
      ? buildBitableViewUrl(config.appToken, config.tableId, config.keyEvidenceViewId)
      : undefined,
    missingEvidenceViewUrl: config.missingEvidenceViewId
      ? buildBitableViewUrl(config.appToken, config.tableId, config.missingEvidenceViewId)
      : undefined,
    syncedEvidenceCount,
    syncedGapCount,
  };
}

function buildEvidenceLedgerFields(item: EvidenceLedgerItem): Record<string, unknown> {
  return {
    案件标题: item.caseTitle,
    当前阶段: item.disputeStage ?? "",
    条目类型: item.kind === "evidence" ? "证据" : "缺口",
    名称: item.name,
    证据类型: item.evidenceType ?? "",
    证明事实: item.proves,
    支持方向: item.support ?? "",
    证明力: item.strength ?? "",
    风险提示: item.risk ?? "",
    备注: item.remarks ?? "",
    状态: item.status ?? (item.kind === "gap" ? "待补充" : "已识别"),
  };
}

export function buildBitableViewUrl(appToken: string, tableId: string, viewId?: string): string {
  const base = `https://feishu.cn/base/${encodeURIComponent(appToken)}?table=${encodeURIComponent(tableId)}`;
  return viewId ? `${base}&view=${encodeURIComponent(viewId)}` : base;
}
