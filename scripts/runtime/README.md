# Runtime 脚本说明

这个目录存放运行环境相关的入口脚本与共享诊断逻辑。

当前内容：

- `checks.mjs`
  - 启动前检查、doctor、onboard 共用的底层能力
- `doctor.mjs`
  - 环境诊断入口
- `onboard.mjs`
  - 首次引导入口
- `start.mjs`
  - 本地启动编排入口
- `bootstrap.mjs`
  - portable 包统一入口，准备用户目录、项目依赖并分发 onboard / doctor / start
- `portable.mjs`
  - portable 包目录、环境变量和 Node 下载元数据
- `install-node.sh` / `install-node.ps1`
  - 无系统 Node 时下载包内 portable Node

使用原则：

- 与运行环境、安装、启动、诊断直接相关的脚本放在这里
- 新的共享检查逻辑优先并入 `checks.mjs`，不要再在根目录复制一份
- portable 入口设置 `BRIDGE_HOME` 后，配置默认写入用户目录；普通 npm 脚本未设置 `BRIDGE_HOME` 时仍使用仓库根 `config.json`
