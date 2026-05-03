# Hero 素材：5 分钟体验脚本

这组素材用于新用户完成工作区初始化后，快速复现飞书律师助手的核心路径。所有主体、案号、金额和时间均为虚构信息，可直接用于演示或本地验证。

## 准备

先完成：

```bash
bridge onboard
bridge init workspace
bridge doctor workspace
bridge start
```

启动后，在飞书里发送 `/guide`，确认机器人能正常回复新手引导卡片。

## 体验路径

1. 合同起草：把 `contract-draft-prompt.txt` 中的内容发送给机器人。预期看到合同起草过程卡片和最终草稿。
2. 合同录入：上传 `labor-contract.txt`，再按合同助手提示处理材料。预期看到合同字段提取或材料处理提示。
3. 案件管理：上传 `labor-arbitration-case.txt`，用于劳动争议分析或案件信息整理。预期看到劳动争议分析或案件材料整理结果。
4. 知识库入库：上传 `labor-law-faq.md`，再发送 `/kb-ingest-start` 开始入库。预期看到知识库入库进度卡片。

如果中途没有响应，先在终端运行：

```bash
bridge guide
bridge doctor workspace
```

## 设计边界

- Hero 路线只依赖 TXT / MD 这类零外部 OCR 的材料，避免首次体验卡在 MinerU、PaddleOCR 或扫描件质量上。
- 正式初始化样例由 `bridge init workspace` 写入飞书 Base；本目录只提供可复现的聊天侧素材。
- 如需重建初始化样例，请运行 `bridge init workspace --reset-sample-data`，它只会删除本地 `data/init-seeds.json` 记录过的样例记录。
