# 内置业务扩展开发规范

本文约束仓库内置业务扩展的开发方式。目标是让新增业务能力挂在现有 framework seam 上，而不是继续把领域逻辑并回 bridge core。

本规范以仓库内置扩展为主，同时记录 L2 启动期外部扩展的前置契约。
这仍然不是 L3 第三方插件平台，不支持运行时热拔插或沙箱隔离。

## 当前分离状态

当前项目已经进入“启动期可配置的内部扩展包 + 受限外部扩展加载前置”阶段。

- `src/extensions/*` 负责聚合内置 extension manifest、命令声明和业务卡片模板。
- `src/<module>/extension.meta.ts` 负责声明模块 id、configKey、commands、configDefinition、cardTemplates 和 workflows。
- `src/<module>/extension.ts` 只负责 runtime `createModule()`，可以加载 service 和 RuntimeModule。
- `src/<module>/config.ts` 负责模块自己的配置 schema、校验和 normalize。
- `src/runtime/runtime-modules.ts` 通过内置 extension 列表装配 RuntimeModule，不再逐个手写 contract/labor 业务分支。

但这还不是完全外部化插件系统。

- 扩展仍然随仓库代码一起编译和发布。
- 新增内置扩展仍需要在 `src/extensions/builtin-meta.ts` 和 `src/extensions/builtin.ts` 各登记一行。
- 内置扩展仍采用稳妥同步装配，不为了“一处登记”引入异步注册链。
- 不支持进程运行中新增、卸载、reload 扩展。
- 外部扩展只冻结 `src/extension-api/` 这一层受限契约；还不承诺完整第三方插件生态。

## 分层判断

框架能力解决“任何业务都可能需要的问题”。

典型框架能力：

- 飞书 ingress / egress
- 会话窗口、队列、turn 生命周期
- 权限确认、问题确认、process card、final reply
- 文件下载、文件识别、OCR、文档解析
- 知识库基础设施与检索管线
- 短期消息上下文
- 通用卡片原语
- RuntimeModule seam
- shared workflow 编排能力

共享服务模块提供可被多个业务复用的 port、factory、检索、上下文或持久化能力。

当前共享服务模块：

- `knowledge`：提供 KnowledgeBasePort、知识库 factory、检索和文档处理复用点。
- `memory`：提供共享记忆上下文和运行时记忆服务。

共享服务模块可以有 `extension.meta.ts` 和 `extension.ts`，但在 dep-cruiser 的业务目录反选里不按普通业务扩展处理。
普通业务扩展需要这些能力时，应通过 port 或 runtime assembly 注入，不要直接读取共享服务内部状态。

业务扩展解决“某个领域才需要的问题”。

典型业务扩展：

- 法律判断
- 劳动争议策略
- 合同审查口径
- 发票字段解释
- 领域 prompt
- 业务 schema
- 业务卡片模板
- 业务专属外部系统映射

如果一个能力包含 legal、labor、contract、invoice、finance 等领域语义，默认应作为业务扩展实现。

## 新增内置扩展流程

新增业务能力时，优先创建一个模块目录。

推荐结构：

```text
src/<module>/
  config.ts
  extension.meta.ts
  extension.ts
  runtime-module.ts
  index.ts
  prompts.ts
  card-templates.ts
```

必要步骤：

1. 在 `src/<module>/config.ts` 定义模块配置。
2. 在 `src/<module>/extension.meta.ts` 声明 data-only meta，并挂上 `configDefinition`。
3. 在 `src/extensions/builtin-meta.ts` 注册 meta。
4. 在 `src/<module>/extension.ts` 定义 runtime extension，并复用 meta 的 `id`、`configKey` 和 `commands`。
5. 在 `src/extensions/builtin.ts` 注册 runtime extension。
6. 如果有业务卡片模板，在模块目录内定义模板，并通过 `extension.meta.ts` 的 `cardTemplates` 注册。
7. 如果有模块设计背景，在 `docs/modules/` 增加或更新模块说明。
8. 如果新增或改变 seam，在同一 PR 更新 `docs/architecture-baseline.md`。

## Extension Meta 与 Runtime Extension 规则

每个内置扩展必须有稳定 id。

