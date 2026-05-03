# 架构基线

> 最后更新：2026-05-03
>
> 这份文档定义了 post-demo 阶段的架构基线。
> 如果它与 demo 导向的说明冲突，以这份文档的代码组织规则为准。

## 目标

框架在 seam 上冻结，功能在 seam 内扩展。

这个仓库正在从“demo 优先的稳定化”转向“框架冻结 + 功能扩展”。

这份基线的目标不是重新设计整个项目。
它的目标是固定那些在后续继续加功能时必须保持稳定的边界。

当前范围刻意保持收敛：

- Feishu 是唯一渠道
- OpenCode 仍然是 bridge 自己维护的唯一运行时后端
- 部署仍然是单机形态
- bridge 仍然是一个 TypeScript 服务，而不是桌面应用，也不是多渠道平台

## 产品定位

这个项目是一个面向 OpenCode 的 Feishu 原生运行时桥接层。

它不是什么：

- 通用 IM bot 框架
- 桌面 AI shell
- 多渠道 agent 平台
- 纯业务工作流应用

它是什么：

- Feishu ingress 与 egress 层
- 具备会话语义的运行时 shell
- 由 bridge 自己管理的命令面与过程控制面
- knowledge、memory 等共享服务模块，以及 contract assistant、labor 等业务扩展的宿主

判定标准：

- 框架能力解决“任何业务都可能需要的问题”，例如知识库基础设施、文件识别、OCR、文档解析、短期上下文、权限、Feishu transport、卡片原语、runtime module 和 workflow 编排。
- 共享服务模块提供可被多个业务复用的 port、factory、检索、上下文或持久化能力，例如 knowledge 和 memory。它们可以有 extension meta 和 runtime extension，但在依赖规则中按 shared service 处理，不参与业务目录反选。
- 业务扩展解决“某个领域才需要的问题”，例如法律判断、劳动争议策略、合同审查口径、发票字段解释、领域 prompt、业务 schema 和业务卡片模板。
- 如果一个能力已经包含 legal、labor、contract、invoice、finance 等领域语义，默认应作为业务扩展挂在框架 seam 上，而不是继续写进 bridge core。

## 基线原则

### 1. 保持 Core 足够小

`core` 只负责运行时机制。

它可以知道：

- 消息 ingress 和 egress
- session window
- queueing
- turn 生命周期
- process card 和 final reply
- permission 与 question 交互
- bridge 自己的命令面

它不应继续长出更多业务分支。

### 2. 只做 Feishu，但不要变成 Feishu 意大利面

我们不需要一个通用多渠道抽象。
但我们需要一个干净的 Feishu transport 边界。

这意味着所有 Feishu 相关的投递细节，都应收敛到稳定的 transport 风格 API 后面，而不是在每个模块里重复实现。

### 3. 业务逻辑放在 Modules 和 Services

业务模块可以拥有：

- 自己命名空间内的命令解释
- pending interaction
- feature 自己的状态持久化
- prompt overlay
- 自己 services 和 workflows 的编排

业务模块不能接管 bridge 的 session control。

### 4. 扩展必须复用既有 Seam

新功能应接入：

- `RuntimeModule.handleMessage()`
- `RuntimeModule.beforeTurn()`
- `RuntimeModule.afterTurn()`
- service / workflow helpers
- dedicated stores

新功能不应通过临时 hooks 继续膨胀 core。

### 5. 内置业务扩展由 data-only meta 与 runtime extension 装配

Bridge 可以装配业务模块，但不应直接在 core 文件里手写业务模块分支。

内置业务扩展拆成两个 internal 入口：

- `extension.meta.ts`：data-only 声明，只放 id、configKey、commands、configDefinition、cardTemplates 和 workflows。
- `extension.ts`：runtime 创建入口，只负责 createModule，可以加载 service 与 RuntimeModule。

本期选择稳妥同步装配。
新增内置扩展需要在 `src/extensions/builtin-meta.ts` 和 `src/extensions/builtin.ts` 各登记一行。
这不是运行时热拔插，也不是第三方 plugin API。

data-only meta 可声明启动期聚合信息：

- `id`
- `configKey`
- `commands`
- `configDefinition`
- `cardTemplates`
- `workflows`

