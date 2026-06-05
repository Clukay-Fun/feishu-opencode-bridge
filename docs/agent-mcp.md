# Bridge MCP 配置指南

Bridge 提供 MCP (Model Context Protocol) stdio 模式，让 OpenCode agent 能够查询 Bridge 的实时状态（如定时任务）。

## 配置方法

在 OpenCode 配置文件中添加 Bridge MCP server。

常见路径是：

- macOS/Linux: `~/.config/opencode/opencode.json`
- Windows: `%APPDATA%\opencode\opencode.json`

```json
{
  "mcp": {
    "Bridge": {
      "type": "local",
      "command": ["fob", "mcp"],
      "enabled": true
    }
  }
}
```

也可以使用完整命令名：

```json
{
  "mcp": {
    "Bridge": {
      "type": "local",
      "command": ["feishu-opencode-bridge", "mcp"],
      "enabled": true
    }
  }
}
```

如果 OpenCode 与 Bridge 使用不同工作目录，建议显式指定 Bridge 配置路径：

```json
{
  "mcp": {
    "Bridge": {
      "type": "local",
      "command": ["fob", "mcp"],
      "environment": {
        "BRIDGE_CONFIG_PATH": "/absolute/path/to/config.json"
      },
      "enabled": true
    }
  }
}
```

## 工作原理

- Bridge 主进程**不**启动 MCP server
- OpenCode 按需 spawn `fob mcp` 作为子进程
- MCP server 通过 stdio 与 OpenCode 通信
- 所有日志输出到 stderr，不干扰 JSON-RPC
- MCP server 会按顺序解析数据目录：`BRIDGE_DATA_DIR`、`BRIDGE_CONFIG_PATH` 中的 `storage.dataDir`、`BRIDGE_HOME/config.json`、当前目录 `config.json`、默认用户目录

## 可用工具

### `Bridge_scheduler_status`

返回定时任务的只读快照。

**输入**：
```json
{
  "include_recent_runs": false,
  "creator_user_id": "ou_xxx"
}
```

**输出**：
```json
{
  "as_of": "2026-06-05T10:00:00Z",
  "ttl_seconds": 0,
  "note": "Snapshot. Call again after /cron add/pause/resume/delete or after task run.",
  "enabled": true,
  "total_jobs": 3,
  "visible_jobs": [
    {
      "short_id": "sched-001",
      "title": "每天9点生成简报",
      "expression": "0 9 * * *",
      "kind": "cron",
      "state": "enabled",
      "next_run_at": "2026-06-06T09:00:00Z",
      "last_run": { "at": "...", "status": "success", "reason": "" }
    }
  ],
  "recent_failures": [],
  "management_commands": ["/cron list", "/cron show <id>", "/cron pause <id>", "/cron resume <id>", "/cron delete <id>"]
}
```

## 安全约束

- MCP server 只提供**只读**工具，不能创建、修改或删除任何数据
- 所有写操作（创建、暂停、删除任务）由用户通过 `/cron` 命令执行
- MCP server 读取 `data/schedules/` 下的 JSON 文件，不访问 Bridge 主进程的内存状态

## 故障排除

如果 `bridge mcp` 启动失败：
1. 检查 `bridge` 是否在 PATH 中
2. 检查 `data/schedules/` 目录是否存在
3. 查看 stderr 输出（OpenCode 会显示错误信息）
