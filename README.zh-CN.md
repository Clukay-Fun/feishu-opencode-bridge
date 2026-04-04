# Feishu OpenCode Bridge

Feishu OpenCode Bridge 是一个独立运行的 TypeScript 服务，用来把飞书消息桥接到本地 OpenCode Server API。

它会通过飞书 WebSocket 订阅消息事件，把每个对话映射到一个 OpenCode session，把用户消息转发给 `opencode serve`，再通过 OpenCode 的 SSE 事件流拿到回复，并回写到飞书。

## 功能特性

- 支持飞书 `p2p`、`group`、`topic_group` 三类会话
- 一个飞书对话绑定一个 OpenCode session
- 群聊按线程隔离上下文
- 支持 OpenCode `prompt_async`、命令转发、中止、状态、模型、权限请求、session 切换
- 使用飞书交互卡片承载过程消息，并持续更新同一条回复
- 群聊 `@` 规则支持通过配置控制严格或宽松模式
- 支持多个机器人身份，以及“触发身份”和“自身身份”分离
- 按 `message_id` 去重飞书重复投递
- 通过 LRU 持久化保存飞书对话到 OpenCode session 的绑定关系
- 支持使用 `OPENCODE_SERVER_PASSWORD` 访问带鉴权的 OpenCode 服务

## 架构概览

主流程如下：

1. 飞书通过 WebSocket 推送 `im.message.receive_v1`
2. bridge 归一化消息，执行群聊 `@` 匹配规则，并生成 `conversationKey`
3. runtime 为该对话解析或创建 OpenCode session
4. 通过 `POST /session/:id/prompt_async` 发起请求
5. OpenCode SSE 事件流（`/event`，失败时回退 `/global/event`）持续推送回复
6. bridge 持续更新飞书 reply 卡片，直到本轮完成

主要模块：

- `src/feishu/`
  飞书 API、卡片格式化、WebSocket 入站归一化
- `src/opencode/`
  OpenCode HTTP client 与 SSE event stream
- `src/runtime/`
  运行时编排、队列、卡片、session 绑定、事件处理
- `src/store/`
  基于 JSON 的持久化存储
- `src/bridge/`
  队列、路由、pending interaction、watchdog

## 环境要求

- Node.js 20+
- 已开启机器人能力的飞书应用
- 本地已运行的 OpenCode 服务：

```bash
opencode serve
```

## 安装

```bash
npm install
```

## 配置

参考 `config.example.json`，创建你自己的 `config.json`：

```json
{
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "botOpenId": "ou_xxx",
    "botOpenIds": ["ou_xxx", "ou_yyy"],
    "botMentionNames": ["opencode", "open code"],
    "selfBotOpenId": "ou_xxx",
    "selfBotOpenIds": ["ou_xxx"],
    "wsUrl": "wss://open.feishu.cn/open-apis/ws/v2",
    "allowedOpenIds": [],
    "behavior": {
      "enableP2p": true,
      "enableGroup": true,
      "requireBotMentionInGroup": true,
      "strictBotMention": true,
      "ignoreNonUserSenders": true,
      "replyInThread": true
    }
  },
  "opencode": {
    "baseUrl": "http://127.0.0.1:4096/",
    "directory": "/absolute/path/to/project"
  },
  "storage": {
    "dataDir": "./data",
    "mappingsFile": "mappings.json"
  },
  "bridge": {
    "queueLimit": 3,
    "timeouts": {
      "firstEvent": 30000,
      "eventInterval": 120000,
      "totalTurn": 300000
    }
  },
  "logging": {
    "dir": "./logs",
    "level": "info",
    "enableTranscript": true,
    "enableConsole": true,
    "enableColor": true,
    "rotateDaily": true
  }
}
```

### 飞书配置说明

- `botOpenId`
  兼容旧配置的单个机器人身份字段
- `botOpenIds`
  群聊里会触发当前 bridge 的全部机器人身份
- `botMentionNames`
  当飞书 mention id 不稳定时，可额外用展示名作为回退匹配
- `selfBotOpenId` / `selfBotOpenIds`
  当前 bridge 自己的机器人身份，用于忽略自身发出的消息，避免回环
- `allowedOpenIds`
  可选白名单，非空时只有这些用户能和 bridge 对话

### 群聊 `@` 行为

当 `requireBotMentionInGroup=true` 时，群聊消息只有命中机器人匹配规则才会处理。

当 `strictBotMention=true` 时，只接受明确命中已配置机器人身份的消息。

## OpenCode 鉴权

如果 OpenCode Server 启用了鉴权，可以设置：

```bash
export OPENCODE_SERVER_PASSWORD=your-password
export OPENCODE_SERVER_USERNAME=opencode
```

## 开发启动

先启动 OpenCode：

```bash
opencode serve
```

再启动 bridge：

```bash
npm run dev
```

常用命令：

```bash
npm run typecheck
npm test
npm run lint
npm run dev:once
```

## 支持的命令

- `/new`
- `/status`
- `/abort`
- `/models`
- `/sessions`
- `/sessions <编号>`
- `/allow once`
- `/allow always`
- `/deny`
- 其他斜杠命令会透传到 OpenCode command 接口

## 日志与排查

日志写入 `logs/` 目录。

重点日志：

- `feishu/ws message received`
  说明 bridge 已成功接收并归一化消息
- `feishu/ws message skipped`
  说明事件到了，但被过滤掉了
- `feishu/ws duplicate message skipped`
  说明飞书重复投递了同一个 `message_id`
- `opencode/events event stream connected`
  说明 OpenCode SSE 正常连接
- `bridge/queue turn started`
  说明本轮开始处理

如果群聊 `@` 没触发，建议按这个顺序看：

1. 是否出现 `feishu/ws message skipped`
2. 日志里的 `mentionIds` 是否和配置里的 `botOpenIds` 一致
3. 飞书应用是否具备群消息相关权限，机器人是否真的在目标群里

## 当前限制

- 依赖本地已运行的 `opencode serve`
- 飞书可能重复投递同一个 `message_id`，当前只做内存级去重，进程重启后不保留
- 机器人和机器人之间能否互相触发，最终仍受飞书平台是否投递相关事件限制

## License

当前仓库还没有单独的 license 文件。
