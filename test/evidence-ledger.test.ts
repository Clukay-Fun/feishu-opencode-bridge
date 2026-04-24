/**
 * 职责: 覆盖证据台账同步和字段映射逻辑。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { describe, expect, it, vi } from "vitest";

import { buildBitableViewUrl, syncEvidenceLedger } from "../src/workflows/evidence-ledger.js";

describe("evidence ledger workflow", () => {
  it("syncs evidence and gap items into one ledger table and returns view urls", async () => {
    const createBitableRecord = vi.fn(async () => "rec_1");

    const result = await syncEvidenceLedger({
      createBitableRecord,
    }, {
      appToken: "app_labor",
      tableId: "tbl_evidence",
      keyEvidenceViewId: "vew_key",
      missingEvidenceViewId: "vew_gap",
    }, [
      {
        kind: "evidence",
        caseTitle: "张某某劳动争议",
        disputeStage: "仲裁前",
        name: "解除通知",
        evidenceType: "通知",
        proves: "违法解除",
        support: "支持劳动者",
        strength: "strong",
      },
      {
        kind: "gap",
        caseTitle: "张某某劳动争议",
        name: "工资流水",
        proves: "工资流水",
        remarks: "来源：AI 证据链分析缺口提示",
      },
    ]);

    expect(createBitableRecord).toHaveBeenCalledTimes(2);
    const calls = createBitableRecord.mock.calls as unknown as Array<[string, string, Record<string, unknown>]>;
    expect(calls[0]?.[2]).toMatchObject({
      条目类型: "证据",
      名称: "解除通知",
      证明事实: "违法解除",
    });
    expect(calls[1]?.[2]).toMatchObject({
      条目类型: "缺口",
      名称: "工资流水",
      状态: "待补充",
    });
    expect(result).toEqual({
      ledgerUrl: "https://feishu.cn/base/app_labor?table=tbl_evidence",
      keyEvidenceViewUrl: "https://feishu.cn/base/app_labor?table=tbl_evidence&view=vew_key",
      missingEvidenceViewUrl: "https://feishu.cn/base/app_labor?table=tbl_evidence&view=vew_gap",
      syncedEvidenceCount: 1,
      syncedGapCount: 1,
    });
  });

  it("builds a base url without a view id", () => {
    expect(buildBitableViewUrl("app_labor", "tbl_evidence")).toBe("https://feishu.cn/base/app_labor?table=tbl_evidence");
  });
});
