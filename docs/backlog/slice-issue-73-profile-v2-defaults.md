# Slice: Issue #73 V2 Profile 默认值机制

## 目标

在 #73 V1（扩展开关，已于 commit `8f459e9` 完成）基础上，落地 V2：

- 配置层增加 `profile` 字段定义
- 实现 `profile → 扩展默认开关` 的 loader 逻辑
- 提供 `general` 和 `legal` 两个 profile 的默认值集合
- 用户可以在 profile 默认值之上单独覆盖扩展开关

**V3（portable 发布包与 Setup UI 接入）不在本 slice，由 #70 和后续 portable 包 slice 承接。**

## 范围

### 包含

- `src/config/schema.ts` 增加 `profile` 字段定义（枚举 `general | legal`，可选，默认 `general`）
- `src/config/loader.ts` 实现 profile defaults 合并：profile 默认值 → 用户覆盖 → 最终运行时配置
- `src/config/modules.ts` 或等价层确认 disabled 扩展不创建 RuntimeModule
- 新增 `config/profiles/general.json` 和 `config/profiles/legal.json` 作为默认值模板（或在 loader 内常量定义，看现有架构选）
- 测试覆盖：
  - `profile=general` 默认关闭法律垂直扩展（knowledge-base、contract-assistant、labor-skill、case-workbench）
  - `profile=legal` 默认启用上述法律扩展
  - 用户覆盖：`profile=general` + 显式开启 `knowledge-base.enabled=true` 时，knowledge-base 被启用
  - 用户覆盖：`profile=legal` + 显式关闭 `contract-assistant.enabled=false` 时，contract-assistant 被禁用
- 更新 `docs/architecture-baseline.md` 在 profile/扩展相关章节加一段说明
- 更新 `docs/deploy.md` 或等价部署文档，说明如何选 profile

### 不包含

- **不做** portable 发布包构建（V3 范畴）
- **不做** 终端 Setup UI（#70）
- **不动** RuntimeModule 装配的 enabled 语义（V1 已完成）
- **不重写** 业务模块（knowledge / contract / labor / case-workbench）任何代码
- **不增加** 新的 profile（只做 `general` 和 `legal`，不做 `enterprise` / `lite` 等）
- **不动** `src/runtime/app.ts`、`src/runtime/turn-executor.ts`、`src/bridge/router.ts` —— 业务分支不写入 core 主流程

### 行为规则

1. **profile 是默认值，不是硬绑定**：用户配置里显式写 `enabled` 的扩展，永远以用户配置为准。profile 只填默认。
2. **legacy 兼容**：当前用户配置可能没有 `profile` 字段。无 `profile` 字段时默认 `general`，且不破坏已有显式 `enabled` 配置。
3. **核心基础能力不受 profile 影响**：基础 runtime、基础卡片、文件/文档能力、记忆能力、外部扩展机制在 general 和 legal 都启用。profile 只影响法律垂直扩展。
4. **memory 启用语义保持现状**：memory 是 shared service，**本 slice 不重新定义 memory 的 enabled 策略**。如果当前 memory 在所有 profile 都默认启用，保持现状。
5. **配置归一化经过 schema/loader/modules**：不在 RuntimeModule 装配点或业务模块内部读 profile。profile 只在 config layer 解析。

## 实现步骤

### 步骤 1：读现状

- 读 `src/config/schema.ts`、`src/config/loader.ts`、`src/config/modules.ts`
- 读 commit `8f459e9` 看 V1 是怎么落的（`gh pr view 73` 或 `git show 8f459e9`）
- 读 `src/extensions/builtin-meta.ts` 和 `src/extensions/builtin.ts`，确认内置扩展清单

### 步骤 2：定义 profile schema

在 `src/config/schema.ts` 加：

```ts
profile?: "general" | "legal";   // 默认 "general"
```

### 步骤 3：实现 profile defaults

在 `src/config/loader.ts` 加 profile defaults 合并逻辑：

```
final config = deepMerge(
  baseDefaults,
  profileDefaults[config.profile ?? "general"],
  userExplicitConfig,
)
```

profile defaults 内容：

- `general`：法律垂直扩展默认 `enabled: false`
- `legal`：法律垂直扩展默认 `enabled: true`

### 步骤 4：测试

新增测试覆盖前述四类场景。

### 步骤 5：文档

- `docs/architecture-baseline.md`：在 profile/extensions 相关章节加一段，说明 V2 落地后的默认值机制
- `docs/deploy.md`（或部署 README）：加一行"如何在 config 里选 profile"

## 验收标准

- [ ] `src/config/schema.ts` 有 `profile` 字段
- [ ] `general` profile 默认关闭法律垂直扩展，`legal` profile 默认启用
- [ ] 用户显式 `enabled` 覆盖永远生效
- [ ] 无 `profile` 字段的旧 config 默认作 `general`，不破坏既有显式配置
- [ ] disabled 扩展不创建 RuntimeModule（V1 已保证，本 slice 验证未回归）
- [ ] `src/runtime/app.ts`、`src/runtime/turn-executor.ts`、`src/bridge/router.ts` 未被修改
- [ ] 测试覆盖默认值 + 覆盖行为 + legacy 兼容
- [ ] 文档已更新

## 验证命令

```bash
npm run typecheck
npm test -- config
npm test -- runtime-modules
npm run check:docs-diff

# 手动验证（可选）：
# 1. 创建一份 config 设 profile=general，启动 bridge，确认法律扩展未加载
# 2. 创建一份 config 设 profile=legal，启动 bridge，确认法律扩展加载
```

## 给执行 Agent 的硬约束

1. **不动 core 主流程**。`src/runtime/app.ts`、`src/runtime/turn-executor.ts`、`src/bridge/router.ts` 在本 slice 内禁止修改。所有 profile 逻辑停留在 config layer。
2. **不引入新 profile**。只做 `general` 和 `legal` 两个，不要顺手加 `enterprise`、`lite`、`dev` 等。
3. **legacy 兼容不能破**：本 slice 上线后，没改过 config 的现有用户不应感知到变化。
4. **profile 只填默认**：实现 deepMerge 时确保用户显式 `enabled` 永远是终值。可以写单测验证。
5. **不创建过多文件**：profile defaults 如果可以在 loader 里常量化就常量化，不强求 `config/profiles/*.json` 文件分离。如果分离，理由要在 commit message 里说明。
6. **不动业务模块**。knowledge / contract / labor / case-workbench 源码不动。它们的 enabled 状态由 config 控制，不由模块自身读 profile。
7. **不改 `mappings.json` / persistence shape**。本 slice 是 config 层动作，不触及持久化。

## 完成总结模板

```
1. 跑的验证命令 + 输出
2. 变更文件清单（应在 src/config/、test/config*/、docs/ 下）
3. profile 字段定义位置 + 默认值合并位置
4. legacy 兼容验证：无 profile 字段的 config 测试在哪一行
5. core 主流程未触及的确认（git diff src/runtime/ src/bridge/ 输出空）
6. 文档更新点
```