runtime extension 只负责 `createModule()`。
它复用 meta 的 `id`、`configKey` 和 `commands`，避免字符串漂移。

这些内置扩展契约只服务仓库内模块。
它们不支持 runtime unregister、reload 或第三方稳定 API。
启动期目录扫描和外部依赖只允许走下一节定义的 `extension-api` 受限外部扩展路径。

`id` 与 `configKey` 必须显式声明映射，不能靠命名约定猜：

- `knowledge-base` -> `knowledgeBase`
- `contract-assistant` -> `contractAssistant`
- `labor-skill` -> `laborSkill`

其中 `knowledge-base` 和 `memory` 虽然也有 meta / runtime extension 文件，但当前分类是 shared service module。
dep-cruiser 的业务目录反选规则不会把它们当作普通业务扩展处理。
原因是 `KnowledgeBasePort` 和 memory 上下文会被多个 runtime module 消费，跨模块协作应通过 port / runtime assembly 注入，而不是把 shared service 硬塞回业务桶。
知识库实现类仍有专门规则兜底：runtime / bridge 不得直接 import `KnowledgeBaseService`。

`commands` 本期只用于文档、冲突检测和未来 help 展示。
它不参与通用 router 分发。
core router 只处理 bridge / framework 命令；业务命令继续由 RuntimeModule 基于 passthrough 或既有 routed command 认领。
`/cost` 属于 framework 级可观测命令，只读取本地 usage ledger，不进入业务模块或 OpenCode passthrough。

业务实现类应在自己的模块命名空间内构造。
runtime / bridge 只依赖 runtime extension、factory、RuntimeModule seam 或业务 port 类型。
配置层只依赖 `extensions/builtin-meta.ts` 和模块 `config.ts` 的类型/定义，不得通过配置入口加载业务 runtime/service。
业务卡片模板通过 meta 聚合，模板 registry 不加载 runtime extension。

### 6. 外部扩展只能依赖 extension-api

L2 动态加载的前置契约是 `src/extension-api/`。
这是未来外部扩展唯一允许 import 的框架入口。

`extension-api` 暴露：

- extension / meta 声明 helper
- RuntimeModule 的公共接口
- outbound、opencode、knowledge、logger 等最小 port
- 只读 message / session window view
- 业务卡片模板纯类型

`extension-api` 不暴露：

- `FeishuTransport`
- `WhitelistStore`
- `SessionWindowRecord`
- `BridgeApp`
- `saveSessionWindow()` / `createAndBindSession()` 等 session mutation API
- 业务 service 实现类

这仍然不是 L3 热拔插，也不是沙箱。
扩展是受信代码；进程运行中新增、卸载、reload 仍是非目标。

Phase 2 起，`ModuleConfigDefinition` 与 `ConfigLoadContext` 纳入 `extension-api` 公共契约。
`ConfigLoadContext` 字段集继续冻结：`baseDir`、`dataDir`、`resolveRelative()`、`resolvedEmbeddingProvider?`。
新增字段视为 breaking change，需要架构 review。

启动期外部扩展加载器会扫描 `${BRIDGE_EXTENSIONS_DIR}` 或 `${BRIDGE_HOME:-.}/extensions`。
加载失败的扩展会被跳过并记录 warning；不会阻止 bridge 核心启动。
外部扩展 runtime module 通过 adapter 接入内部 `RuntimeModule` seam，只能看到 public context。

Phase 3 起，外部扩展 manifest 可声明 `devMeta` 和 `devRuntime`。
默认生产启动仍加载 `meta` / `runtime` 指向的构建产物。
只有设置 `BRIDGE_EXTENSIONS_DEV=1` 或测试显式开启 source mode 时，loader 才会优先加载 dev source 入口。
生产环境会忽略单独的 `BRIDGE_EXTENSIONS_DEV=1`，避免误 import `.ts` 源码。
如果确实要在生产强制加载 dev source，需要同时设置 `BRIDGE_ALLOW_DEV_IN_PROD=1`，该模式只用于临时排障。
TypeScript 源码入口只适用于 `tsx` 启动的开发模式；正式部署仍要求扩展自己构建到 `dist/`。
外部扩展可以带自己的 `package.json` 和 `node_modules`。
带依赖的外部扩展必须自行构建和安装依赖，不能假设 bridge 主仓库会提供这些包。
扩展目录缺少 `package.json` 时会被拒载。
`dependencies` 中声明的运行时依赖必须解析到扩展目录内，不能向上泄漏到 bridge 根目录或其它祖先目录的 `node_modules`。

