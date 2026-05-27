# 功能说明

本文承接 README 中的能力细节。README 只保留项目门面和导航；功能解释、模块边界和典型入口放在这里维护。

## OpenCode 飞书运行时

Bridge 把 OpenCode 的运行时能力接到飞书，而不是把飞书消息简单转发给模型。

主要能力：

- 私聊、群聊、话题群拥有独立 session window。
- 支持 `/new`、`/sessions`、`/switch`、`/rename`、`/close`、`/delete` 等会话控制。
- 支持 `/models`、`/model use <provider/model>`、`/model reset` 做当前窗口模型覆盖。
- 运行中的 OpenCode turn 会通过飞书卡片展示状态、工具调用和最终结果。
- OpenCode 权限请求可通过 `/allow once`、`/allow always`、`/deny` 文本命令处理。
- 未被 Bridge 接管的 slash 命令会透传给 OpenCode。

## 材料处理与知识库

知识库面向法律材料入库、检索和问答。

主要能力：

- 支持文件、URL、目录和批量材料入库。
- 通过 `document-pipeline` 统一处理 PDF、DOCX、TXT、Markdown、图片、表格等材料。
- 支持法律问答、关键词召回、向量召回、法条精确召回和可选 rerank。
- 支持本地 SQLite / FTS / embedding 索引。
- 可选同步到飞书 Base 和 Obsidian。
- 提供本地 CLI 用于 query、ingest、parse、stats 和 doctor。

更多设计见 [法律知识库方案](modules/knowledge-base.md)。

## 法律业务工作台

法律业务能力通过 Runtime Module、领域 service、skill 和 shared workflow 接入，不直接扩大 core。

当前主要能力：

- 合同起草、合同信息提取和合同材料处理。
- 发票识别、结构化录入和飞书 Base 写入。
- 案件录入、案件更新、案件待办和案件上下文管理。
- 劳动争议材料收集、证据链整理、时间线、分析报告和二审复核。
- 基于案件工作台状态生成文书或云文档。

劳动工作流见 [劳动 Skill 工作流分层](modules/labor-skill-workflows.md)。

## 状态与记忆

Bridge 默认本地优先保存运行状态。

主要状态：

- 会话映射和窗口状态。
- 白名单、活跃知识入库、案件工作台上下文。
- 劳动案件 checkpoint 和业务缓存。
- 可选长期记忆，支持 SQLite / FTS5 / embedding 检索。
- 可选 Obsidian 同步。

清理本地状态前先看 [本地卫生清理指南](guidelines/local-hygiene.md)。

## 本地运维

Bridge 提供 portable runtime 和源码开发两种路径。

常用能力：

- `bridge onboard`：首次引导。
- `bridge init workspace`：初始化飞书 Base 和本地配置。
- `bridge start`：启动 Bridge。
- `bridge doctor workspace`：检查本地工作区。
- `bridge backup`：备份用户数据。
- `bridge cost`：查看本地 token 与成本估算。
- `bridge update check`：检查 release 更新。

部署详见 [部署说明](deploy.md)。

## 发行形态：通用版与法律版

同一套代码通过 `profile` 配置区分默认启用的能力，不需要维护两个分支或两个仓库。

- **通用版（`profile: "general"`）**：保留基础运行时、基础卡片、文件/文档能力、记忆能力和外部扩展机制，不加载法律垂直扩展。配置模板见 [config.general.example.json](../config.general.example.json)。
- **法律版（`profile: "legal"`，默认）**：在通用能力之上，默认启用法律知识库、合同助手、劳动案件和案件工作台。配置模板见 [config.legal.example.json](../config.legal.example.json)。

每个内置扩展都有独立的 `enabled` 开关：

```json
{
  "profile": "general",
  "memory": { "enabled": true },
  "extensions": {
    "knowledge-base": { "enabled": false },
    "contract-assistant": { "enabled": false },
    "labor-skill": { "enabled": false }
  },
  "caseWorkbench": { "enabled": false }
}
```

- `profile` 只提供默认值；任意扩展的显式 `enabled` 始终优先，可在 profile 基础上单独开关。
- 被关闭的扩展不会加载运行时模块，也不会认领命令、自然语言 routing 或业务卡片。
- 法律版默认启用知识库需要配置 `embeddings.provider`（或 `knowledgeBase.embeddingProvider`）；未配置时知识库会被自动跳过并给出提示。
- 案件工作台依赖劳动案件扩展提供采集能力，需与 `labor-skill` 一起启用。

## 架构边界

项目已经完成 framework freeze。后续功能应在既有 seam 内扩展：

- Bridge core 只负责 ingress/egress、session、queue、turn lifecycle、权限、问题交互和 Bridge-owned 命令。
- 飞书发送、回复、更新和 notice 收敛在 transport 风格 API 后面。
- 业务能力优先放在 Runtime Module、service、workflow、CLI 或 skill 中。
- 新内置业务扩展应拆分 `extension.meta.ts` 与 `extension.ts`。
- 外部扩展只能依赖 `src/extension-api/`。

完整规则见 [架构基线](architecture-baseline.md)。
