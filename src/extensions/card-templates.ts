/**
 * 职责: 汇总内置扩展声明的业务卡片模板。
 * 关注点:
 * - 通过 data-only meta 聚合模板，避免加载完整 runtime extension。
 * - 保持模板归属仍由业务模块侧声明并由 registry 校验重复 id。
 */
export { builtinExtensionCardTemplates } from "./builtin-meta.js";
