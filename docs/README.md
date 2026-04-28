# 文档索引

这个目录用于区分当前仍在使用的运行文档和历史归档资料。

查阅时请优先使用现行文档。归档文件只用于补充背景，不应覆盖当前生效的架构基线或规范。

`AGENTS.md` 是面向 coding agent 和其他仓库感知型助手的高优先级执行指南。
它适合承载高频、强约束的操作规则，例如 runtime ownership、GitHub 交付约定、issue 写作规则、架构 guardrails，以及 framework freeze 之后的新功能自检摘要。
当你需要这些规则背后的长文解释、设计理由、模块背景或历史上下文时，再进入 `docs/` 查阅。

## 当前入口

- [架构基线](architecture-baseline.md)：freeze 之后的运行时边界、data-only extension meta / runtime extension seam 和 reviewer 规则。
- [部署说明](deploy.md)：本地与服务器部署、环境变量、Caddy、健康检查和验收步骤。
- [飞书 Markdown 输出规范](feishu-markdown.md)：面向飞书输出的 Markdown 规则与长文本排版约束。
- [可观测性事件规范](observability/event-schema.md)：运行时可观测性的稳定事件名与日志字段。

## 规范

- [新功能自检清单](guidelines/new-feature-checklist.md)：framework freeze 之后功能 PR 的自检清单。
- [内置业务扩展开发规范](guidelines/business-extension-development.md)：新增内置业务扩展时的目录、manifest、命令、配置和禁止事项。

## 模块

- [法律知识库方案](modules/knowledge-base.md)：知识库模块的设计说明与工作流说明。
- [劳动 Skill 工作流分层](modules/labor-skill-workflows.md)：劳动领域总入口、专项能力和 shared skills 的边界说明。

## 扩展与配置

- `src/extension-api/` 是未来外部扩展唯一允许依赖的公共契约面；它是 L2 动态加载前置，不是热拔插或沙箱。
- 启动期外部扩展加载器扫描 `${BRIDGE_EXTENSIONS_DIR}` 或 `${BRIDGE_HOME:-.}/extensions`；扩展配置放在 `config.json.extensions` 下。
- 外部扩展 manifest 默认加载 `dist/meta.js` 和 `dist/runtime.js`；开发模式可设置 `BRIDGE_EXTENSIONS_DEV=1` 优先加载 `devMeta` / `devRuntime`，生产环境还需 `BRIDGE_ALLOW_DEV_IN_PROD=1` 才允许这样做。
- 外部扩展目录必须包含自己的 `package.json`；运行时依赖应安装在扩展自己的 `node_modules`，loader 会拒绝向上泄漏到 bridge 根目录依赖的扩展。
- 外部扩展本地管理命令为 `npm run ext:install/list/remove/pack`，仅支持本地目录或 `.tgz`，不连接 npm registry。
- 推荐把内置扩展配置写在 `extensions["knowledge-base"]`、`extensions["contract-assistant"]`、`extensions["labor-skill"]`；运行时输出仍归一化为 `config.knowledgeBase`、`config.contractAssistant`、`config.laborSkill`，legacy 顶层字段继续兼容。
- 内置业务扩展通过 `extension.meta.ts` 和 `extension.ts` 双入口做启动期静态注册，不是第三方 plugin API，也不支持运行时热拔插。
- `src/extensions/builtin-meta.ts` 聚合 data-only meta，供配置、命令声明和业务卡片模板使用。
- `src/extensions/builtin.ts` 聚合 runtime extension，只供 runtime module assembly 创建模块。
- `knowledge` 与 `memory` 当前按 shared service module 处理；它们可以有 extension meta，但依赖边界上不等同于普通业务扩展。
- `commands` 目前只用于文档、冲突检测和未来 help 展示；实际命令解析仍由 core router 和各 RuntimeModule 负责。
- 模块配置优先落在 `<module>/config.ts`，由 `<module>/extension.meta.ts` 的 `configDefinition` 接入 `src/config/modules.ts`；当前已覆盖 `knowledgeBase`、`contractAssistant`、`laborSkill`。

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
