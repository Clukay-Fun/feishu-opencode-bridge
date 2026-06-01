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

## 保留的工程纪律

这些做法是当前项目治理中已经验证有效的基础习惯。后续优化可以继续叠加，但不要为了提速或省步骤而破坏它们。

- 坚持 slice plan：每个较大变更先写清目标、范围、包含内容、不包含内容、行为规则和验收标准，再进入实现。slice 应能被独立执行、独立 review、独立验证。
- 保持 audit 审查模式：执行完成后不要只看汇报，要跨文件、跨测试、跨文档验证 claim。重点检查是否存在未声明的范围缩减、遗漏验收项、行为变化未写文档、或测试只覆盖了表面路径。
- 用 ADR 沉淀重大决策：影响术语、架构 seam、状态模型、数据迁移、权限边界或长期维护成本的决策，应写入 `docs/adr/`。ADR 记录“为什么这么定”，活规则仍以 `docs/architecture-baseline.md` 等当前文档为准。
- 做好 issue 评论收口：关闭 issue 前应留下决策摘要、验收结果、实际验证命令和 follow-up 候选。不要只改代码或直接 close，让后续维护者能从 issue 读回完整上下文。
- 让架构基线常驻：`docs/architecture-baseline.md` 是当前项目的运行时架构契约。所有 slice、PR 和重构都应能对齐它；如果对不上，要么调整方案，要么先更新架构基线并解释原因。

## Issue 规范

- 新 issue 必须使用 `.github/ISSUE_TEMPLATE/` 下的模板，不开 blank issue。
- Bug 使用 `bug_report.yml`，必须写清背景、问题、复现步骤、期望行为和影响范围；日志必须脱敏。
- 新能力或增强使用 `feature_request.yml`，必须写清业务场景、期望行为、验收标准和非目标。
- 技术债或重构使用 `tech_debt.yml`，必须写清源码依据、维护风险、建议方案、验收标准和非目标。
- 文档问题使用 `docs.yml`，必须写清目标文档、当前误导点或缺口、期望内容和验收标准。
- 安全问题不要开公开 issue，走 `.github/ISSUE_TEMPLATE/config.yml` 指向的 GitHub Security Advisory。
- 涉及 architecture seam 的 issue，要引用 `docs/architecture-baseline.md` 或说明为什么不需要改架构基线。

## PR 规范

- 单仓库、单人开发也必须走 PR 工作流；不要把功能改动直接推到 `codex/dev` 或 `main`。
- 日常开发基线是 `codex/dev`；`main` 只接收阶段性稳定发布或明确要求的热修。
- 每个功能、修复或文档收口都从最新 `codex/dev` 新建 feature 分支，命名格式为 `codex/<type>/<scope>-<short>`，例如 `codex/feat/memory-v2-slice-a`、`codex/fix/setup-ui-validation`、`codex/docs/pr-workflow`。
- feature 分支提交并推送后，创建以 `codex/dev` 为 base 的 PR；即便没有外部 reviewer，也要在 PR 中完成自审、验证记录和影响说明。
- PR 合并默认使用 squash merge，让 `codex/dev` 保持一条可回滚、可定位的功能级历史。
- 合并后删除对应 feature 分支；未合并的实验分支要关闭 PR 并删除，避免干扰后续重构判断。
- 只有纯本地临时试验可以不推 PR；一旦代码进入远端或需要保留，就补成 feature 分支和 PR。
- PR 描述使用 `.github/PULL_REQUEST_TEMPLATE.md`，至少填写变更内容、变更原因、影响和验证。
- 新功能 PR 应附上 `docs/guidelines/new-feature-checklist.md` 的自检结果。
- 如果改了 framework seam、runtime module seam、transport、config、extension API 或观测事件，同一 PR 必须更新对应 docs。
- PR 应保持一个清晰主题。不要把无关修复、格式化、文档搬迁和业务行为改动混进同一个 PR。
- PR 验证区必须列出实际运行过的命令；没跑的检查要说明原因。
- 用户可见行为、飞书卡片、命令输出、配置字段或迁移行为变化，要在 PR 影响区明确写出。
- 发布相关 PR 要说明版本号、目标平台、artifact、回滚路径和人工验收结果。

## CI 规范

- GitHub Actions 是最低限度的质量闸门，不替代本地验证，但负责兜底本地漏跑的检查。
- `.github/workflows/ci.yml` 必须在 push 到 `main` 或 `codex/dev` 时运行，并且所有 PR 都必须运行。
- CI 至少覆盖 `npm run typecheck`、`npm test` 和 `npm run lint`；项目当前额外保留依赖边界、formatter export 和 docs-diff 检查。
- PR 页面出现红叉时不要合并；先查看失败步骤和日志，修复后重新推送同一 feature 分支。
- 面向律所部署或 release 前，应以最近一次 `main` 或 `codex/dev` 的 CI 绿色结果作为可部署信号之一。

