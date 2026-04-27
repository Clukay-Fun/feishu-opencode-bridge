# 新功能自检清单

每个 framework freeze 之后的新功能 PR 都应使用这份清单自检。

## 自动覆盖

以下检查项已经由 CI 自动兜底：

- `core` 边界：`npm run lint:deps` 会阻止 `src/runtime/app.ts`、`src/runtime/turn-executor.ts` 和 `src/bridge/router.ts` 在运行时直接导入业务模块；仅类型引用的 seam 仍允许存在。
- `transport` 边界：`npm run lint:deps` 会限制飞书 SDK 的直接导入，只允许出现在 transport 和 ingress 边界文件中。
- `formatter` 边界：`npm run lint:deps` 会阻止新的 runtime 代码直接依赖 `src/feishu/formatter.ts`；`npm run check:formatter-exports` 会把兼容导出面固定在 `docs/archive/design-history/formatter-export-snapshot.json`。
- `config` 边界：`npm run lint` 会拦截 `src` 下除 `src/config/loader.ts` 之外的常见 `config.json` 直接读取方式；`npm run lint:deps` 会阻止 config 层直接加载业务 runtime/service。
- `extension` 边界：`npm run lint:deps` 会阻止 `extension.meta.ts` 加载 RuntimeModule、service、模块 index 或 runtime 层，并用 framework 白名单反选新增业务目录。
- `docs` 边界：`npm run check:docs-diff` 会在 seam 文件变化但未同步修改 `docs/architecture-baseline.md` 时给出 CI 警告。

以下检查项仍然需要 reviewer 判断：

- `module` 边界：虽然会被 core、transport 和 formatter 规则间接覆盖，但 reviewer 仍应确认新能力是通过 `RuntimeModule` 装配 seam 接入的。
- `state` 边界：在共享 persisted interaction 模式拥有专门 lint 规则之前，这一项仍主要依赖 reviewer 判断。
- `extension` 边界：internal extension 已拆成 data-only meta 与 runtime extension；commands 只做声明和冲突检测，不是通用分发器。
- `command` 边界：业务命令声明应进入 extension manifest；实际解析仍由 core router 和对应 RuntimeModule 负责，reviewer 仍需确认没有把业务分发塞回 core。

## 清单

- `core` 边界：功能实现不应把业务分支逻辑重新塞回 `src/runtime/app.ts`、`src/runtime/turn-executor.ts` 或 `src/bridge/router.ts`
- `module` 边界：功能应落在已有 `RuntimeModule` 内部，或通过 runtime module assembly seam 引入新模块
- `extension` 边界：新增内置业务能力应同时提供 `extension.meta.ts` 和 `extension.ts`；需要读取配置时必须显式声明 `configKey`，不要靠 extension id 推断配置块
- `extension registry` 边界：新增内置扩展需要在 `src/extensions/builtin-meta.ts` 和 `src/extensions/builtin.ts` 各登记一行；本期不是动态 plugin，也不是运行时热拔插
- `transport` 边界：飞书消息回复、更新和通知都应经过 `FeishuTransport`；不要新增临时的 send/update 包装层
- `state` 边界：模块级 pending interaction 持久化应复用共享 persisted interaction 基础设施；不要复制 timer + JSON 持久化逻辑
- `command` 边界：每个动作保留一个主命令，最多再保留一个兼容别名
- `formatter` 边界：新卡片应通过 family entrypoints（`shared-primitives`、`runtime-cards`、`knowledge-cards`、`labor-cards`、`contract-cards`）接入；业务展示卡默认走 `business template runtime + family adapter`，业务卡片模板通过 `extension.meta.ts` 注册，runtime 与业务模块不得直接依赖 `src/feishu/templates/*`
- `config` 边界：所有配置变更都应经过共享配置入口；模块子配置优先落在 `<module>/config.ts`，由 `extension.meta.ts` 暴露 `configDefinition` 并通过静态 registry 接入，不要直接读取 `config.json`
- `docs` 边界：如果功能修改了某个 seam，必须在同一个 PR 中同步更新 `docs/architecture-baseline.md`

如果某个功能 PR 违反这份清单，而架构基线又没有先更新，reviewer 应直接拒绝合并。
