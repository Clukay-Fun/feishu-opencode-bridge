# 部署说明

## 目标环境

- Linux x64
- `feishu-opencode-bridge` 与 `opencode serve` 同机运行
- 通过 Caddy 暴露 HTTPS
- 飞书卡片 action 回调走公开域名

## 1. 环境准备

安装 Node.js 20+、Caddy、OpenCode。

```bash
node -v
caddy version
opencode --version
```

## 2. 拉取代码并安装依赖

```bash
git clone <your-repo-url>
cd feishu-opencode-bridge
npm ci
npm run build
npm test
```

## 3. 首次配置（推荐）

使用 `bridge setup` 向导完成首次配置，无需手写 JSON：

```bash
npm run bridge -- setup
```

向导会引导选择 profile（通用/法律）、启用扩展、填写飞书凭据，完成后自动跑一次诊断。

非交互式模式（CI / 脚本）：

```bash
npm run bridge -- setup --profile=legal --enable=knowledge-base,labor-skill --feishu-app-id=cli_xxx --feishu-app-secret=xxx
```

如果后续重新引入任何原生依赖，发布前必须在这台 Linux x64 机器上再次执行这三步验证。

## 3. 启动 OpenCode

在目标项目目录里启动：

```bash
opencode serve
```

如果启用了 Basic Auth，可在 bridge 进程环境中设置：

```bash
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=your-password
```

## 4. 配置 Bridge

复制 `config.example.json` 为 `config.json`，至少补齐：

- `feishu.appId`
- `feishu.appSecret`
- `feishu.botOpenId` / `feishu.botOpenIds`
- `opencode.baseUrl`
- `opencode.directory`
- `server.publicBaseUrl`
- `feishu.cardActions.verificationToken`

如果飞书事件启用了加密推送，再补：

- `feishu.cardActions.encryptKey`

按钮模式建议配置：

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 3000,
    "publicBaseUrl": "https://bridge.example.com/"
  },
  "feishu": {
    "cardActions": {
      "enabled": true,
      "path": "/webhook/card",
      "verificationToken": "your-verification-token",
      "encryptKey": ""
    }
  }
}
```

## 5. 配置 Caddy

参考 [ops/Caddyfile](/Users/clukay/Program/feishu-opencode-bridge/ops/Caddyfile)：

```caddyfile
bridge.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
```

启动后确认：

```bash
curl https://bridge.example.com/healthz
```

应返回：

```json
{"ok":true}
```

## 6. 配置飞书卡片 Action 回调

在飞书开放平台里把卡片回调地址配置为：

```text
https://bridge.example.com/webhook/card
```

并填入与你的 `config.json` 一致的：

- verification token
- encrypt key（如果启用了加密推送）

配置完成后先运行：

```bash
bridge doctor
```

`cardActions.enabled=true` 时，doctor 会检查：

- `server.publicBaseUrl` 必须是非示例、非 localhost 的 HTTPS 公网地址。
- 回调 URL 会按 `publicBaseUrl + feishu.cardActions.path` 展示，默认是 `/webhook/card`。
- 当前机器访问 `${publicBaseUrl}/healthz` 必须返回 2xx。

注意：doctor 从当前机器访问 `/healthz` 通过只是必要不充分条件，不等于飞书后端一定能访问。最终仍以 Bridge 的 HTTP callback 日志为准。

排错顺序建议：

1. 先运行 `bridge doctor`，确认公网回调配置没有硬错误。
2. 再确认 Caddy / ngrok / 反向代理能把 HTTPS 流量转发到 Bridge。
3. 点击一次权限卡按钮，查看 `http/card-action` 和 `http/server` 日志。
4. 如果按钮链路仍失败，先用 `/allow once`、`/allow always`、`/deny` 文本命令兜底完成当前权限处理。

如果飞书后台提示“返回数据不是合法的 JSON 格式”，优先参考 [飞书卡片回调排障记录](troubleshooting-card-actions.md)。这个报错通常表示公网入口返回了 `502`、`530`、HTML、空响应或纯文本，不一定是卡片 JSON 本身有问题。

## 7. 启动 Bridge

```bash
npm run dev:once
```

启动时会自动执行 preflight。若任何关键依赖不可用，bridge 会直接退出。

## 8. 验收清单

部署验收至少覆盖：

1. `npm ci`
2. `npm run build`
3. `npm test`
4. `opencode serve` 可成功启动
5. bridge 可成功启动
6. `https://<domain>/healthz` 可访问
7. `https://<domain>/webhook/card` 可被飞书卡片 action 回调命中
