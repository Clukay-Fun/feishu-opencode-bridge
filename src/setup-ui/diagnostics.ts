/**
 * 职责: 提供 setup-ui 诊断结果类型和渲染。
 * 关注点:
 * - 所有诊断产出 DiagnosticResult，统一渲染。
 * - 失败时必须包含 nextStep 建议。
 */
export type DiagnosticResult = {
  ok: boolean;
  label: string;
  detail?: string;
  nextStep?: string;
};

export function renderDiagnostic(result: DiagnosticResult): string {
  const icon = result.ok ? "✅" : "❌";
  const lines = [`${icon} ${result.label}`];
  if (result.detail) {
    lines.push(`   ${result.detail}`);
  }
  if (!result.ok && result.nextStep) {
    lines.push(`   → ${result.nextStep}`);
  }
  return lines.join("\n");
}

export function renderDiagnostics(results: DiagnosticResult[]): string {
  return results.map(renderDiagnostic).join("\n");
}

export function hasFailures(results: DiagnosticResult[]): boolean {
  return results.some((r) => !r.ok);
}
