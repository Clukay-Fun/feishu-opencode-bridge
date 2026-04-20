# Feishu OpenCode Bridge

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6)](https://www.typescriptlang.org/)
[![Feishu](https://img.shields.io/badge/Feishu-Bridge-0F6FFF)](https://open.feishu.cn/)
[![Tests](https://img.shields.io/badge/tests-371%20passing-success)](#%EF%B8%8F-development-commands)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[中文](README.md) | **English**

> **Feishu OpenCode Bridge is not a normal Feishu bot.**
> It is a **Feishu-native runtime adapter** that productizes the OpenCode runtime inside Feishu, giving private chats, group chats, and topic groups session windows, process cards, permission confirmation, a legal knowledge base, contract/labor modules, and long-term memory.

## 📢 News

- **2026-04-19** · Post-freeze backlog cleared, the `TurnExecutor` settlement controller landed, and the project moved into regular maintenance
- **2026-04-10** · Framework freeze accepted; [architecture baseline](docs/architecture-baseline.md) and [new feature checklist](docs/guidelines/new-feature-checklist.md) became PR entry gates
- **2026-03** · Runtime Module abstraction completed; knowledge, contract, labor, and memory modules converged on a shared seam
- **2026-02** · `FeishuTransport` became the single Feishu-side delivery boundary, and cards were split into family files

<details>
<summary>Earlier milestones</summary>

- Formatter was split from one large file into five families: `shared-primitives`, `runtime-cards`, `knowledge-cards`, `labor-cards`, and `contract-cards`
- OpenCode turn execution was split into `prepareTurnExecution` and `handlePermissionAskedEvent`
- Contract assistant, labor analysis, knowledge CLI, and Bitable mirror capabilities shipped
- Long-term memory integrated SQLite / FTS5 and Obsidian sync

</details>

## 💡 Core Capabilities

- **Session windows**: bind, switch, close, delete, and rename sessions across private chats, group chats, and topic groups
- **Process cards**: long-running OpenCode turns update Feishu cards with status, tool calls, and final replies
- **Permission confirmation**: OpenCode permission requests can be handled through Feishu buttons, with text command fallback
- **Group collaboration**: whitelist binding keeps group collaboration usable without repeated `@bot` mentions
- **Knowledge base**: legal knowledge search, batch file ingestion, URL ingestion, and local CLI diagnostics
- **Contract assistant**: contract drafting, case create/update flows, todos, and reminder management
- **Labor analysis**: collect labor dispute materials and produce structured analysis output
- **Long-term memory**: optional memory extraction, retrieval, SQLite / FTS5 storage, and Obsidian sync
- **Startup diagnostics**: preflight checks config, Feishu, OpenCode, providers, and callback settings before startup

## 🧭 Why This Is Not A Normal Bot

A normal bot usually receives messages and returns LLM replies. This project embeds OpenCode runtime capabilities into Feishu with stable operational boundaries:

- The bridge owns runtime commands such as `/new`, `/sessions`, `/switch`, and `/status`
- OpenCode-native commands continue to work through passthrough
- Business capabilities live inside Runtime Modules instead of growing the `core` runtime
- Feishu send, reply, update, and notice calls converge on `FeishuTransport` and card family entrypoints
- New features must expand inside the frozen seams and must not bypass core boundaries casually

## 🏗️ Architecture

### Request Flow

```mermaid
flowchart LR
    user["Feishu users / groups / topic groups"] --> ws["Feishu WebSocket<br/>src/feishu/ws.ts"]
    user --> callback["Card Action Callback<br/>src/http/server.ts"]

    ws --> app["BridgeApp<br/>src/runtime/app.ts"]
    callback --> app

    app --> command["CommandHandler<br/>sessions / models / whitelist / permission commands"]
    app --> executor["TurnExecutor<br/>OpenCode turn execution"]
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

### Layered View

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

## ✨ Capability Showcase

| Session Windows | Process Cards | Permission Confirmation | Knowledge Ingestion |
| :-- | :-- | :-- | :-- |
| Private chats, group chats, and topic groups bind independently, and switching does not lose context | Cards update in place, tool calls unfold progressively, and final replies land where the work happened | Sensitive actions ask through buttons first, while `/allow` and `/deny` remain available as text fallback | Drop files into chat, paste URLs, or batch ingest documents with visible progress cards |
| `/new` · `/switch` · `/sessions` | Live tool calls + final reply | Buttons / `/allow` / `/deny` | Files · URLs · batch |

| Contract Assistant | Labor Analysis | Long-Term Memory | Startup Diagnostics |
| :-- | :-- | :-- | :-- |
| From contract drafting to case tracking, todos and reminders can be pushed by schedule | Collect salary, attendance, and agreement materials, then generate dispute analysis | Retrieve by conversation or topic, with optional Obsidian sync | Check Feishu, OpenCode, and callbacks before runtime starts, and fail loudly when something is missing |
| Drafting · cases · todos · reminders | Material collection + analysis output | SQLite + FTS5 + Obsidian | `npm run doctor` |

> Screenshots and GIFs are still being added. For now, run `npm run dev` and send the example commands in Feishu to reproduce the card experience.

## 🚀 Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Prepare config
cp config.example.json config.json

# 3. Start OpenCode
opencode serve

# 4. Start the bridge
npm run dev

# 5. Run diagnostics
npm run doctor
```

At minimum, configure `feishu.appId`, `feishu.appSecret`, `opencode.baseUrl`, `opencode.directory`, and `storage.dataDir`.
If Feishu card buttons are enabled, also configure `server.publicBaseUrl` and `feishu.cardActions`.

## 📖 Common Commands

Quick reference:

- `/new` · `/status` · `/sessions` · `/switch <index>` — session control
- `/allow once` · `/allow always` · `/deny` — permission confirmation
- `/法律咨询 <question>` · `/kb-query <question>` — knowledge base query
- `/合同起草开始` · `/案件录入 <case info>` — contract assistant
- `/劳动分析` — labor dispute analysis

<details>
<summary>Show all commands</summary>

### Runtime Control

- `/new`: create a new session
- `/status`: show the current window status
- `/sessions`: list sessions
- `/switch <index>`: switch sessions
- `/rename <title>`: rename the current session
- `/close`, `/delete`: close or delete sessions
- `/abort`: abort the current turn
- `/models`, `/models <provider>`: list available models

### Group Collaboration

- `/who`: show the current group binding state
- `/leave`: remove the current user's group binding

### Permission Confirmation

- `/allow once`
- `/allow always`
- `/deny`

### Knowledge Base

- `/法律咨询开始`
- `/法律咨询结束`
- `/法律咨询 <question>`
- `/kb-query <question>`
- `/知识入库`
- `/kb-ingest-start`
- `/kb-ingest-end`

### Contract And Case

- `/合同起草开始`
- `/合同起草结束`
- `/案件录入 <case info>`
- `/案件更新 <update>`
- `/案件待办`
- `/案件提醒`
- `/添加案件提醒 <reminder>`

### Labor Analysis

- `/劳动分析`
- `/劳动分析结束`

Slash commands not owned by the bridge are passed through to OpenCode, for example `/model use ...`, `/model reset`, `/review`, and `/init`.

</details>

## 🧰 Knowledge Base CLI

The local knowledge base provides fast CLI paths:

```bash
npm run --silent kb -- query --question "What is the maximum probation period?"
npm run --silent kb -- ingest file --path "/absolute/path/to/file.pdf"
npm run --silent kb -- ingest url --url "https://example.com/article"
npm run --silent kb -- doctor
```

## ⚙️ Configuration

Use [config.example.json](config.example.json) as the template. Main config sections:

| Section | Purpose |
| :-- | :-- |
| `feishu` | Feishu app, bot identity, WebSocket, card callbacks, and behavior flags |
| `server` | HTTP listen address, health check, and public callback URL |
| `opencode` | OpenCode service URL and working directory |
| `storage` | Session mappings, whitelist, logs, and business state directories |
| `bridge` | Queueing, session mode, timeout, and system state injection |
| `memory` | Long-term memory switches, storage, and sync settings |
| `knowledgeBase` | Knowledge base switches, ingestion, retrieval, local DB, and Bitable settings |
| `contractAssistant` | Contract, case, invoice, and reminder capabilities |
| `laborSkill` | Labor analysis material collection and output settings |

## 🛠️ Development Commands

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run dev
npm run dev:once
```

Current full verification baseline: **52 test files · 371 tests passing**

## 📂 Project Layout

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

## 📚 Documentation

- [Architecture baseline](docs/architecture-baseline.md)
- [New feature checklist](docs/guidelines/new-feature-checklist.md)
- [Feishu Markdown rules](docs/feishu-markdown.md)
- [Deployment](docs/deploy.md)
- [Formatter migration record](docs/archive/design-history/formatter-migration.md)
- [Framework freeze acceptance](docs/archive/qa-and-submission/freeze-acceptance.md)

## 🚢 Deployment

Single-host topology:

```text
Feishu <-> HTTPS / Caddy <-> Bridge HTTP + WebSocket <-> OpenCode Server
```

References:

- [docs/deploy.md](docs/deploy.md)
- [ops/Caddyfile](ops/Caddyfile)
- [.env.example](.env.example)

Health check `GET /healthz` · default card callback path `/webhook/card`

## 🤝 Contributing

The framework has been frozen. Future feature work should follow these rules:

- Prefer adding features inside Runtime Module / Service / Transport seams
- Do not add business-specific branches to `src/runtime/app.ts`, `src/runtime/turn-executor.ts`, or `src/bridge/router.ts` unless the architecture baseline is updated first
- Add new cards through `src/feishu/*-cards.ts` family entrypoints instead of growing `formatter.ts`
- Reuse shared state persistence infrastructure instead of copying timer + JSON persist logic
- Include the [new-feature-checklist](docs/guidelines/new-feature-checklist.md) self-check in PR descriptions

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Clukay-Fun/feishu-opencode-bridge&type=Date)](https://star-history.com/#Clukay-Fun/feishu-opencode-bridge&Date)

## License

[MIT](LICENSE)