```ts
export const exampleExtensionMeta: BuiltinExtensionMetaDefinition = {
  id: "example-domain",
  configKey: "exampleDomain",
  commands: [],
  configDefinition: exampleDomainConfigDefinition,
};

export const exampleExtension: BuiltinExtensionDefinition = {
  id: exampleExtensionMeta.id,
  configKey: exampleExtensionMeta.configKey,
  commands: exampleExtensionMeta.commands,
  createModule: (context) => new ExampleRuntimeModule(...),
};
```

规则：

- `id` 使用 kebab-case，创建后不要随意改名。
- `configKey` 必须显式声明，不允许从 id 猜配置块名称。
- `extension.meta.ts` 必须保持 data-only，不得 import `runtime-module.ts`、模块 `index.ts`、service 实现或 `src/runtime/**`。
- `extension.ts` 负责 runtime 装配，可以 import service 和 RuntimeModule，但不应声明业务卡片模板。
- `src/config/modules.ts` 只从 `src/extensions/builtin-meta.ts` 派生配置 registry，不直接 import 业务模块。
- `src/feishu/templates/registry.ts` 只通过 meta 聚合业务卡片模板，不加载 runtime extension。
- `commands` 只用于文档、冲突检测和未来 help 展示。
- `commands` 不是通用命令分发器。
- `createModule()` 应只做模块装配，不承载业务流程主体。
- 未启用业务服务时，RuntimeModule 可以仍被注册，但必须给出清晰的“未启用”提示。
- 模块需要其他模块能力时，通过 runtime assembly 注入 port，不允许配置层互相读取。

## Public Extension API 规则

`src/extension-api/` 是 L2 动态加载前置的公共契约面。
未来外部扩展只能从这里 import 类型与 helper。

当前 `extension-api` 仍是实验性能力：API 不稳定，扩展是受信代码加载，不提供沙箱隔离、第三方兼容承诺或运行时热拔插。推广期不建议把它包装成面向普通用户的插件生态；新增外部扩展前应审查源码、依赖和数据外发行为。

允许使用：

- `defineExtension()` / `defineCardTemplate()`
- `ExtensionDefinition` / `ExtensionMetaDefinition`
- `ExtensionRuntimeModule` / `ExtensionRuntimeContext`
- outbound、opencode、knowledge、logger 等公共 port
- 只读 message / session window view
- 业务卡片模板纯类型

禁止外部扩展直接 import：

- `src/runtime/**`
- `src/bridge/**`
- `src/feishu/**`
- `src/store/**`
- 业务模块实现文件

`extension-api` 不代表热拔插或沙箱。
扩展仍是受信代码，配置变更和扩展版本变更仍需要重启。

Phase 2 起，外部扩展可以通过 `ExtensionMetaDefinition.configDefinition` 声明自己的配置块。
配置数据位于 `config.json` 的 `extensions` 对象下，例如 `extensions["demo-extension"]`。
`ModuleConfigDefinition` 和 `ConfigLoadContext` 已纳入公共 API；`ConfigLoadContext` 字段集冻结，新增字段需要架构 review。

外部 runtime module 由 adapter 接入内部 `RuntimeModule` seam。
adapter 会把内部消息、pending、turn、window 映射成 public view。
外部模块不会拿到 `transport`、`whitelist`、`saveSessionWindow()` 或 `createAndBindSession()`。

## 外部扩展开发模式

外部扩展属于 L2 启动期动态加载。
它们可以免 bridge rebuild 挂载，但仍需要重启 bridge 才会生效。

目录约定：

```text
extensions/<extension-id>/
  manifest.json
  package.json
  src/
    meta.ts
    runtime.ts
  dist/
    meta.js
    runtime.js
```

manifest 示例：

```json
{
  "id": "hello-world",
  "version": "0.0.0",
  "meta": "dist/meta.js",
  "runtime": "dist/runtime.js",
  "devMeta": "src/meta.ts",
  "devRuntime": "src/runtime.ts",
  "dependencies": []
}
```

扩展间依赖建议：

- 扩展间启动顺序依赖推荐写在 manifest 的 `dependencies`。
- `meta.dependencies` 和 `extension.dependencies` 仍会被 loader 兼容读取，但只作为过渡兜底。
- 三处依赖声明如果不一致，loader 会合并去重；为了便于排错，新扩展不要把依赖分散写在多处。

