# 运维与部署资产

`ops/` 用来存放项目的运维、部署和宿主环境相关资产。

当前目录内的文件不是 bridge 运行时代码，也不是业务模块实现；它们主要用于把服务挂到具体宿主环境中，例如反向代理、域名接入、端口转发和上线时的外围配置。

## 当前内容

- `Caddyfile`
  - 阿里云服务器直连入口配置
  - 根域名提供备案展示页，`bridge.ominiagent.online` 反向代理本地 bridge
- `site/index.html`
  - `ominiagent.online` 的最小备案展示页
- `../docker-compose.caddy.yml`
  - 使用 host 网络监听服务器 `80/443`
  - Caddy 自动申请和续期 HTTPS 证书
- `deploy-server.sh`
  - 当前服务器的 rsync + Docker 部署脚本
  - 不覆盖服务器侧 `config.json`、`.env`、`.env.tunnel`、`data/`、`logs/`、`vault/`
  - 适合 GitHub 访问不稳定时，从本机同步已更新代码到服务器
- `update-server-tools.sh`
  - 更新服务器侧宿主工具，不重新部署 bridge 代码
  - 默认更新 `@larksuite/cli`
  - `--opencode`、`--cloudflared` 需要显式传入，避免自动升级影响正在运行的对话服务

## 这个目录适合放什么

- 反向代理配置样例，例如 Caddy、Nginx、Traefik
- systemd、pm2、Supervisor 等进程托管配置
- Docker Compose、部署脚本、上线检查脚本
- 与公网回调、TLS、端口暴露相关的宿主侧配置

## 这个目录不适合放什么

- `src/` 里的应用运行时代码
- 业务模块实现
- 一次性的排障记录或临时命令草稿
- 需要长期阅读的产品或架构说明

## 使用原则

- 这里的文件默认是“环境样例”或“部署资产”，不是仓库的唯一真相来源
- 应用侧配置仍以 `config.example.json`、`config.json` 和 `docs/deploy.md` 为准
- 如果某份运维文件只对单次上线有效，完成后不应长期保留在这里
