# Feishu OpenCode Bridge

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6)](https://www.typescriptlang.org/)
[![Feishu](https://img.shields.io/badge/Feishu-Bridge-0F6FFF)](https://open.feishu.cn/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**中文** | [English](README.en.md)

Feishu OpenCode Bridge 是一个把 OpenCode 运行时产品化到飞书里的桥接层。

它不是普通聊天机器人，而是一个 Feishu-native runtime adapter：把飞书私聊、群聊、话题群变成有会话窗口、过程卡片、权限确认、知识库、合同/劳动业务模块和长期记忆能力的 OpenCode 工作入口。

## 项目状态

- 当前版本：`0.1.27`
- 当前阶段：框架冻结已完成，进入 feature expansion / 日常维护节奏
- 当前渠道：仅支持飞书，不做多渠道抽象
- 测试基线：52 个测试文件，371 个测试通过
- 架构约束：[docs/architecture-baseline.md](docs/architecture-baseline.md)
- 新功能自检：[docs/plans/new-feature-checklist.md](docs/plans/new-feature-checklist.md)

## 核心能力

- **会话窗口**：支持私聊、群聊、话题群的 session 绑定、切换、关闭、重命名。
- **过程卡片**：运行中的 OpenCode turn 会通过飞书卡片持续更新状态、工具调用和最终回复。
- **权限确认**：OpenCode 权限请求可通过飞书按钮处理，也保留文本命令 fallback。
- **群聊协作**：通过白名单绑定支持群内免重复 `@bot` 的协作流。
- **知识库**：支持法律知识查询、批量文件入库、URL 入库和本地 CLI 诊断。
- **合同助手**：支持合同起草、案件录入/更新、待办和提醒管理。
- **劳动分析**：支持劳动争议材料收集、整理和分析输出。
- **长期记忆**：支持可选的记忆提取、检索、SQLite/FTS5 存储和 Obsidian 同步。
- **启动前诊断**：preflight 会在启动时检查配置、Feishu、OpenCode、provider 和 callback 设置。

## 为什么不是普通机器人

普通机器人通常只做消息收发和 LLM 回复。

本项目的核心价值是把 OpenCode 的运行时能力稳定地嵌入飞书：

- bridge 自己拥有 `/new`、`/sessions`、`/switch`、`/status` 等运行时控制面。
- OpenCode 原生命令继续通过 passthrough 工作。
- 业务能力放在 Runtime Module 内部，而不是继续把 `core` 写成巨型分支。
- 飞书发送、回复、更新、notice 收敛到 `FeishuTransport` 和卡片 family 入口。
- 新功能必须在冻结后的 seam 内扩展，不能随意绕过核心边界。

## 架构总览

```mermaid
flowchart LR
    user["飞书用户 / 群聊 / 话题群"] --> ws["Feishu WebSocket<br/>src/feishu/ws.ts"]
    user --> callback["Card Action Callback<br/>src/http/server.ts"]

    ws --> app["BridgeApp<br/>src/runtime/app.ts"]
    callback --> app

    app --> command["CommandHandler<br/>会话 / 模型 / 白名单 / 权限命令"]
    app --> executor["TurnExecutor<br/>OpenCode turn 执行链"]
    app --> modules["RuntimeModuleManager<br/>src/runtime/runtime-modules.ts"]

    executor <--> opencode["OpenCode Server API + SSE<br/>src/opencode/*"]
    modules --> services["Domain Services<br/>knowledge / contract / labor / memory"]
    services --> stores["Stores / DB / Local Tools<br/>JSON / SQLite / Bitable / Files"]

    command --> transport["FeishuTransport<br/>send / reply / update / notice"]
    executor --> transport
    modules --> transport
    transport --> cards["Feishu Cards / Posts<br/>src/feishu/*-cards.ts"]
    cards --> user
```

## 框架结构

```mermaid
flowchart TB
    config["Configuration<br/>src/config/schema.ts<br/>src/config/loader.ts"]

    subgraph feishu["Feishu Layer"]
      ws["WebSocket Ingress"]
      api["Feishu API Client"]
      transport["FeishuTransport"]
      cardFamilies["Card Families<br/>shared / runtime / knowledge / labor / contract"]
    end

    subgraph core["Core Runtime"]
      app["BridgeApp"]
      router["Router<br/>src/bridge/router.ts"]
      command["CommandHandler"]
      executor["TurnExecutor"]
      permission["PermissionManager"]
      turnCards["TurnCardManager"]
      resources["TurnOwnedResourceStore"]
    end

    subgraph modules["Runtime Modules"]
      knowledgeModule["KnowledgeRuntimeModule"]
      contractModule["ContractAssistantRuntimeModule"]
      laborModule["LaborRuntimeModule"]
      memoryModule["MemoryRuntimeModule"]
    end

    subgraph services["Domain Services / Workflows"]
      knowledge["KnowledgeBaseService"]
      contract["ContractAssistantService"]
      labor["LaborSkillService"]
      memory["MemoryService"]
      workflow["Evidence / Python / Local CLI"]
    end

    subgraph persistence["Persistence / External APIs"]
      json["JSON Stores<br/>mappings / whitelist / active ingests"]
      sqlite["SQLite / FTS / embeddings"]
      bitable["Feishu Bitable"]
      files["Temp files / local workspace"]
      opencode["OpenCode Server"]
    end

    config --> app
    ws --> app
    app --> router
    app --> command
    app --> executor
    app --> permission
    app --> turnCards
    app --> resources
    app --> modules

    command --> transport
    executor --> opencode
    executor --> transport
    modules --> transport
    transport --> api
    transport --> cardFamilies

    modules --> knowledge
    modules --> contract
    modules --> labor
    modules --> memory
    services --> json
    services --> sqlite
    services --> bitable
    services --> files
    services --> opencode
    contract --> workflow
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 准备配置

```bash
cp config.example.json config.json
```

至少需要配置：

- `feishu.appId`
- `feishu.appSecret`
- `opencode.baseUrl`
- `opencode.directory`
- `storage.dataDir`

如果启用飞书卡片按钮，还需要配置 `server.publicBaseUrl` 和 `feishu.cardActions`。

### 3. 启动 OpenCode

```bash
opencode serve
```

### 4. 启动 Bridge

```bash
npm run dev
```

### 5. 运行诊断

```bash
npm run doctor
```

## 常用命令

### 运行时控制

- `/new`：创建新会话
- `/status`：查看当前窗口状态
- `/sessions`：查看会话列表
- `/switch <编号>`：切换会话
- `/rename <标题>`：重命名当前会话
- `/close`、`/delete`：关闭或删除会话
- `/abort`：中止当前任务
- `/models`、`/models <provider>`：查看模型列表

### 群聊协作

- `/who`：查看当前群绑定状态
- `/leave`：解除当前用户的群聊绑定

### 权限确认

- `/allow once`
- `/allow always`
- `/deny`

### 知识库

- `/法律咨询开始`
- `/法律咨询结束`
- `/法律咨询 <问题>`
- `/kb-query <问题>`
- `/知识入库`
- `/kb-ingest-start`
- `/kb-ingest-end`

### 合同与案件

- `/合同起草开始`
- `/合同起草结束`
- `/案件录入 <案件信息>`
- `/案件更新 <更新内容>`
- `/案件待办`
- `/案件提醒`
- `/添加案件提醒 <提醒内容>`

### 劳动分析

- `/劳动分析`
- `/劳动分析结束`

未被 bridge 接管的 slash 命令会透传给 OpenCode，例如 `/model use ...`、`/model reset`、`/review`、`/init`。

## 知识库 CLI

本地知识库也提供 CLI 快速路径：

```bash
npm run --silent kb -- query --question "员工试用期最长多久？"
npm run --silent kb -- ingest file --path "/absolute/path/to/file.pdf"
npm run --silent kb -- ingest url --url "https://example.com/article"
npm run --silent kb -- doctor
```

## 配置说明

配置文件以 [config.example.json](config.example.json) 为模板。

主要配置块：

- `feishu`：飞书应用、机器人身份、WebSocket、卡片回调和行为开关。
- `server`：HTTP 服务监听地址、健康检查和公网回调地址。
- `opencode`：OpenCode 服务地址和工作目录。
- `storage`：会话映射、白名单、日志和业务状态目录。
- `bridge`：队列、会话模式、超时和系统状态注入。
- `memory`：长期记忆开关、存储和同步设置。
- `knowledgeBase`：知识库开关、入库、检索、本地数据库和多维表格配置。
- `contractAssistant`：合同、案件、发票和提醒能力配置。
- `laborSkill`：劳动分析材料收集和输出配置。

## 开发命令

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run dev
npm run dev:once
```

当前完整验证基线：

```text
52 test files
371 tests
```

## 项目目录

```text
src/
  bridge/              # router, queue, turn state, watchdog, module interface
  config/              # zod schema and config loader
  feishu/              # Feishu API, WebSocket ingress, card families
  http/                # healthz and card action callback server
  runtime/             # BridgeApp, command handler, turn executor, transport, preflight
  knowledge/           # legal knowledge base, parser, local CLI, SQLite mirror
  contract-assistant/  # contract drafting, case updates, reminders
  labor/               # labor dispute material collection and analysis
  memory/              # long-term memory, retrievers, embeddings, Obsidian sync
  opencode/            # OpenCode client and event stream
  store/               # JSON stores for mappings, whitelist, active ingests
  workflows/           # workflow helpers
scripts/               # doctor, onboard, knowledge CLI wrappers
docs/                  # architecture, deployment, plans, archived demo docs
test/                  # Vitest unit and integration tests
```

## 文档入口

- [架构基线](docs/architecture-baseline.md)
- [新功能自检清单](docs/plans/new-feature-checklist.md)
- [飞书 Markdown 输出规范](docs/feishu-markdown.md)
- [部署说明](docs/deploy.md)
- [Formatter 迁移记录](docs/plans/formatter-migration.md)
- [框架冻结验收](docs/plans/freeze-acceptance.md)

## 部署

单机部署建议：

```text
Feishu <-> HTTPS / Caddy <-> Bridge HTTP + WebSocket <-> OpenCode Server
```

参考：

- [docs/deploy.md](docs/deploy.md)
- [ops/Caddyfile](ops/Caddyfile)
- [.env.example](.env.example)

健康检查：

```text
GET /healthz
```

默认卡片回调路径：

```text
/webhook/card
```

## 贡献与开发约束

本项目已经完成框架冻结。后续功能开发请遵守：

- 新功能优先落在 Runtime Module / Service / Transport seam 内。
- 不要在 `src/runtime/app.ts`、`src/runtime/turn-executor.ts`、`src/bridge/router.ts` 里新增业务特定分支，除非同步更新架构基线。
- 新卡片走 `src/feishu/*-cards.ts` family entrypoint，不要继续扩张 `formatter.ts`。
- 模块状态持久化复用共享基础设施，不复制 timer + JSON persist 逻辑。
- PR 描述里建议附上 [new-feature-checklist](docs/plans/new-feature-checklist.md) 自检结果。

## License

[MIT](LICENSE)