## 自 Review 清单

单人项目也要在 PR 提交前做 15 分钟自 review。重点看 diff，而不是只回到编辑器里看代码。

- [ ] 重新通读 `git diff`，优先用 diff 视角找 typo、遗漏、误删和无关改动。
- [ ] 确认测试覆盖了关键路径；不要求覆盖所有路径，但关键行为必须有信号。
- [ ] 如果删了一段代码、命令、卡片、配置或文档入口，用 `rg` 搜一下是否还有引用。
- [ ] 检查 commit message 或 PR 标题描述的 what 是否和 diff 一致；不要写 X，实际提交 X + Y。
- [ ] 判断 `CHANGELOG`、README、docs、架构基线、卡片规范或命令手册是否需要同步更新。
- [ ] 对照 slice plan 检查范围是否一致，是否有“顺手”超出或未声明的范围缩减。
- [ ] 重新跑 `npm run typecheck` 和相关测试；不要用“上次跑过了”代替本次验证。

## 文档生命周期

文档也有生命周期。不要让已完成 slice、过期设计和当前有效规范长期混在同一个目录里。

- `docs/architecture-baseline.md`：实时维护的架构契约，是项目当前“宪法”。
- `docs/adr/`：永久决策记录，只增不删。ADR 过时时不要直接删除；新增 ADR 并在旧 ADR 顶部标记 `Superseded by ADR xxxx`。
- `docs/backlog/active/`：正在做、下个 sprint 准备做、或仍需执行的 slice plan。
- `docs/backlog/completed/`：已完成的 slice plan。完成后移动到这里，保留验收和复盘价值。
- `docs/backlog/audit-reports/`：审查报告、差距分析、收口决策矩阵。
- `docs/archive/`：完全过时、几乎不再读取但仍有历史价值的材料。
- `docs/modules/`：模块说明，必须随代码和用户行为变化持续维护。

移动规则：

- slice 完成后，相关 plan 移到 `docs/backlog/completed/`，不要继续堆在 active backlog 里。
- 模块整体废弃后，相关模块文档移到 `docs/archive/`，并在仍被引用的位置留下新入口。
- audit 报告放入 `docs/backlog/audit-reports/`，不要和待执行 slice plan 混放。
- ADR 不删除；被新决策推翻时，用新 ADR 记录，并在旧 ADR 顶部标记 superseded。

过期信号：

- 文档提到的源码路径、命令、配置字段或卡片入口已经不存在。
- 文档里的决策被新 ADR、架构基线或当前实现推翻。
- 文档超过 6 个月没人引用，且不属于 ADR、架构基线、模块说明或历史归档。
- 文档描述的是一次性执行计划，但对应 issue / PR 已完成。

## Release 流程

- release 前先跑：`npm run lint`、`npm run typecheck`、`npm test`。
- 如果改了 dependency boundary、formatter export、docs seam，再补跑：`npm run lint:deps`、`npm run check:formatter-exports`、`npm run check:docs-diff`。
- release 前必须更新 `CHANGELOG.md`，把 `Unreleased` 中已发布内容移动到对应版本，并填写日期。
- 先构建产物：`npm run build`。
- 生成 portable 包：`npm run release:portable`。脚本输出到 `release/`，包名形如 `feishu-opencode-bridge-<platform>-<arch>.*`。
- 发布 artifact 前确认包内包含 `dist/`、`scripts/runtime/`、启动器、配置样例和 README，不包含 `src/`。
- 发布说明应覆盖：版本号、主要变化、兼容性/迁移说明、验证命令、已知风险、回滚方式。
- portable 更新链路以 `scripts/runtime/update.mjs` 为准；下载、切换、回滚都必须显式触发，不覆盖用户数据目录。
- 如果重新引入或升级原生依赖，按 `docs/deploy.md` 的目标环境要求，在 Linux x64 上重新验证 `npm ci`、`npm run build`、`npm test`。

版本号规则按简化 SemVer 执行：

- `0.X.Y -> 0.X.(Y+1)`：bug fix、文档修正或不改变行为的小修。
- `0.X.Y -> 0.(X+1).0`：新增功能、较大内部改造或可能存在轻微 breaking 的开发版。
- `0.X.Y -> 1.0.0`：正式稳定发布或需要向外承诺兼容性边界。
- `1.0.0` 之后遵循 `MAJOR.MINOR.PATCH`，breaking change 必须升 MAJOR。

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
