# 命令手册

本文收纳 README 中移出的命令说明。飞书内可发送 `/help`、`/commands`、`/指令` 查看当前 Bridge 指令总览。

## 飞书命令

### 运行时控制

| 命令 | 说明 |
| :-- | :-- |
| `/new` | 创建新会话 |
| `/status` | 查看当前窗口状态 |
| `/cost` | 查看本地 token 与成本估算 |
| `/sessions` | 查看当前窗口绑定的 OpenCode 会话 |
| `/sessions all` | 查看全部 OpenCode 会话 |
| `/sessions help` | 查看会话操作速查 |
| `/preview <编号>` | 预览最近一次会话列表中的会话 |
| `/preview <sessionId>` | 按 sessionId 预览 OpenCode 会话 |
| `/switch <编号>` | 切换或绑定并切换会话 |
| `/rename <标题>` | 重命名当前会话 |
| `/close` | 从当前窗口移除会话绑定 |
| `/delete` | 彻底删除 OpenCode 会话 |
| `/abort` | 中止当前任务 |
| `/models` | 查看模型提供方和模型列表 |
| `/models <provider>` | 查看指定 provider 的模型 |
| `/model use <provider/model>` | 设置当前窗口模型覆盖 |
| `/model reset` | 清除当前窗口模型覆盖，恢复 OpenCode 默认模型 |

### 帮助与诊断

| 命令 | 说明 |
| :-- | :-- |
| `/help` | 展示 Bridge 指令总览 |
| `/commands` | `/help` 的英文别名 |
| `/指令` | `/help` 的中文别名 |
| `/帮助` | `/help` 的中文别名 |

### 权限确认

| 命令 | 说明 |
| :-- | :-- |
| `/allow once` | 仅本次允许 OpenCode 权限请求 |
| `/allow always` | 允许并记住同类权限请求 |
| `/deny` | 拒绝当前权限请求 |
| `/允许一次`、`/仅此一次` | `/allow once` 的中文别名 |
| `/始终允许`、`/总是允许` | `/allow always` 的中文别名 |
| `/拒绝` | `/deny` 的中文别名 |

权限按钮不可用时，也可以直接发送 `允许一次`、`始终允许`、`拒绝`、`allow once`、`allow always`、`deny`。

### 知识库

| 命令 | 说明 |
| :-- | :-- |
| `/法律咨询开始` | 进入法律咨询模式 |
| `/法律咨询结束` | 退出法律咨询模式 |
| `/法律问答 <问题>` | 使用知识库回答法律问题 |
| `法律问答 <问题>` | 自然语言知识库入口 |
| `/kb-query <问题>` | 兼容旧知识库问答入口 |
| `/知识入库` | 开始知识入库 |
| `/知识入库结束` | 结束知识入库 |
| `/kb-ingest-start` | 兼容旧入库入口 |
| `/kb-ingest-end` | 兼容旧入库结束入口 |

### 合同与案件

| 命令 | 说明 |
| :-- | :-- |
| `/合同起草开始` | 进入合同起草流程 |
| `/合同起草结束` | 退出合同起草流程 |
| `/案件录入 <案件信息>` | 录入案件 |
| `/案件更新 <更新内容>` | 更新案件 |

### 案件工作台

| 命令 | 说明 |
| :-- | :-- |
| `/案件工作台` | 进入案件工作台材料收集流程 |
| `/完成上传` | 结束材料上传并继续分析 |

未被 Bridge 接管的 slash 命令会透传给 OpenCode，例如 `/review`、`/init`、`/compact`。

## 本地 runtime 命令

Release 包用户优先使用 portable 入口：

```bash
./bridge onboard
./bridge init workspace
./bridge start
./bridge doctor workspace
./bridge backup
./bridge cost
./bridge update check
```

Windows 使用：

```cmd
bridge.cmd onboard
bridge.cmd init workspace
bridge.cmd start
bridge.cmd doctor workspace
bridge.cmd backup
bridge.cmd cost
bridge.cmd update check
```

## 知识库 CLI

```bash
npm run --silent kb -- query --question "员工试用期最长多久？"
npm run --silent kb -- ingest file --path "/absolute/path/to/file.pdf"
npm run --silent kb -- ingest url --url "https://example.com/article"
npm run --silent kb -- parse pdf --path "/absolute/path/to/file.pdf"
npm run --silent kb -- doctor
```

## 外部扩展 CLI

外部扩展按本地 npm package 管理。每个扩展目录都需要自己的 `manifest.json`、`package.json`、`dist/meta.js` 和 `dist/runtime.js`。

```bash
npm run ext:install -- ./my-extension
npm run ext:list
npm run ext:remove -- hello-world
npm run ext:pack -- ./my-extension
```

这些命令只处理本地目录或本地 tarball，不连接 npm registry。

## Bridge Setup UI

终端向导命令，用于首次配置、profile 切换、扩展开关、诊断和启动。

```bash
npm run bridge -- setup               # 首次初始化向导
npm run bridge -- profile              # 查看当前 profile
npm run bridge -- profile --set=legal  # 切换 profile
npm run bridge -- extensions           # 查看扩展开关
npm run bridge -- extensions --enable=knowledge-base --disable=contract-assistant
npm run bridge -- doctor               # 跑诊断（config / feishu / opencode / dataDir / port）
npm run bridge -- start                # 启动服务
```

`bridge start` / `npm start` 启动后会渲染**状态面板 + Activity 实时事件流**：

- 状态面板（启动时打印一次）：Endpoint / Profile / 启用扩展 / 日志路径 / Ctrl+C 提示
- Activity 事件流（追加式）：从 `bridge-runtime.log` tail 出 turn 完成 / WS 连接 / 错误警告 / 知识库入库 / 卡片回调 / 模块状态等关键事件，按白名单过滤，每条带时间戳和颜色
- 每 30 秒打印一条 status 行（uptime + session cost）作为"心跳"
- 单条事件示例：`22:58:48  ✓  turn     p2p    ou_abcdefghij12  2.3s · 13字 · ¥0.0124`

非 TTY 场景（重定向到文件 / systemd / 被脚本管道消费）自动切到 JSON 行模式，每个事件一行 JSON，无颜色、无面板装饰，便于脚本解析。

ANSI 颜色默认在 TTY 下开启，可通过 `BRIDGE_NO_COLOR=1` 关闭。Bridge 原始运行日志（含 `[info]` / `[error]` 全量）仍写入 `logs/bridge-runtime.log`，需要细节时直接 `tail -f` 查看。

非交互式模式（CI / 脚本）所有命令支持 `--profile` / `--enable` / `--disable` flag，不弹 prompt。
