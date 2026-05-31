# Slice: Issue #70 终端 Setup UI

依据:GitHub issue #70 + `docs/adr/0003-file-workspace-layer.md` Slice E CLI 既定风格。

## 目标

为 Bridge 提供一组终端向导命令,把首次配置、profile 切换、扩展开关、诊断、启动这五个动作从"手写 JSON / 背 npm 命令"提升到"交互式向导 + 友好错误提示"。

5 个命令(全部走 `npm run bridge -- <subcommand>` 入口,与 #65 E 的 `npm run files --` 风格一致):

- `bridge setup`:首次初始化向导(profile + 扩展 + 关键 secret)
- `bridge profile`:查看/切换当前 profile
- `bridge extensions`:多选菜单启用/停用可选扩展
- `bridge doctor`:配置 / Feishu / OpenCode / 数据目录 / 端口诊断
- `bridge start`:启动服务,失败时给出下一步操作建议(不只是抛栈)

**不做** portable 包(那是 #73 V3 的事)。**不做** Web 后台。本 slice 范围严格限定在 CLI 向导本身。

## 范围

### 包含

- 新建 `bin/bridge.ts`(CLI 主入口)+ `src/setup-ui/` 模块(命令实现 + prompts 抽象 + 诊断逻辑)
- 5 个子命令实现(setup / profile / extensions / doctor / start)
- 配置读写**全部通过现有** `src/config/schema.ts` + `src/config/loader.ts`,**不绕开 schema 直接写散落文件**
- profile / 扩展开关基于 `#73 V1+V2` 已落地的机制(`src/config/profiles.ts` + `resolveProfileExtensionEnabled`)
- 诊断检查至少覆盖:
  - 配置文件存在 + schema 校验通过
  - Feishu App ID / Secret 已配置(不输出 secret 内容,只检查是否填写)
  - OpenCode 可连接(简单 health 探活)
  - 数据目录可写
  - HTTP 端口未被占用
- `package.json` 加 `"bridge": "tsx bin/bridge.ts"` script
- 测试覆盖:
  - profile 合并逻辑(setup 选 legal → config 落盘后法律扩展默认启用)
  - 扩展开关单测(用户在 extensions 命令里关掉某项 → 持久化生效)
  - doctor 主要失败路径各至少 1 个 fixture
  - 失败错误信息格式(包含建议而非只抛栈)
- 文档:
  - `docs/deploy.md` 加一节"首次配置走 `bridge setup`"
  - `docs/commands.md` 加 5 个命令说明

### 不包含

- **不做** portable 包构建 / 单文件可执行(#73 V3)
- **不做** Web 管理后台
- **不做** 远程管理 / 登录 / 权限系统 / 扩展市场
- **不动** `src/runtime/app.ts` / `src/runtime/turn-executor.ts` / `src/bridge/router.ts`(业务命令不入 core)
- **不引入** 新 profile(只有 `general` / `legal`,沿用 #73 V2 落地的两个)
- **不改** 现有 RuntimeModule / Feishu transport / OpenCode turn 执行链
- **不重写** 现有任何业务模块代码(setup-ui 是配置层动作,不触业务)

### 行为规则

1. **配置入口唯一**:所有配置读写经 `src/config/schema.ts` 校验。绕过 schema 直接 `fs.writeFile` 写 config.json 不允许(测试会卡)。
2. **secret 不输出**:`doctor` 检查 Feishu Secret 时只判断"已填 / 未填",不在 stdout / 日志里出现 secret 值。脱敏遵循现有 `logger.ts` 规则。
3. **失败必须有"下一步"**:任何命令失败,错误消息**必须包含"下一步建议"**(如"运行 `bridge setup` 重新配置"或"检查 config.json 的 X 字段")。不允许只 `console.error(error.stack)`。
4. **profile 切换不破坏 user override**:用户在 `extensions` 里显式开关的扩展,切换 profile 后**仍以 user 覆盖为准**——这是 #73 V2 已经定的契约,本 slice 必须遵守。
5. **start 是 thin wrapper**:`bridge start` 内部调用现有启动脚本(`scripts/runtime/start.mjs` 或等价),不重写启动逻辑。失败时把退出码透传 + 加诊断提示。
6. **交互式 + 非交互式双轨**:每个命令在 TTY 下走 prompt,非 TTY(CI / 脚本)下接受 `--profile=legal --enable=knowledge-base,labor-skill` 这类 flag,不强迫交互。
7. **错误输出走 stderr**,正常输出走 stdout,exit code 反映成功/失败(便于脚本 / OpenCode 解析)。

## 实现步骤

### 步骤 1:盘点现状

```bash
# 现有启动脚本和 bin
ls scripts/runtime/ bin/
# 现有配置层
ls src/config/
# 现有 lint / typecheck 设置
cat package.json | grep -A 1 '"scripts"'
```

### 步骤 2:依赖决策

最小必要依赖(就这一个):

- **`@inquirer/prompts`** —— 交互式 select / checkbox / input。手写不可靠。

明确**不引入**(用 Node 内置 / ANSI / argv 手写替代):

- `commander` / `yargs` —— argv 手写(参考 `bin/files.ts` 的风格)
- `picocolors` / `chalk` —— 直接 ANSI 转义,本 slice 只用基础颜色(成功绿 / 失败红 / 提示黄)
- `ora` —— 简单 `... ` indicator 即可

如果觉得 `@inquirer/prompts` 体积大,可以换 `prompts`(更轻);两者二选一,**不允许同时引入**。

### 步骤 3:CLI 主入口 + 子命令分发

新建 `bin/bridge.ts`,argv 手动分发到 5 个子命令模块。

### 步骤 4:每个命令模块

`src/setup-ui/` 下:

- `setup.ts` —— 首次初始化:询问 profile → 多选扩展 → 询问 Feishu / OpenCode 关键字段 → 写 config + 跑一次 doctor
- `profile.ts` —— 显示当前 profile,询问是否切换
- `extensions.ts` —— 多选菜单显示当前启用状态,可勾选修改
- `doctor.ts` —— 跑诊断,逐项输出结果 + 失败提示
- `start.ts` —— thin wrapper 调用现有启动脚本

### 步骤 5:友好错误层

新建 `src/setup-ui/diagnostics.ts`,封装"错误 + 建议"对:

```ts
type DiagnosticResult = {
  ok: boolean;
  label: string;
  detail?: string;
  nextStep?: string;   // 失败时必填
};
```

所有诊断和错误处理产出 `DiagnosticResult`,统一渲染。

### 步骤 6:非交互式 flag 支持

每个命令支持 `--profile=X --enable=A,B --disable=C` 等 flag,在非 TTY 环境直接生效,不弹 prompt。

### 步骤 7:测试 + 文档

- `test/setup-ui-*.test.ts`:profile 合并 / 扩展开关 / doctor 失败路径
- `docs/deploy.md` 加"首次配置"小节
- `docs/commands.md` 加 5 个命令说明

## 验收标准

- [ ] 5 个命令均可用:`npm run bridge -- setup / profile / extensions / doctor / start`
- [ ] 配置读写经 `src/config/schema.ts` 校验,不绕 schema
- [ ] profile 切换不覆盖 user 显式 `enabled`(沿 #73 V2 契约)
- [ ] doctor 5 项检查全覆盖:config / feishu / opencode / dataDir / port
- [ ] secret 不在 stdout / 日志出现
- [ ] 所有错误信息包含"下一步建议"
- [ ] 交互式 + 非交互式双轨,CI 下可走 flag
- [ ] start 是 thin wrapper,退出码透传
- [ ] 至少 1 个新依赖(`@inquirer/prompts` 或 `prompts`),其余手写
- [ ] `src/runtime/app.ts` / `src/runtime/turn-executor.ts` / `src/bridge/router.ts` 未触
- [ ] 现有业务模块 0 修改
- [ ] typecheck + 全量测试通过
- [ ] `docs/deploy.md` + `docs/commands.md` 已更新

## 验证命令

```bash
npm run typecheck
npm test -- setup-ui
npm run check:docs-diff
npm test

# 手动烟测(本地)
npm run bridge -- setup           # 走一遍首次配置
npm run bridge -- doctor          # 跑诊断
npm run bridge -- profile         # 看 profile
npm run bridge -- extensions      # 改扩展开关
npm run bridge -- start --help    # start 的 help 输出

# 非交互式烟测
npm run bridge -- profile --set=legal
npm run bridge -- extensions --enable=knowledge-base --disable=contract-assistant
```

## 给执行 Agent 的硬约束

1. **配置入口唯一**:所有配置变更经 `src/config/schema.ts`,绕开 schema 的 `fs.writeFile` 不允许。
2. **不动 core 主流程**:`src/runtime/app.ts` / `src/runtime/turn-executor.ts` / `src/bridge/router.ts` 不允许修改。
3. **secret 不出现在 stdout / 日志**:doctor 检查 Feishu Secret 时只判定"已填/未填",不读不输出值。
4. **错误必须带下一步建议**:不允许只 `console.error(error.stack)`。
5. **start 是 thin wrapper**:不重写 `scripts/runtime/start.mjs` 现有启动逻辑,只包一层提示。
6. **依赖最小化**:除 prompts 库二选一,其余 commander / chalk / picocolors / ora **不引入**。argv 用 Node 手写(参考 `bin/files.ts`)。
7. **非交互式必须支持**:CI / 脚本场景所有命令可走 flag 不弹 prompt。
8. **不引入新 profile**:`general` / `legal` 两个,不要"顺手加" enterprise / lite / dev。
9. **不做 portable 包 / 单文件 / Web 后台**——这是 #73 V3 和未来的事。
10. **业务模块 0 修改**:knowledge / contract / labor / case-workbench / memory 一行不动。
11. **不实现完整 doctor**:5 项检查覆盖即可,不做"扫描所有可能问题"。

## 完成总结模板

```
1. 跑的验证命令 + 输出
2. 变更文件清单(应在 bin/ + src/setup-ui/ + test/ + docs/)
3. 新引入的依赖(应只有 1 个 prompt 库)
4. 5 个子命令文件路径
5. doctor 5 项检查覆盖位置
6. 非交互式 flag 支持示例
7. 错误"下一步建议"的实现位置(diagnostics.ts 或等价)
8. core 主流程未触确认(git diff src/runtime/ src/bridge/ src/feishu/ 输出空)
9. 业务模块未触确认
10. 未完成项清单(显式列出"包含"章节里未实现的子项,无则写"无")
```

## 完成后的状态

- **#70 issue 闭环可 close**
- 内部部署链路得到简化(从手写 config 到向导)
- **#73 V3** 仍待做(portable 打包,让外部律所能 0 npm install 装)
- 真正的"分发"还需要 #73 V3。本 slice 是 #73 V3 的前置

## 给执行 agent 的特别提示(基于上一轮经验)

完成总结里**必须显式列出未完成项清单**。上一轮(#65 C v2)漏列过 docx 模板未做的真实情况,导致审查时才发现"假实现"。本 slice 验收标准里每一项打钩前要逐条对照,凡未实现的子项必须主动声明,不能只说"完成了"。
