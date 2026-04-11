# Deployment

## Target

- Linux x64
- 同机运行 `feishu-opencode-bridge` 与 `opencode serve`
- Caddy 暴露 HTTPS
- 飞书卡片 action 回调走公开域名

## 1. Prepare

安装 Node.js 20+、Caddy、OpenCode。

```bash
node -v
caddy version
opencode --version
```

## 2. Clone And Install

```bash
git clone <your-repo-url>
cd feishu-opencode-bridge
npm ci
npm run build
npm test
```

如果后续重新引入任何原生依赖，发布前必须在这台 Linux x64 机器上再次执行这三步验证。

## 3. Start OpenCode

在目标项目目录里启动：

```bash
opencode serve
```

如启用了 Basic Auth，可在 bridge 进程环境中设置：

```bash
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=your-password
```

## 4. Configure Bridge

复制 `config.example.json` 为 `config.json`，至少补齐：

- `feishu.appId`
- `feishu.appSecret`
- `feishu.botOpenId` / `feishu.botOpenIds`
- `opencode.baseUrl`
- `opencode.directory`
- `server.publicBaseUrl`
- `feishu.cardActions.verificationToken`

如飞书事件启用了加密推送，再补：

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

## 5. Configure Caddy

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
{"ok":true,"bridgeVersion":"0.2.0"}
```

## 6. Configure Feishu Card Action Callback

在飞书开放平台里把卡片回调地址指向：

```text
https://bridge.example.com/webhook/card
```

并填入与你的 `config.json` 一致的：

- verification token
- encrypt key（如果启用了加密推送）

## 7. Start Bridge

```bash
npm run dev:once
```

启动时会自动执行 preflight。若任何关键依赖不可用，bridge 会直接退出。

## 8. Acceptance Checklist

部署验收至少覆盖：

1. `npm ci`
2. `npm run build`
3. `npm test`
4. `opencode serve` 可启动
5. bridge 可启动
6. `https://<domain>/healthz` 可访问
7. `https://<domain>/webhook/card` 可被飞书卡片 action 回调命中