当前强制试点：

- `knowledge` 的 `KnowledgeBaseService` 只能在 `src/knowledge/` 内构造
- `src/runtime/` 和 `src/bridge/` 只能 type-import `KnowledgeBasePort`
- 本地知识库 CLI 与 Bridge runtime 复用同一套 knowledge factory

## 目标分层边界

```text
Feishu Transport
  -> Core Runtime
    -> Runtime Modules
      -> Domain Services / Workflows
        -> Stores / External APIs / Local Tools
```

### 1. Feishu Transport

当前实现分散在：

- `src/feishu/api.ts`
- `src/feishu/ws.ts`
- `src/feishu/formatter.ts`
- `src/http/server.ts` 的一部分
- `src/runtime/app.ts` 的一部分

稳定职责：

- 解析 Feishu 入站消息与附件
- 发送与更新消息和卡片
- 归一化 callback 输入
- 处理 Feishu markdown 与 card payload 规则
- 封装 reply 与 thread reply 等投递细节
- 通过共享 logger pipeline，以稳定 scope 命名和 observability event schema 输出日志与 transcript

不应负责：

- 业务命令语义
- session 切换逻辑
- knowledge / contract / labor 决策
- 自定义 log sink 或 feature 专属 transcript store

目标方向：

- 把重复的 `sendPayload` / `updatePayload` / notice-card 流程收敛到稳定的 Feishu transport helper 层

### 2. Core Runtime

当前主要实现位置：

- `src/runtime/app.ts`
- `src/runtime/command-handler.ts`
- `src/runtime/turn-executor.ts`
- `src/runtime/permission-manager.ts`
- `src/runtime/session-windows.ts`
- `src/bridge/*`

稳定职责：

- 把入站消息路由到 command、pending interaction、module chain 或默认 turn flow
- 维护通用 `file-await-instruction` 挂起状态，并在兜底处理前按模块顺序询问是否接管
- 对未被模块接管的普通文件或图片上传，core 可以直接创建默认识别 turn；图片资源以 OpenCode `image_url` part 透传，文件内容仍以本地临时路径交给 turn
- 管理 bridge 命令面，例如 `/new`、`/sessions`、`/status`、`/close`、`/delete`、`/guide`、`/cost`
- 管理 queueing、turn execution、watchdog、process-card 生命周期和 final reply 投递
- 管理 session-window 状态、interaction mode 状态，以及窗口级模型 override
- 使用 observability event schema 输出 turn、permission、cost usage 和 module 生命周期事件

不应负责：

- feature 专属 pending state machine
- feature 专属 ingest queue
- feature 专属 persistence file
- feature 专属 command alias

### 3. Runtime Modules

当前模块：

- `knowledge`
- `contract-assistant`
- `labor`
- `memory`

稳定职责：

- 通过 `RuntimeModule` 认领或忽略消息
- 可通过 `claimFileInstruction()` 接入通用 `file-await-instruction`，把自己的文件后续动作接回模块内
- 通过 `beforeTurn` 注入 system prompt block
- 通过 `afterTurn` 执行 feature 专属 after-turn 工作
- 只持久化自己的状态
- 如果持有 timer、worker、handle 或临时运行时资源，就实现 `stop()`

容错契约：

- 单个模块的 `handleMessage()`、`claimFileInstruction()`、`beforeTurn()` 或 `afterTurn()` 抛错时，ModuleManager 记录 `module.failed` 事件并继续后续模块
- 外部扩展 `createModule()` 抛错时，runtime assembly 跳过该扩展并记录 warning，不阻断 bridge 核心启动
- 模块失败隔离只保护模块链路；模块内部仍应自己处理可恢复的业务错误，并向用户返回清晰 notice

不应负责：

- 直接操纵其他模块的状态
- bridge session 的创建、删除、重命名或切换语义
- 通用 Feishu 投递策略

停止契约：

- `stop()` 之后，不应留下任何自己拥有的 timer、interval、worker、临时资源或后台 handle
- 正确性所需的清理不能推迟到进程退出时再做

