# Contributing

感谢你愿意参与 `feishu-opencode-bridge`。这个项目已经进入框架边界相对稳定的维护阶段，贡献时请优先保持 core 小、模块边界清晰、行为可测试。

## 贡献流程

1. 先搜索现有 issue 和 PR，避免重复工作。
2. 对明显 bug，可以直接提交 issue 或 PR。
3. 对新能力、架构调整、外部 API 接入、配置结构变更，建议先开 issue 说明背景、影响和验收标准。
4. 从最新 `main` 创建分支，建议使用 `codex/<topic>` 或清晰的功能名称。
5. 提交 PR 前跑完必要验证，并在 PR 描述中写清楚实际执行过的命令。

## 分支与提交

推荐提交标题格式：

```text
[codex][<type>] <动词><变更主题>
```

常用 type：

- `feat`: 新功能或能力扩展
- `fix`: bug 修复或兼容性修复
- `test`: 测试覆盖或测试基线更新
- `refactor`: 不改变预期行为的结构调整
- `docs`: 文档、设计说明或排障记录
- `ci`: CI、构建、容器或部署工作流
- `followup`: 评审或验证后的后续补丁

## PR 要求

PR 标题推荐：

```text
[codex] <动词><变更主题>
```

PR 描述请使用仓库模板，并至少说明：

- 变更内容
- 变更原因
- 影响
- 验证

如果是冻结后新增功能，请参考：

- `docs/guidelines/new-feature-checklist.md`
- `docs/architecture-baseline.md`

## 架构边界

请特别注意：

- 不要把业务特定分支继续塞进 `src/runtime/app.ts`、`src/runtime/turn-executor.ts` 或 `src/bridge/router.ts`。
- 新运行时能力优先通过 Runtime Module、service、workflow、CLI 或 skill 扩展。
- 新卡片优先使用共享卡片原语或业务模板入口。
- 配置变更应通过 `src/config/schema.ts`、`src/config/loader.ts` 和模块配置注册表接入。
- 外部资源、timer、worker、临时文件等必须有明确 cleanup 路径。

## 本地验证

完整验证基线：

```bash
npm run lint
npm run typecheck
npm run lint:deps
npm run check:formatter-exports
npm run check:docs-diff
npm test
npm run build
```

小文档变更可以只跑相关检查，但 PR 描述必须如实写明实际执行过什么。

## 安全与隐私

- 不要提交真实 token、app secret、用户聊天内容、合同原文、客户数据或私有日志。
- `config.json`、本地数据库、运行日志和临时材料默认不应进入提交。
- 安全漏洞请按 `SECURITY.md` 处理，不要直接公开可利用细节。

