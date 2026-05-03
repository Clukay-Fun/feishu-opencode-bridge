# 数据流向与隐私说明

本文说明 Feishu OpenCode Bridge 在默认配置下会把数据放在哪里、哪些路径可能外发，以及哪些能力需要额外审查。它不是法律合规意见；真实案件上线前，请结合所在律所、客户协议和所选 AI provider / OCR provider 的条款自行确认。

## 一句话结论

- 飞书聊天文本会交给本地运行的 Bridge，并经 OpenCode 发送给你配置的 AI provider。
- 合同、案件、发票和知识库数据会写入你的飞书多维表格；本地也会保留配置、状态、日志和 SQLite 索引。
- 外部 OCR API 默认关闭；只有显式开启后，图片或扫描件才可能上传到 MinerU、PaddleOCR-VL 等 OCR provider。
- 敏感案件建议使用本地模型、私有模型网关或企业合规过的 provider，并关闭完整日志与外部 OCR。

## 数据流向表

| 数据类型 | 默认存放 / 处理位置 | 是否可能外发 | 说明 |
| --- | --- | --- | --- |
| 飞书文本消息 | Bridge 进程、OpenCode session、日志预览 | 是 | 会进入你配置的 OpenCode provider。provider 是否训练、留存多久，取决于 provider 条款。 |
| 合同 / 案件文件 | 本地临时文件、飞书 Base、必要时进入 OpenCode 上下文 | 是 | 文件内容用于提取、起草、分析时会作为上下文发送给模型。 |
| 合同 / 发票 / 案件台账 | 用户自己的飞书 Base | 否，除飞书自身云端 | `bridge init workspace` 创建正式 Base；Bridge 不把这些数据同步到项目维护者。 |
| 知识库条目 | 飞书 Base + 本地 SQLite / FTS | 是 | 入库抽取问答时会调用模型；检索索引存本地。 |
| 图片 / 扫描件 OCR | 默认本地 Tesseract；外部 OCR 默认关闭 | 仅显式开启时 | `knowledgeBase.parser.externalApiEnabled=true` 后，材料可能上传到配置的 OCR provider。 |
| 长期记忆 memory | 本地 SQLite，可选 Obsidian | 否，除模型抽取步骤 | 默认关闭。启用后会从对话中提取长期事实并写本地。 |
| 日志 | 本地 `logs/` | 否 | 默认 `messagePolicy=preview`。真实案件不建议开启 `full`。 |
| 外部扩展 | 用户安装的本地扩展目录 | 取决于扩展 | 外部扩展是受信代码，不是沙箱。安装前应审查来源和依赖。 |

## 推荐配置

敏感案件建议：

```json
{
  "opencode": {
    "baseUrl": "http://127.0.0.1:4096/"
  },
  "logging": {
    "messagePolicy": "preview",
    "enableTranscript": true
  },
  "memory": {
    "enabled": false
  },
  "extensions": {
    "knowledge-base": {
      "parser": {
        "externalApiEnabled": false,
        "imageProviderOrder": ["tesseract"]
      }
    }
  }
}
```

如果必须使用外部 provider，请先确认：

- provider 是否把输入用于训练。
- retention / 删除策略。
- 数据存储区域。
- 是否支持企业合同、零留存或私有部署。

## 自查命令

```bash
bridge doctor
bridge doctor workspace
bridge guide
```

`bridge doctor` 会输出 Data Flow 分组，展示 AI provider 地址、外部 OCR、memory 和日志策略。它只做透明提示，不替你做合规判断。
