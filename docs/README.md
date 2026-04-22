# 文档索引

这个目录用于区分当前仍在使用的运行文档和历史归档资料。

查阅时请优先使用现行文档。归档文件只用于补充背景，不应覆盖当前生效的架构基线或规范。

`AGENTS.md` 是面向 coding agent 和其他仓库感知型助手的高优先级执行指南。
它适合承载高频、强约束的操作规则，例如 runtime ownership、GitHub 交付约定、issue 写作规则、架构 guardrails，以及 framework freeze 之后的新功能自检摘要。
当你需要这些规则背后的长文解释、设计理由、模块背景或历史上下文时，再进入 `docs/` 查阅。

## 当前入口

- [架构基线](architecture-baseline.md)：freeze 之后的运行时边界、扩展 seam 和 reviewer 规则。
- [部署说明](deploy.md)：本地与服务器部署、环境变量、Caddy、健康检查和验收步骤。
- [飞书 Markdown 输出规范](feishu-markdown.md)：面向飞书输出的 Markdown 规则与长文本排版约束。
- [可观测性事件规范](observability/event-schema.md)：运行时可观测性的稳定事件名与日志字段。

## 规范

- [新功能自检清单](guidelines/new-feature-checklist.md)：framework freeze 之后功能 PR 的自检清单。

## 模块

- [法律知识库方案](modules/knowledge-base.md)：知识库模块的设计说明与工作流说明。

## 待办

- [冻结后待办](backlog/post-freeze-backlog.md)：framework freeze 之后仍然保留的后续工作。

## 与 AGENTS 的关系

- `AGENTS.md`：面向 agent 的精简高频操作规则。
- `docs/architecture-baseline.md`：补充 `AGENTS.md` 中架构 guardrails 背后的完整契约。
- `docs/guidelines/new-feature-checklist.md`：补充 `AGENTS.md` 中新功能规则的完整清单。
- `docs/modules/*`：模块背景和设计说明，细节程度高于 `AGENTS.md`。
- `docs/archive/*`：历史资料，只提供背景，不覆盖当前规则。

## 归档

- `archive/design-history/`：设计历史、迁移记录和仍有解释价值的历史说明。
- `archive/qa-and-submission/`：framework freeze 验收与保留的提交阶段里程碑资料。

归档文档里可能还会出现 `docs/plans/...` 这类旧路径。
除非当前活文档显式指向它们，否则不要把这些旧路径当成现行入口。
