# 飞书卡片回调排障记录

这份记录来自一次本地 `cloudflared tunnel --url http://127.0.0.1:3000` 调试。目标是防止再次把飞书后台的“返回数据不是合法的 JSON 格式”误判成卡片 JSON 或 SDK 问题。

## 典型现象

飞书开放平台保存卡片回调地址时报：

```text
返回数据不是合法的JSON格式
```

cloudflared 日志可能出现：

```text
Unable to reach the origin service:
dial tcp 127.0.0.1:3000: connect: connection refused
```

或浏览器 / curl 看到 Cloudflare 的 HTML 错误页：

```text
HTTP/2 530
Cloudflare Tunnel error
```

或看到纯文本：

```text
HTTP/2 502
502 Bad Gateway
Unable to reach the origin service
```

这些都不是合法 JSON，飞书后台会统一报“不是合法 JSON”。

## 本次根因

这次调试里先后踩了三个坑：

1. Bridge 没有监听 `127.0.0.1:3000`。
2. 旧 Bridge / bootstrap 残留进程导致重新启动时报 `EADDRINUSE`，新 HTTP 回调服务没有真正起来。
3. `trycloudflare.com` quick tunnel 是临时域名，重启或异常后旧域名可能返回 Cloudflare `530` HTML 页面。

正确判断标准只有一个：

```bash
curl http://127.0.0.1:3000/healthz
curl https://<当前 tunnel 域名>/healthz
curl https://<当前 tunnel 域名>/webhook/card
```

三条都必须返回 JSON，才去飞书后台保存回调地址。

## 正确启动顺序

先启动 Bridge，再启动或确认 cloudflared 指向同一个本机端口。

如果刚经历过启动失败，先清理残留：

```bash
cd /Users/clukay/Program/feishu-opencode-bridge
pkill -f "scripts/runtime/bootstrap.mjs start"
pkill -f "dist/src/index.js"
pkill -f "opencode serve"
```

确认端口干净：

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
lsof -nP -iTCP:4096 -sTCP:LISTEN
```

启动 Bridge：

```bash
./start.command
```

另一个终端启动临时 tunnel：

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

拿到新域名后，把本地配置和飞书后台都改成：

```text
https://<当前 tunnel 域名>/webhook/card
```

## 保存飞书后台前的验收

本机 Bridge 必须返回 JSON：

```bash
curl http://127.0.0.1:3000/healthz
```

公网健康检查必须返回 JSON：

```bash
curl https://<当前 tunnel 域名>/healthz
```

公网回调探测必须返回 JSON：

```bash
curl https://<当前 tunnel 域名>/webhook/card
```

飞书 URL 校验模拟必须返回 challenge JSON：

```bash
TOKEN="$(node -e 'const c=require("./config.json"); process.stdout.write(c.feishu.cardActions.verificationToken || "")')"

curl -i https://<当前 tunnel 域名>/webhook/card \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"url_verification\",\"token\":\"$TOKEN\",\"challenge\":\"bridge-challenge-test\"}"
```

期望响应：

```json
{"challenge":"bridge-challenge-test"}
```

如果这里返回 `502`、`530`、HTML、空响应或纯文本，都不要去飞书后台保存。

## 快速判定表

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| `curl http://127.0.0.1:3000/healthz` 连接失败 | Bridge HTTP 服务没起来 | 启动 Bridge，或清理残留进程后重启 |
| `EADDRINUSE 127.0.0.1:3000` | 端口被旧进程或其他程序占用 | 先查 `lsof`，确认是旧 Bridge 再清理 |
| 公网返回 `502 Bad Gateway` | cloudflared 能连 Cloudflare，但转不到本机 3000 | 启动 Bridge，确认本机 `/healthz` |
| 公网返回 `530 Cloudflare Tunnel error` | quick tunnel 域名失效或边缘不可解析 | 重开 cloudflared，换新域名 |
| `/webhook/card` GET 返回空 | 后台探测可能误判 | 当前实现已让 GET 返回 JSON 诊断 |
| URL 校验 POST 没回 `challenge` | 飞书保存校验不会通过 | 检查 token、回调路径和 Bridge 版本 |

## 本地配置注意事项

每次 quick tunnel 生成新域名后，都要同步更新：

```json
{
  "server": {
    "publicBaseUrl": "https://<当前 tunnel 域名>/"
  },
  "feishu": {
    "cardActions": {
      "enabled": true,
      "path": "/webhook/card"
    }
  }
}
```

飞书后台填写完整回调地址：

```text
https://<当前 tunnel 域名>/webhook/card
```

`trycloudflare.com` quick tunnel 只适合调试。长期使用应换成 Cloudflare named tunnel 或固定 HTTPS 域名，否则每次重启都可能要改飞书后台。

## 已加固项

当前启动脚本已经增加保护：

- 如果 `3000` 上已经是健康 Bridge，会提示已在运行，不重复启动。
- 如果 `3000` 被本项目旧 Bridge 残留占用，会自动清理后继续启动。
- 如果 `3000` 被其他程序占用，不会乱杀，只会给出明确报错。

HTTP 回调入口也已增加诊断：

- `GET /webhook/card` 返回 JSON 诊断，不再返回空响应。
- 飞书 `url_verification` POST 应返回 `{"challenge":"..."}`。
