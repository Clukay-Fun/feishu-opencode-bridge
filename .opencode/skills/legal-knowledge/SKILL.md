---
name: legal-knowledge
description: 在私聊里判断何时查询法律知识库、何时快速入库本地文件或网页，以及何时只做普通聊天或普通文件分析。
---

# 私聊法律知识库技能

在这个项目里，法律知识库能力通过本地命令提供，不需要伪造 function call，也不需要让 bridge 解析特殊标记。

## 可用命令

### 1. 查询知识库

当用户的问题明显需要法律知识库背景时，运行：

```bash
npm run --silent kb -- query --json --question "<用户问题>"
```

返回 JSON：

```json
{"ok":true,"result":{"question":"...","results":[...]},"error":null}
```

如果 `results` 为空，说明知识库没有明显命中。不要捏造“知识库说了什么”，直接按你自己的能力继续回答，或明确说明未命中。

### 2. 本地文件快速入库

当用户明确要求“把这个文件入库 / 加入知识库 / 导入知识库”时，且你已经拿到了本地文件路径，运行：

```bash
npm run --silent kb -- ingest file --json --path "<本地绝对路径>"
```

### 3. 网页快速入库

当用户明确要求把网页写入知识库时，运行：

```bash
npm run --silent kb -- ingest url --json --url "<网页 URL>"
```

如有必要，可附带用户要求：

```bash
npm run --silent kb -- ingest url --json --url "<网页 URL>" --instruction "<用户要求>"
```

## 何时调用

- 法律咨询、法条解释、合同/劳动/仲裁/赔偿/合规等问题：可以先调用 `kb query`，再组织回答。
- 用户只是闲聊、问编程、问一般常识：不要调用知识库命令。
- 用户上传了文件但只是要求总结/提炼/分析：直接读取文件处理，不要默认入库。
- 只有用户明确表达“入库”“加入知识库”“导入知识库”等意图时，才调用 `kb ingest file` 或 `kb ingest url`。

## 回答约束

- 命令失败时，优先引用 `error` 字段说明失败原因，不要伪造成功结果。
- 统一优先使用 `kb` 主命令；`kb_query`、`kb_ingest_file`、`kb_ingest_url` 只是兼容别名，不再作为首选写法。
- 快速入库完成后，用正常回复给出简短摘要即可：
  - 文件名或 URL
  - 成功/失败
  - 最终入库条数
  - 去重情况
  - 耗时
- 不要告诉用户 bridge 需要进入 `/legal-query-start`。私聊里直接提问即可。
- 批量多文件连续入库是 bridge 工作流，由用户显式发送 `/kb-ingest-start` / `/kb-ingest-end` 处理；这不属于你的快速命令路径。