### 4. Domain Services 与 Workflows

代表性文件：

- `src/document-pipeline/index.ts`
- `src/knowledge/index.ts`
- `src/contract-assistant/index.ts`
- `src/labor/index.ts`
- `src/workflows/evidence-extract.ts`

稳定职责：

- 纯或近似纯的 feature 逻辑
- 面向领域任务的 OpenCode prompt 组装
- 本地文件与数据转换
- 与该 feature 相关的外部系统交互封装
- 跨 feature 可复用的 shared workflow，例如证据提取、文档解析、时间线整理和工作台生成

通用文件解析约定：

- 常见文件先经 `document-pipeline` 统一转换为 Markdown / 纯文本 / sections
- OCR / 文档解析外部 API 必须显式配置启用；默认不得无感上传用户材料
- 业务模块消费统一解析结果，不直接分叉维护 PDF、DOCX、HTML 等专项入口
- Python 侧新调用优先走 `scripts/python/convert_document.py`，旧专项脚本保留为兼容后端

领域能力拆分约定：

- `labor-skill` 是劳动争议领域总入口，负责劳动案件主线 workflow 编排
- `contract-draft`、`contract-extract`、`invoice-recognize`、`case-manage` 等保持独立专项能力，可被 labor 调用，但不并入 labor 私有状态
- `evidence-extract`、`document-pipeline`、`timeline-build`、`workbench-generate` 和 `case-workflow` 属于 shared workflow，承载跨领域材料处理、时间线构建和工作台输出能力，不承担劳动案件策略判断
- 详细边界见 [labor-skill-workflows.md](/Users/clukay/Program/feishu-opencode-bridge/docs/modules/labor-skill-workflows.md)

不应负责：

- 聊天 UI 行为
- pending interaction TTL 管理
- 会话路由

### 5. Stores 与 Scripts

代表性文件：

- `src/store/*`
- `scripts/*`

稳定职责：

- 持久化
- 本地 CLI 入口
- 启动与诊断工具

这些部分不应反向渗透回运行时主流程，成为 feature 编排捷径。

`src/runtime/preflight.ts` 与 `scripts/runtime/checks.mjs` 属于同一诊断面：

- preflight 在启动时作为 runtime gate 运行
- doctor、guide 与 checks 独立运行，不进入 runtime handler chain

### 6. Configuration

代表性文件：

- `src/config/schema.ts`
- `src/config/loader.ts`

稳定职责：

- 定义共享配置 schema 与跨字段校验
- 将路径、URL、默认值和兼容性 fallback 解析为可直接给运行时使用的 config 对象
- 作为 core、modules 与 scripts 的唯一配置入口
- 通过内置静态 module config registry 组合模块子配置

不应负责：

- 运行时状态
- feature interaction state
- 每个 feature 各自维护的 ad-hoc config 加载路径
- 模块之间的横向配置依赖

规则：

- 所有 feature 配置都必须经过共享 schema 和 loader
- modules 只能消费注入进来的 config；不能直接读 `config.json`，也不能维护并行的 feature config 文件
- 模块配置不互相读取；跨模块运行时依赖留在 runtime module assembly 中注入
- 共享已解析值必须由中央 loader 在任何模块 normalize 前写入 `ConfigLoadContext`
- 模块 normalize 之间没有顺序依赖；如果某个模块需要另一个模块的解析值，默认拒绝，除非先把该值升级为 `ConfigLoadContext` 字段并经过架构 review
- `ConfigLoadContext` 字段集本期冻结为 `baseDir`、`dataDir`、`resolveRelative` 和 `resolvedEmbeddingProvider`
- module config registry 只供内置模块静态注册；不是第三方 plugin 公共 API
- config 层只能 import 业务模块的 `config.ts`，不得 import 业务实现、runtime module 或模块 index

当前状态：

- `knowledgeBase`、`contractAssistant` 和 `laborSkill` 已下沉到模块 config registry
- `memory` 仍保留在中央 `schema.ts` / `loader.ts`，后续可按同模式迁移
- 后续迁移步骤固定为：创建 `<module>/config.ts`，导出 module config definition，加入静态 registry，删除中央 schema / loader 旧块，补兼容快照与模块配置测试

### 7. Logging 与 Observability

代表性文件：

