# Codex 开发准则

## 文件职责

这个文件只约束 Codex 和其他 coding agent 如何修改本仓库。

- 先读 `AGENTS.md`。它定义 Bridge 的运行时契约和架构边界。
- 再读本文件。它定义开发流程、本地命令、检查清单和实现卫生。
- 如果两者冲突：产品/运行时行为以 `AGENTS.md` 为准；代码修改方式以本文件为准。

## 放置规则

- 写进 `AGENTS.md`：Bridge 在飞书里的运行时所有权、用户可见行为、架构 guardrails、skill runtime 产品契约。
- 写进 `CODEX.md`：Codex 如何搜索、实现、验证、操作 CLI、处理 dirty worktree 和维护注释。
- 写进 `docs/`：长文设计、模块背景、架构解释、完整 checklist、历史记录和排障手册。
- `docs/archive/AGENTS-dev.md`：旧版 `AGENTS.md` 拆出的历史开发规范，仅作为维护背景保留；新增规则不要继续写入这里。
- 不要把临时任务计划、一次性调试结论、个人偏好或未验证猜测写进 `AGENTS.md`。

## 工作方式

- 编辑前先理解现有 seam。优先用 `rg`、聚焦读文件和现行文档，不靠猜。
- 改动保持手术刀式。除非任务要求，不重构邻近代码、不改名概念、不扩大 framework seam。
- 尊重 dirty worktree。不要回滚用户改动，也不要清理无关生成物。
- 不要在 `src/runtime/app.ts`、`src/runtime/turn-executor.ts`、`src/bridge/router.ts` 增加业务特定分支，除非同一改动更新架构基线。
- 新能力应通过 runtime module、extension meta/runtime seam、shared service 或 workflow 专属模块进入。

## Issue 规范

- 新 issue 必须使用 `.github/ISSUE_TEMPLATE/` 下的模板，不开 blank issue。
- Bug 使用 `bug_report.yml`，必须写清背景、问题、复现步骤、期望行为和影响范围；日志必须脱敏。
- 新能力或增强使用 `feature_request.yml`，必须写清业务场景、期望行为、验收标准和非目标。
- 技术债或重构使用 `tech_debt.yml`，必须写清源码依据、维护风险、建议方案、验收标准和非目标。
- 文档问题使用 `docs.yml`，必须写清目标文档、当前误导点或缺口、期望内容和验收标准。
- 安全问题不要开公开 issue，走 `.github/ISSUE_TEMPLATE/config.yml` 指向的 GitHub Security Advisory。
- 涉及 architecture seam 的 issue，要引用 `docs/architecture-baseline.md` 或说明为什么不需要改架构基线。

## PR 规范

- PR 描述使用 `.github/PULL_REQUEST_TEMPLATE.md`，至少填写变更内容、变更原因、影响和验证。
- 新功能 PR 应附上 `docs/guidelines/new-feature-checklist.md` 的自检结果。
- 如果改了 framework seam、runtime module seam、transport、config、extension API 或观测事件，同一 PR 必须更新对应 docs。
- PR 应保持一个清晰主题。不要把无关修复、格式化、文档搬迁和业务行为改动混进同一个 PR。
- PR 验证区必须列出实际运行过的命令；没跑的检查要说明原因。
- 用户可见行为、飞书卡片、命令输出、配置字段或迁移行为变化，要在 PR 影响区明确写出。
- 发布相关 PR 要说明版本号、目标平台、artifact、回滚路径和人工验收结果。

## Release 流程

- release 前先跑：`npm run lint`、`npm run typecheck`、`npm test`。
- 如果改了 dependency boundary、formatter export、docs seam，再补跑：`npm run lint:deps`、`npm run check:formatter-exports`、`npm run check:docs-diff`。
- 先构建产物：`npm run build`。
- 生成 portable 包：`npm run release:portable`。脚本输出到 `release/`，包名形如 `feishu-opencode-bridge-<platform>-<arch>.*`。
- 发布 artifact 前确认包内包含 `dist/`、`scripts/runtime/`、启动器、配置样例和 README，不包含 `src/`。
- 发布说明应覆盖：版本号、主要变化、兼容性/迁移说明、验证命令、已知风险、回滚方式。
- portable 更新链路以 `scripts/runtime/update.mjs` 为准；下载、切换、回滚都必须显式触发，不覆盖用户数据目录。
- 如果重新引入或升级原生依赖，按 `docs/deploy.md` 的目标环境要求，在 Linux x64 上重新验证 `npm ci`、`npm run build`、`npm test`。

## 飞书、Lark 与知识库操作

- 只有用户明确要求操作飞书或 Lark 资源时，才使用 `lark-cli`。
- 操作飞书或 Lark 资源时，优先用 `lark-cli` 和已安装的 `lark-*` skills，不写临时脚本绕过。
- 知识库 CLI fast path：
  - 查询：`npm run --silent kb -- query --question "<问题>"`
  - 本地文件入库：`npm run --silent kb -- ingest file --path "<绝对路径>"`
  - URL 入库：`npm run --silent kb -- ingest url --url "<URL>"`
  - PDF 解析诊断：`npm run --silent kb -- parse pdf --path "<绝对路径>"`
  - 知识库诊断：`npm run --silent kb -- doctor`
- 除非用户明确要求检查或修改知识库实现，否则优先使用这些 CLI 入口。

## 实现规则

- 配置改动必须经过 `src/config/schema.ts`、`src/config/loader.ts` 和模块配置注册表。
- 新卡片应使用卡片家族入口：`shared-primitives`、`runtime-cards`、`knowledge-cards`、`labor-cards`、`contract-cards`。
- runtime 和 transport 事件必须使用 `docs/observability/event-schema.md`，不要发明临时事件名。
- 如果功能改变 architecture seam，合并前必须更新 `docs/architecture-baseline.md`。
- 代码注释默认使用中文，除非注释内容是外部 API 原文、协议字段、错误码或必须保持英文的术语。
- 为新增的重要文件添加文件头注释，沿用项目现有的 `职责 / 关注点` 模板。
- 为非显而易见的代码路径添加简洁注释，尤其是兼容逻辑、fallback 行为、并发/定时器处理、外部 API 特殊行为和跨模块契约。
- 注释应解释代码为什么存在、保护什么不变量、或规避什么历史问题；不要添加逐行复述代码的低价值注释。

## 检查命令

先跑最窄的相关检查，再按风险扩大范围。

- `npm run lint`
- `npm run typecheck`
- `npm run lint:deps`
- `npm run check:formatter-exports`
- `npm run check:docs-diff`
- 定向测试：`npm test -- <test-pattern>`
- 触碰共享 runtime seam、transport、cards、config、extension loading 或跨模块行为时，跑完整测试：`npm test`

## 文档入口

- `docs/architecture-baseline.md`：现行架构契约。
- `docs/guidelines/new-feature-checklist.md`：freeze 后新功能 PR 自检清单。
- `docs/guidelines/business-extension-development.md`：内置业务扩展开发规范。
- `docs/README.md`：现行文档索引。
- `docs/observability/event-schema.md`：可观测性事件名和字段。
