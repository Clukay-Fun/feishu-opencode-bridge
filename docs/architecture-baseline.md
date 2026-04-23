# 架构基线

> 最后更新：2026-04-18
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
- knowledge、contract assistant、labor、memory 等业务模块的宿主

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
- 管理 bridge 命令面，例如 `/new`、`/sessions`、`/status`、`/close`、`/delete`
- 管理 queueing、turn execution、watchdog、process-card 生命周期和 final reply 投递
- 管理 session-window 状态与 interaction mode 状态
- 使用 observability event schema 输出 turn、permission 和 module 生命周期事件

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
- 业务模块消费统一解析结果，不直接分叉维护 PDF、DOCX、HTML 等专项入口
- Python 侧新调用优先走 `scripts/python/convert_document.py`，旧专项脚本保留为兼容后端

领域能力拆分约定：

- `labor-skill` 是劳动争议领域总入口，负责劳动案件主线 workflow 编排
- `contract-draft`、`contract-extract`、`invoice-recognize`、`case-manage` 等保持独立专项能力，可被 labor 调用，但不并入 labor 私有状态
- `evidence-extract` 和 `document-pipeline` 属于 shared workflow，承载跨领域材料处理能力，不承担劳动案件策略判断
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
- doctor 与 checks 独立运行，不进入 runtime handler chain

### 6. Configuration

代表性文件：

- `src/config/schema.ts`
- `src/config/loader.ts`

稳定职责：

- 定义共享配置 schema 与跨字段校验
- 将路径、URL、默认值和兼容性 fallback 解析为可直接给运行时使用的 config 对象
- 作为 core、modules 与 scripts 的唯一配置入口

不应负责：

- 运行时状态
- feature interaction state
- 每个 feature 各自维护的 ad-hoc config 加载路径

规则：

- 所有 feature 配置都必须经过共享 schema 和 loader
- modules 只能消费注入进来的 config；不能直接读 `config.json`，也不能维护并行的 feature config 文件

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

### P1. Core 仍然知道太多具体模块细节

`BridgeApp` 仍然直接构造和组装具体模块。
这在当前阶段还能接受，但依赖面不应继续扩大。

近期规则：

- 任何新功能都不应迫使 `BridgeApp` 在 module registration 与 stable deps 之外继续长出更多 feature 专属行为

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
- `src/feishu/templates/*` 只承载业务模板注册、schema 校验与薄 spec 渲染，不直接暴露给 runtime 或业务模块
- `BusinessCardBlock.kind` 统一使用小写驼峰命名，例如 `tagChart`、`stepList`、`elapsed`；不要在不同 PR 中混用短横线、下划线或同义别名

建议方向：

- runtime cards
- session cards
- knowledge cards
- contract cards
- labor cards
- business template runtime
- business template adapters
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
