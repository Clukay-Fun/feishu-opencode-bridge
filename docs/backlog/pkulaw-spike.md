# pkulaw MCP Spike 记录

Phase 0 spike 结论：`@pkulaw/mcp-cli` 可安装并提供稳定命令入口，但正式 `tools/list` / `tools/call` 需要先完成本地授权初始化。

## 已验证

```bash
npm view @pkulaw/mcp-cli version bin description --json
npx -y @pkulaw/mcp-cli@latest --help
npx -y @pkulaw/mcp-cli@latest docs
npx -y @pkulaw/mcp-cli@latest check
npx -y @pkulaw/mcp-cli@latest tools
```

结果：

- npm 包存在，当前 bin 为 `pkulaw-mcp`。
- CLI 命令包括 `init`、`tools/list-tools/ls`、`update/refresh`、`docs`、`check/doctor`、`config`。
- `docs` 无需 init，可列出服务与在线技术文档。
- `check` 在未初始化时提示缺少 `~/.pkulaw/mcp/config.json`。
- `tools` 在未初始化时提示先运行 `pkulaw-mcp init`。

## 最小可用工具候选

`pkulaw-mcp docs` 暴露的服务：

- `law-keyword`：检索法律法规-关键词。
- `law-semantic`：检索法律法规-语义。
- `case-keyword`：检索司法案例-关键词。
- `case-semantic`：检索司法案例-语义。
- `case-number`：案号识别与溯源。
- `law-recognition`：法条识别与溯源。
- `fatiao`：精准查找法条-关键词。
- `doc-link`：法宝超链。
- `citation-validator`：修正生成幻觉-法条。
- `semantic-nlsql`：法宝语义检索（NL-SQL）。

## 当前降级策略

Legal Harness V1 不阻塞在 pkulaw 正式接入上：

- 配置先落 `knowledgeBase.authoritySources.pkulaw`。
- doctor 能提示 CLI / 授权状态。
- 检索主流程继续走本地 SQLite 知识库。
- pkulaw 未初始化或无订阅时，仅标记权威源不可用，不阻断劳动分析与知识库入库。

## 后续正式适配前置条件

需要人工提供或确认：

- `pkulaw-mcp init --authorization "Bearer <Token>"` 所需 token 来源。
- 账号是否需要北大法宝订阅或特定 MCP 权限。
- `tools/list` 返回的实际 tool name 与 input schema。
- `tools/call` 对法规检索、案例检索、法条识别、引用核验的响应结构。
