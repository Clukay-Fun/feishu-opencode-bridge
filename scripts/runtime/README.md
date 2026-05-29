# Runtime 脚本说明

这个目录存放运行环境相关的入口脚本与共享诊断逻辑。

当前内容：

- `checks.mjs`
  - 启动前检查、doctor、onboard 共用的底层能力
- `doctor.mjs`
  - 环境诊断入口
  - 根据本地配置与 onboarding state 输出当前阶段和下一步
- `onboard.mjs`
  - 首次引导入口
- `onboarding-state.mjs`
  - 维护用户数据目录下的 `data/onboarding-state.json`
- `start.mjs`
  - 本地启动编排入口
- `bootstrap.mjs`
  - portable 包统一入口，准备用户目录、项目依赖并分发 onboard / doctor / start / init / backup / restore / cost / update
- `backup.mjs`
  - 备份和恢复本地用户数据目录
  - 不触达飞书远端 Base，也不备份 `.runtime`、`node_modules`
- `cost.mjs`
  - 读取本地 `data/usage-ledger.jsonl`，输出 token 与金额估算摘要
- `update.mjs`
  - 检查 GitHub Release、下载 portable 包到 `.runtime/staging`，并显式切换或回滚
- `portable.mjs`
  - portable 包目录、环境变量和 Node 下载元数据
- `install-node.sh` / `install-node.ps1`
  - 无系统 Node 时下载包内 portable Node

工作区初始化：

- `bridge init workspace`
  - 使用当前 `lark-cli` 用户授权创建合同、发票、案件和知识库多维表格
  - 写回用户目录 `config.json` 中的 Base / Table ID
  - 默认不覆盖已有工作区配置，`--force` 只覆盖本地配置指向，不删除远端 Base / 表 / 记录
  - 默认写入初始化样例记录，并在用户数据目录生成 `data/init-seeds.json`
  - `--no-sample-data` 只建表结构，不写初始化样例
  - `--reset-sample-data` 只删除 seed manifest 中记录过的样例记录，再重新写入样例
- `bridge doctor workspace`
  - 诊断 Base token、表 ID、字段结构和当前用户访问权限
  - 检测权限或 scope 问题时输出需要补充的 Bitable scope 和飞书开放平台入口
  - 只诊断，不自动改配置或创建远端资源
  - 输出缺配置、缺 workspace、doctor 未通过或已就绪等阶段化下一步
  - 与飞书 `/help` 指令配合，帮助新用户跑通 Hero 路线
- `bridge backup`
  - 将用户数据目录中的 `config.json`、`data/`、`logs/`、`extensions/` 等打包为 zip
- `bridge restore <zip> [--force]`
  - 恢复本地用户数据；默认拒绝覆盖已有 config/data
- `bridge cost [--json]`
  - 查看本地 AI token / 成本估算；`--reset-local` 只清本地 ledger
- `bridge update check|download|apply|rollback`
  - 检查新版、下载到 staging、显式切换或回滚；不覆盖用户数据目录
- `bridge init export-schema`
  - 维护者命令，用当前配置指向的真实表结构刷新 `scripts/workspace-init/current-workspace-schema.json`

使用原则：

- 与运行环境、安装、启动、诊断直接相关的脚本放在这里
- 新的共享检查逻辑优先并入 `checks.mjs`，不要再在根目录复制一份
- portable 入口设置 `BRIDGE_HOME` 后，配置默认写入用户目录；普通 npm 脚本未设置 `BRIDGE_HOME` 时仍使用仓库根 `config.json`
