# Knowledge Base 脚本说明

这个目录存放知识库本地 CLI 入口。

当前内容：

- `kb.ts`
  - 知识库统一入口

说明：

- `kb.ts` 是主入口
- 查询、文件入库、URL 入库、doctor 等子命令统一从 `kb.ts` 进入
- 不再单独保留超薄快捷 wrapper