加载规则：

- 每个外部扩展都必须是一个 npm package，扩展目录必须包含 `package.json`。
- `package.json.name` / `package.json.version` 与 manifest `id` / `version` 不一致时会产生启动 warning。
- 默认加载 `meta` 和 `runtime`，也就是扩展自己的构建产物。
- 设置 `BRIDGE_EXTENSIONS_DEV=1` 时优先加载 `devMeta` 和 `devRuntime`。
- `NODE_ENV=production` 时会忽略单独的 `BRIDGE_EXTENSIONS_DEV=1`，并回落到 `dist/`。
- 如需生产临时排障加载 dev source，必须同时设置 `BRIDGE_ALLOW_DEV_IN_PROD=1`。
- TypeScript 源码入口只适用于 `npm run dev:once` / `npm run dev` 这类 tsx 启动模式。
- `npm start` 使用 Node 运行构建产物，外部扩展也应先自己 build 到 `dist/`。
- `createModule()` 必须同步返回；数据库连接、HTTP 探活等异步初始化放到 module `start()`。

扩展发现路径：

- 优先使用 `BRIDGE_EXTENSIONS_DIR` 指向的目录。
- 否则使用 `${BRIDGE_HOME:-.}/extensions`。
- 单个扩展加载失败只会记录 warning，不阻止 bridge 核心启动。

仓库内的最小示例位于 `examples/extensions/hello-world/`。
这个示例同时提供 `dist/*.js` 和 `src/*.ts`，用于验证生产加载与 dev source 加载两条路径。

依赖规则：

- 外部扩展允许带自己的 `package.json` 和 `node_modules`。
- 带依赖的扩展应在扩展目录内安装依赖并把运行产物构建到 `dist/`。
- 扩展自己的 `package.json` 建议声明 `"type": "module"`，确保 ESM import 行为稳定。
- 外部扩展不得假设 bridge 主仓库已经安装了它需要的 npm 包。
- 如果扩展依赖 `yaml`、`js-yaml`、SDK 等第三方包，应把它们声明在扩展自己的 dependencies 中。
- loader 会校验 `dependencies` 中的包是否解析到扩展目录内；如果解析到 bridge 根目录或其它祖先目录的 `node_modules`，该扩展会被拒载并给出依赖泄漏 warning。
- 本期不做共享依赖优化，也不做 hoist；多个扩展依赖同一个包时，各自安装一份。

本地工具：

- `npm run ext:install -- <path-or-tarball>`：安装本地扩展目录或 `.tgz`，并在目标扩展目录执行 `npm install --omit=dev`。
- `npm run ext:list`：列出 `${BRIDGE_EXTENSIONS_DIR}` 或 `${BRIDGE_HOME:-.}/extensions` 下已安装扩展。
- `npm run ext:remove -- <id>`：删除整个已安装扩展目录。
- `npm run ext:pack -- <src-dir>`：对扩展源码目录执行 `npm pack`，输出本地 `.tgz`。
- 工具不支持 `npm run ext:install -- <package-name>`，不会连接 npm registry。

## 命令归属

core router 只处理 bridge / framework 命令。

可以留在 core router 的命令：

- `/new`
- `/sessions`
- `/switch`
- `/status`
- `/models`
- `/model use`
- `/model reset`
- `/allow`
- `/deny`
- `/kb-query`
- `/知识入库`
- `/知识入库结束`

应归业务扩展处理的命令：

- `/法律咨询`
- `/法律咨询开始`
- `/法律咨询结束`
- `/案件工作台`
- `/完成上传`
- `/合同录入`
- `/识别发票`
- `/合同起草开始`
- `/案件录入`

新增业务命令不得直接写入 `src/bridge/router.ts`，除非它是 framework 级入口，并且架构基线同步说明原因。

## 配置规则

模块配置必须靠近模块维护。

推荐用户配置入口是 `extensions["extension-id"]`。
legacy 顶层字段仍永久兼容，运行时输出形状也保持不变。

| 用户配置入口 | 运行时输出字段 |
| :-- | :-- |
| `extensions["knowledge-base"]` | `config.knowledgeBase` |
| `extensions["contract-assistant"]` | `config.contractAssistant` |
| `extensions["labor-skill"]` | `config.laborSkill` |

