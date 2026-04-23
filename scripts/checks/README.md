# Checks 脚本说明

这个目录存放仓库级检查脚本，主要服务于 CI、本地校验和架构守卫。

当前内容：

- `check-docs-diff.ts`
  - seam 文件变化但未同步更新架构基线时发出告警
- `check-formatter-exports.ts`
  - 锁定 `src/feishu/formatter.ts` 的兼容导出面

使用原则：

- 这里的脚本应尽量无业务副作用
- 只承载“检查仓库状态是否满足规则”的逻辑
