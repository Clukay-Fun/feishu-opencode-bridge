# Changelog

本项目变更记录参考 [Keep a Changelog](https://keepachangelog.com/) 格式，版本号遵循 [SemVer](https://semver.org/)。

## [Unreleased]

### Added

- 无。

### Changed

- 无。

### Deprecated

- 无。

### Removed

- 无。

### Fixed

- 无。

### Security

- 无。

## [0.3.0-beta.1] - 2026-06-05

### Added

- 新增 Bridge Scheduler 能力，支持自然语言创建定时任务，并通过 `/cron` 管理查看、暂停、恢复、立即执行、删除和查看运行记录。
- 新增 scheduler 独立运行时、持久化 store、执行 runner、确认卡片和防递归执行上下文。
- 新增 Bridge MCP 只读工具：`Bridge_scheduler_status`、`Bridge_window_state`、`Bridge_recent_materials`。
- 新增 agent 可见性快照，Bridge 会写入当前窗口和最近材料状态，供 MCP 工具读取。
- 新增 `.opencode/skills/bridge-sessions`、`scheduler`、`file-materials`、`knowledge-base`，帮助 agent 正确认知 Bridge 能力边界。
- 新增 scheduler 与 agent visibility ADR、slice plan 和 MCP 使用说明。

### Changed

- 系统提示收敛为能力边界说明，实时窗口、调度器和材料状态改由 Bridge MCP 工具读取。
- 文件上传默认先形成材料上下文和意图确认，不再把所有普通文件立即推入深度处理。
- 本地运行台改为更简洁的对话流预览，默认保留 scrollback，dashboard/sticky 需要显式开启。
- 知识库解析 provider 默认顺序改为质量优先，外部 OCR 仍需显式开启后才会调用。
- `fob mcp` / `feishu-opencode-bridge mcp` 可直接启动 Bridge MCP stdio server。

### Deprecated

- 无。

### Removed

- 无。

### Fixed

- 修复飞书卡片回调返回 `{toast}` 或发送消息 payload 时可能不符合 CardActionHandler 返回格式的问题。
- 修复文件消息缺少文件名但带 `file_key` 时无法作为材料上下文继续处理的问题。
- 修复运行台 turn 完成摘要重复展示用户输入的问题。

### Security

- MCP 工具仅暴露只读快照，不提供写入、删除或任务创建入口。

## [0.3.0-beta.0] - 2026-06-04

### Added

- 新增 npm beta 安装入口，`feishu-opencode-bridge` 与 `fob` 全局命令统一分发到跨平台启动器。
- README 与 README.en 增加 beta 安装示例和 npm beta 徽章。
- 新增服务器部署脚本、服务器工具更新脚本和 Cloudflare Tunnel compose 示例。
- 运行台活动视图新增用户入站消息、机器人最终回复和 turn 摘要展示。
- 结构化日志新增 `bridge/message inbound.received` 事件，补充 chat、conversation、thread 和 message 上下文字段。

### Changed

- 运行台启动脚本优先使用本地 TypeScript 源码启动，避免开发时误跑过期 `dist` 产物。
- 活动视图改为 tail bridge 结构化日志，并输出更适合排查的 JSON 字段。
- Docker builder 阶段补充 native 依赖安装，提升 npm 安装与构建兼容性。
- 服务器部署规范收口到 `CODEX.md`，明确 runtime 私有文件不可被覆盖。

### Deprecated

- 无。

### Removed

- 无。

### Fixed

- 修复 OpenCode reasoning 文本流可能混入最终回复的问题，只有确认的 text part 会进入最终答案。
- 服务器部署脚本不再内置具体服务器地址、用户和 SSH key 路径，改为运行时显式传入环境变量。

### Security

- 部署脚本移除仓库内硬编码的服务器连接信息，降低误提交部署细节的风险。

## [0.3.0] - 2026-06-03

### Added

- README 瘦身，新增 `docs/features.md` 和 `docs/commands.md` 承接功能与命令细节。
- `CODEX.md` 新增工程纪律、自 review 清单、文档生命周期和 release changelog 规则。
- Docker 部署支持：Dockerfile 多阶段构建参数化、HEALTHCHECK、`docker-compose.yml`、`docs/deploy-docker.md`。
- `package.json` 补充 description、license、repository、keywords 等元数据字段。
- README 新增 CI 状态徽章。

### Changed

- 文档入口补充功能说明、命令手册和 backlog 生命周期入口。
- `.dockerignore` 扩充忽略范围（`.DS_Store`、`.runtime`、`artifacts`、`release`、`turn-files`、`vault`）。

### Deprecated

- 无。

### Removed

- 无。

### Fixed

- 修正 README 许可证徽章从 MIT 为 Apache-2.0，与 LICENSE 文件保持一致。

### Security

- 无。

## [0.2.2] - 2026-05-31

### Added

- Memory v2 工作记忆系统规划与 slice 拆分。
- File Workspace 能力层规划与分阶段 slice。
- 终端 Setup UI 规划。
- Portable 发布包收口规划。
- 劳动材料文件夹自然语言收集规划。

### Changed

- README 从完整手册收敛为项目门面，功能、命令、配置和开发细节下沉到文档入口。
- 文档索引补充 ADR、功能说明、命令手册和治理文档入口。
- 开发规范补充 PR 工作流、自 review、slice plan、audit、ADR 和 issue 收口要求。

### Deprecated

- 无。

### Removed

- README 中移除长项目动态、长架构图、完整命令清单、配置长表、目录树和贡献长规则。

### Fixed

- 无。

### Security

- 无。

## [0.2.1] - 2026-05-12

### Added

- 发票连续上传后统一收口。
- 案件提醒卡片改为紧凑任务视图。

### Changed

- 发票金额和 Base 日期展示更稳。
- 权限审批后回写原请求卡片，减少重复点击和状态误解。

## [0.2.0] - 2026-05-09

### Added

- 案件工作台成为劳动材料收集主入口。
- 知识库新增类型化条目、法条精确召回、Jina-compatible 重排和基础脱敏层。
- 劳动二审链路新增案件断点记忆。

### Changed

- 用户侧卡片收敛到设计器模板。
- 文档与命令面统一到中文优先口径。