- `src/logging/logger.ts`
- `src/runtime/*` 与 feature modules 中的 transcript 和 payload logging 调用点

稳定职责：

- 为 runtime、transport 与 modules 提供共享日志与 transcript pipeline
- 强制使用一致的 scope 命名，让日志在跨 feature 查询时仍然可用

规则：

- features 只能通过共享 logger 打日志
- log scope 应遵循 `area/subject` 风格，例如 `bridge/app`、`knowledge/sync`、`contract-assistant/state`
- features 不能引入独立 log sink、sidecar log file 或 ad-hoc transcript store

## 固定扩展 Seam

这些是系统首选的扩展位置。

### 新的 Runtime Capability

使用新的 `RuntimeModule`。

适合：

- 需要自己命令面的功能
- 需要 pending interaction state 的功能
- 需要 prompt overlay 或 after-turn hook 的功能

不适合：

- 单个 helper 函数
- 一次性的格式化微调

### 新的业务逻辑

使用 service 或 workflow helper。

适合：

- parsing、extraction、normalization、rendering、syncing

不适合：

- 直接把逻辑内联写进 `app.ts` 或 `turn-executor.ts`

### 新的持久化

使用 dedicated store 或 module 自己的 state file。

规则：

- 一份状态只能属于一个明确的 feature owner

### 新的 Prompt Rule

使用：

- bridge 级 system prompt 仅承载 bridge runtime 规则
- module `beforeTurn()` 承载 feature overlay

规则：

- prompt 增量必须是分层叠加的，不能在互不相关的文件里 ad hoc 追加

## 必须停止继续增长的部分

下面这些增长路径现在明确禁止继续扩张。

### 1. Core 里新增业务分支

不要因为方便，就继续在 core runtime 里加 feature 专属 `if` 分支。

不好的方向示例：

- core 学会 feature 专属 ingest mode
- core 存 feature 专属 pending interaction
- core 针对某个模块的命令或输出做 special-case

### 2. 原始投递逻辑散落在各个模块里

模块不应各自重新发明：

- notice-card 投递
- processing-card 切换
- reply threading 策略
- payload logging metadata

当前代码库这里仍然有重复。
新代码必须减少这种重复，而不是继续复制。

### 3. 命令别名爆炸

每新增一个 alias，都会增加：

- parser 复杂度
- test matrix 大小
- 文档成本

规则：

- 每个 feature action 保留一个主命令名
- 只有在确有必要时，最多再保留一个兼容 alias

### 4. 生产路径里残留 Demo 专属行为

demo 文案、demo 捷径、半连通命令，不应继续留在活跃产品路径里。

如果某个命令并未真正支持，只能二选一：

- 把它做完
- 把它移除或隐藏

不要继续扩大“能识别但没实现”的表面。
任何“能识别但没实现”的命令，都必须在下一条 major feature PR 落地前被完成、隐藏或移除。

### 5. 跨 Feature 的状态耦合

任何 feature 都不能直接持久化或修改其他 feature 的内部状态文件或内存交互状态。

## 执行方式

reviewer 应拒绝违反这些规则的 PR。
如果某处违规确实无法避免，应先更新这份 baseline，再继续推进。
feature PR 也应同时经过 [new-feature-checklist.md](/Users/clukay/Program/feishu-opencode-bridge/docs/guidelines/new-feature-checklist.md)。
freeze 之后仍然活跃的后续债务集中在 [post-freeze-backlog.md](/Users/clukay/Program/feishu-opencode-bridge/docs/backlog/post-freeze-backlog.md)。

## 当前会阻碍干净扩展的债务

这些是 major feature growth 之前最值得先处理的债务。

### P1. Core 仍然保留少量模块资源适配

具体业务模块已经通过 internal extension manifest 装配。
剩余耦合主要是 BridgeApp 仍要为资源型模块适配完整 outbound resource port，以及 `memory` 配置尚未下沉到 module config registry。

近期规则：

- 任何新功能都不应迫使 `BridgeApp` 在 stable deps 之外继续长出更多 feature 专属资源适配
- 新业务模块应通过 extension manifest 接入，而不是让 `runtime-modules.ts` 手写模块分支

### P1. 普通文件处理仍然泄漏临时文件

普通上传文件会为了 OpenCode turn 被写到临时目录。
这些路径在 turn 完成后还没有被清理。