当 namespace 与 legacy 顶层字段同时出现时，namespace 配置胜出，loader 会返回 `extension-config-overrides-legacy` warning。
未知 namespace id 会保留在 `config.extensions`，供外部扩展使用。

要求：

- schema、默认值、校验和 normalize 放在 `src/<module>/config.ts`。
- `src/<module>/extension.meta.ts` 引用自己的 configDefinition。
- `src/config/modules.ts` 只 import `src/extensions/builtin-meta.ts`。
- `src/config/schema.ts` 和 `src/config/loader.ts` 只组合模块配置结果。
- 模块代码只能消费注入后的 `AppConfig`，不能直接读取 `config.json`。
- 不新增平行配置文件，除非它是明确的业务模板、prompt 或用户数据，并在模块文档里说明。

## RuntimeModule 规则

业务运行时必须通过 `RuntimeModule` 接入。

允许使用的入口：

- `handleMessage()`
- `claimFileInstruction()`
- `beforeTurn()`
- `afterTurn()`
- `start()`
- `stop()`

要求：

- 业务模块不能接管 bridge session creation、switch、rename、delete 语义。
- pending interaction 应使用共享持久化基础设施，不要复制 timer + JSON store 模式。
- 模块持有 timer、worker、临时文件、外部连接时，必须在 `stop()` 清理。
- 模块日志应使用稳定 scope 和 observability event schema，不要发散出临时事件名。

## 文件与知识库规则

文件解析属于 framework 能力，业务模块应复用统一管线。

要求：

- PDF、DOCX、TXT/MD、HTML、图片和 OCR 解析优先走 `src/document-pipeline/`。
- 知识库摄入、检索和远端同步优先走 knowledge port / service。
- 业务模块可以定义领域 prompt、抽取 schema 和结果解释，但不应私自维护另一套文件解析管线。
- 劳动、合同、发票等业务可以调用知识库，但不能直接读取 knowledge 内部数据库或配置。

## 卡片模板规则

通用卡片能力属于 framework，业务展示属于扩展。

要求：

- 通用组件放在 `shared-primitives`、`runtime-cards` 或 card builder 层。
- 业务卡片模板放在业务模块目录，例如 `src/labor/card-templates.ts`。
- 业务卡片模板通过 `extension.meta.ts` 的 `cardTemplates` 声明。
- 模板 id 必须全局唯一，重复 id 应在启动期报错。
- 业务模块不要直接拼低层飞书 JSON，优先使用业务模板和共享原语。
- runtime core 不应知道某个业务卡片的字段细节。

## 禁止事项

新增业务扩展时禁止：

- 在 `src/runtime/app.ts` 增加业务专属 `if` 分支。
- 在 `src/runtime/turn-executor.ts` 增加领域 prompt 或业务策略。
- 在 `src/bridge/router.ts` 增加非 framework 级业务命令。
- 在 `src/config/schema.ts` 继续堆新业务配置细节。
- 在业务模块里直接调用飞书 SDK 裸方法。
- 在业务模块里直接读取或写入其他模块的内部状态文件。
- 把领域 prompt 写进 framework 文档解析、transport 或 core session 逻辑。

## 验收清单

开发者提交业务扩展前，应确认：

- 新能力可以在关闭配置时不影响 bridge 启动。
- 新能力不要求修改 core runtime 主链路。
- 命令已在 extension manifest 中声明。
- meta 已在 `src/extensions/builtin-meta.ts` 登记，runtime extension 已在 `src/extensions/builtin.ts` 登记。
- 配置已放入模块自己的 `config.ts`，并通过 `extension.meta.ts` 的 `configDefinition` 接入。
- 文件解析复用了 document pipeline。
- 卡片展示复用了业务模板或共享原语。
- 模块 stop 能清理自身资源。
- 文档已说明该扩展的入口、配置和非目标。

建议验证：

```bash
npm run typecheck
npm run lint -- --max-warnings=0
npm run lint:deps
npm run check:formatter-exports
npm run check:docs-diff
```

如果涉及真实飞书交互，还应补充飞书真机验收样例。
