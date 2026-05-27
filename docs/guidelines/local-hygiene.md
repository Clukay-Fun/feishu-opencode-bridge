# 本地卫生清理指南

本文只说明开发工作区的本地清理边界，不定义运行时产品行为。

## 三类目录

- 开发仓库：保留源码、测试、文档、配置样例、启动器和 release 构建脚本。
- portable 发布包：只保留运行所需文件，由 `scripts/release/build-portable.mjs` 的 manifest 约束。
- 用户数据目录：保存真实配置、知识库、日志、扩展和运行态数据，默认是仓库根目录或 `BRIDGE_HOME` 指向的目录。

## 根目录职责

根目录应优先保留这些项目入口：

- `README.md`、`README.en.md`、`LICENSE`
- `AGENTS.md`、`CODEX.md`
- `package.json`、`package-lock.json`、`tsconfig.json`
- `config.example.json`
- 跨平台启动器：`bridge`、`bridge.cmd`、`bridge.ps1`、`setup.*`、`start.*`
- 工程入口目录：`src/`、`test/`、`scripts/`、`docs/`、`.github/`

根目录不应承载长期运行状态。新运行数据默认进入 `data/`、`logs/`、`.runtime/`、`turn-files/`、`artifacts/` 或 `outputs/`，并由 `.gitignore` 排除。

一次性 Feishu Base payload、演示输出和排障临时文件不要提交。确实需要长期保留时，先移动到 `docs/archive/` 并写清背景。

## portable 发布包边界

`npm run release:portable` 生成的包只允许包含：

- `dist/`
- `scripts/runtime/`
- `bridge`、`bridge.cmd`、`bridge.ps1`
- `package.json`、`package-lock.json`
- `config.example.json`
- `README.md`、`README.en.md`、`LICENSE`
- 空的 `.runtime/`、`logs/`

发布包默认不包含：

- `src/`、`test/`、`docs/`、`examples/`
- `artifacts/`、`outputs/`、`turn-files/`
- `data/` 真实运行数据
- 历史 `logs/` 内容
- `config.json`
- 根目录 legacy runtime 文件：`knowledge-base.db`、`active-knowledge-ingests.json`、`mappings.json`、`message-context.json`、`usage-ledger.jsonl`
- 一次性批量 payload：`batch-*.json`

修改发布包边界时，同步更新 `scripts/release/build-portable.mjs` 的 manifest 和 `test/scripts-onboard-start.test.ts` 中的 portable package 测试。

## 可直接清理

这些内容可以重新生成，清理前确认没有正在运行的 Bridge 进程即可：

- `.runtime/npm-cache/`
- `dist/`
- `turn-files/`
- 根目录 legacy runtime 文件：`knowledge-base.db`、`active-knowledge-ingests.json`、`mappings.json`、`message-context.json`、`usage-ledger.jsonl`

## 需要按需清理

- `logs/`：可删除旧日志，但排障期建议先保留当天日志。
- `.runtime/npm-global/`：包含 portable runtime 安装的全局工具，删掉后可能需要重新安装。

## 用户数据

`data/` 默认是用户数据目录，不做整目录删除。

其中 `data/knowledge-base.db` 是本地知识库 SQLite 索引。需要重建或压缩前，先复制到 `data/backups/` 或其它安全位置，再执行后续操作。

`data/pkulaw-cache/`、`data/invoice-recognition-cache/` 属于可再生成缓存，但清理后首次查询或识别会重新消耗时间与外部调用额度。

## legacy runtime 文件策略

根目录 legacy runtime 文件只作为历史兼容入口处理。清理或迁移时不要直接删除用户唯一副本。

推荐做法：

- 先确认 Bridge 未运行。
- 复制到 `data/backups/` 或其它安全位置。
- 如果对应新位置已经存在数据，优先保留新位置，只把旧文件作为人工排障材料。
- 迁移逻辑应保持显式、可回滚，不在启动器里静默覆盖用户数据。
