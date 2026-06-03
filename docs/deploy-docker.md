# Docker 部署说明

## 部署形态

Docker 只运行 Feishu OpenCode Bridge 本体。

Obsidian 不需要安装在服务器上。服务器只挂载一个 Markdown vault 目录，供 Bridge 写入；本地 Obsidian 通过同步工具打开这个目录。

## 1. 准备服务器目录

```bash
mkdir -p /srv/feishu-opencode-bridge
cd /srv/feishu-opencode-bridge
```

把项目代码上传到这个目录，或在服务器上拉取仓库。

```bash
git clone <your-repo-url> .
```

## 2. 准备配置和持久化目录

```bash
cp config.example.json config.json
mkdir -p data logs vault
```

编辑 `config.json`。Docker 部署时建议至少调整：

```json
{
  "opencode": {
    "baseUrl": "http://host.docker.internal:4096/",
    "directory": "/workspace"
  },
  "storage": {
    "dataDir": "./data"
  },
  "server": {
    "host": "0.0.0.0",
    "port": 3000,
    "publicBaseUrl": "https://bridge.example.com/"
  },
  "logging": {
    "dir": "./logs"
  },
  "memory": {
    "obsidian": {
      "enabled": false,
      "vaultPath": "./vault"
    }
  }
}
```

如果启用知识库 Obsidian 导出，也把 `knowledgeBase.obsidian.vaultPath` 配成 `./vault`。

注意：`server.host` 在容器里必须使用 `0.0.0.0`，否则宿主机反向代理无法访问容器端口。

## 3. 启动

```bash
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
docker compose logs -f bridge
curl http://127.0.0.1:3000/healthz
```

## 4. 配置 HTTPS 反向代理

用 Caddy 把公网 HTTPS 转发到本机 Docker 暴露的端口：

```caddyfile
bridge.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
```

飞书卡片 Action 回调地址填写：

```text
https://bridge.example.com/webhook/card
```

## 5. 更新

```bash
git pull
docker compose up -d --build
```

`config.json`、`data/`、`logs/`、`vault/` 都在宿主机目录中，不会因为重建镜像丢失。

## 6. Obsidian 同步

服务器侧只维护：

```text
/srv/feishu-opencode-bridge/vault
```

本地 Obsidian 可通过 Git、Syncthing、rsync、SFTP 或 WebDAV 同步这个目录。Bridge 不依赖 Obsidian 桌面应用，也不会调用 Obsidian 插件运行时。
