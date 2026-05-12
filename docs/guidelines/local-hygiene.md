# 本地卫生清理指南

本文只说明开发工作区的本地清理边界，不定义运行时产品行为。

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