在文件密集型功能继续扩张之前，这个问题应先修掉。

### P1. Module 状态持久化仍在按 Feature 复制实现

contract assistant 和 labor 目前都维护了相似模式：

- restore
- TTL timers
- persist chain
- flush

这应成为共享基础设施，而不是继续复制。

### P2. 输出构造正在变成新的单体

`src/feishu/formatter.ts` 已经大到足以成为下一个结构瓶颈。

目标拆分应该按 view family，而不是按随意 helper 拆。
拆分应分两层：

- shared post 与 notice primitives
- 面向 feature 的 card families，在这些 primitives 之上构建

当前进一步收口方向：

- `shared-primitives.ts` 只保留 Feishu payload 拼装与通用卡片块 helper
- `runtime-cards.ts` 保留 bridge 自有运行时 / 会话 / 权限卡片
- 业务展示卡默认通过 `business template runtime + family adapter` 接入
- `src/feishu/templates/*` 只承载模板运行时、注册表和纯类型契约；具体业务模板定义应留在业务模块侧
- `BusinessCardBlock.kind` 统一使用小写驼峰命名，例如 `tagChart`、`stepList`、`elapsed`；不要在不同 PR 中混用短横线、下划线或同义别名

建议方向：

- runtime cards
- session cards
- knowledge cards
- contract cards
- labor cards
- business template runtime
- business template adapters

业务卡片模板归属：

- 模板定义应由业务扩展声明
- 模板 runtime 只负责 schema 校验与 spec 渲染
- registry 可聚合内置扩展声明的模板，但不得加载业务 runtime module 形成循环依赖
- 重复 template id 必须启动时报错
- shared post / notice primitives

### P2. Turn Execution 过于密集

`TurnExecutor.executeTurn()` 仍然是当前代码库里最难读的逻辑路径。

在继续新增运行时行为之前，应按职责拆分：

- stream session setup
- event accumulation
- permission 与 question 处理
- fallback resolution
- finalize 与 cleanup

### P2. Command Parsing 需要走向 Registry

`src/bridge/router.ts` 当前仍把很多规则直接写死在文件里。
现在还勉强可控，但不能继续线性膨胀下去。

不要过早重写它。
但命令面继续增长时，应把它当成走向 registry 的信号。

## 删除与归档方向

下面这些清理方向本身就是基线的一部分。

### Archive

- 只服务 demo 的计划与脚本材料
- 一次性的提交与验收说明
- 过期的规模与指标快照

建议归档到：

- `docs/archive/`

归档文档是只读快照，不应直接在原地继续编辑。

### Remove or Consolidate

- 只包装单一 CLI 入口的薄 wrapper 脚本
- 兼容窗口结束后的过时命令别名
- 能识别但实际上未实现的 feature surface

## “Framework Freeze” 的完成定义

只有当下面这些条件全部满足时，才能认为框架已经冻结到足够支撑扩展：

- 新增一个 feature 不需要把业务逻辑重新加回 `core`
- 新增一个 feature 不需要复制另一个模块的状态持久化模式
- 新增一个 feature 不需要重复写原始 Feishu 投递代码
- prompt 增量能明确落在某个已知层里，而不是到处乱加
- 不支持的命令会被移除，而不是模糊承认它存在

这个 DoD 应通过一次真实功能接入来验证：检查上述规则是否有任何一条被打破。
如果真实功能仍然无法干净地落在这些 seams 内，说明框架还没有冻结到足够扩展的程度。

## 下一步建议顺序

1. 修复普通上传文件的临时文件清理
2. 抽取共享的 module interaction-state 持久化 helper
3. 收窄 `BridgeApp` 的模块组装面，停止继续扩大 feature 专属依赖
4. 将 `feishu/formatter.ts` 拆成按 feature 划分的 card family 与共享 post / notice primitives
5. 收紧命令面，移除弱 alias
6. 把不再定义产品方向的 demo-first 文档归档

## 与现有文档的关系

- `docs/archive/design-history/runtime-layering.md` 描述了 runtime split 的历史方向
- 本文定义的是更严格的 post-demo 基线与扩展规则
- `docs/archive/` 或 `docs/guidelines/` 下的旧规划文档仍可提供背景，但不能覆盖这份基线
