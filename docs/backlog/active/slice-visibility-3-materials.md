# Slice: Agent Visibility · Slice 3 · Recent Materials

依据:[`docs/adr/0005-bridge-agent-visibility-boundary.md`](../../adr/0005-bridge-agent-visibility-boundary.md)。
**前置**:Slice 2 验收通过。

## 目标

让 agent 知道"用户最近上传了什么文件 / Bridge 把哪些材料注入了上下文"。新增 `Bridge_recent_materials` MCP + `file-materials` skill。

## 范围

### 包含

- `src/mcp/tools/recent-materials.ts`:`Bridge_recent_materials` 工具
  - 输入:`window_key?: string`, `limit?: number = 10`
  - 输出:`{ as_of, ttl_seconds: 0, note, materials: [{message_id, kind: "file"|"image", name, path_in_workspace, uploaded_at, parsed_status: "pending"|"ready"|"failed"}] }`
- 数据源:文件 workspace 层(参考 `docs/adr/0003-file-workspace-layer.md`)+ message-context store
- `.opencode/skills/file-materials/SKILL.md`(新建):
  - 解释 "Bridge 把上传文件落到 workspace 目录,会把路径注入到下一轮 user message 上下文"
  - agent 在被问 "刚才那个 PDF 在哪" 时,先调 `Bridge_recent_materials`
  - **不能**自称 "已删除文件" / "已移动文件" — 删除/移动必须由用户走 Bridge 命令

### 不包含

- 文件读 / 解析 MCP(若需要,留 v2 评估 `Bridge_material_query`,要走 `_query` 命名)
- 任何写权限

## 验收

- "刚才那个发票 PDF 在哪?" → agent 调 `Bridge_recent_materials`,返回真实路径
- "帮我删了那个 PDF" → agent **不**伪造删除,回 "请在飞书撤回原消息,或告诉我具体操作意图"
- parsed_status 字段在文件解析中/完成/失败时分别正确反映

## 未完成项清单

- knowledge-base skill(Slice 4)
- system prompt 收敛(Slice 5)
- `Bridge_material_query`(v2,如需 OCR/全文检索)
