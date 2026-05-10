# 司法文书入库方案 v1

> **状态**：backlog 设计待落地
> **范围**：判决书 / 裁定书 / 调解书 / 仲裁裁决书 等司法文书的结构化入库
> **不在范围**：当事人书状（起诉状、答辩状、上诉状）、传票、送达回证、合同、咨询记录

---

## 1. 背景与目标

中国不是判例法国家，判决书在 KB 里的定位**不是法源**，而是「类案参考」。律师查类案的真实需求只有三件：

1. 看本辖区/本类案件的法院实务倾向
2. 借鉴法院说理思路
3. 评估胜诉概率

判决书原文 80%-95% 是事实陈述、当事人信息和程序内容，**真正可复用的只有「本院认为」和「判决结果」两段**。如果整篇入库，检索时全是噪声，命中也无价值。

**目标**：把判决书等司法文书提炼为可检索、可标注、可与法条交叉引用的 `case_digest` 条目，让律师在案件分析时能按争议焦点找到相关类案的说理片段。

---

## 2. 适用范围与优先级

| 文书类型 | 入库优先级 | 提取重点 |
|---|---|---|
| 民事判决书（一审/二审/再审） | ⭐⭐⭐⭐⭐ 最高 | 本院认为 + 判决结果 |
| 民事裁定书 | ⭐⭐⭐ 中 | 程序裁判规则（管辖、诉讼时效、保全等） |
| 民事调解书 | ⭐⭐ 低 | 一般不入库；典型调解案例可入 |
| 劳动仲裁裁决书 | ⭐⭐⭐⭐ 高 | 仲裁前置事实 + 裁决理由 |
| 商事仲裁裁决书 | ⭐⭐⭐ 中 | 仲裁规则适用 + 裁决理由 |
| 检察建议书 / 公证书 | — | 不入库 |

**起步阶段只做民事判决书**，其他文书在管线稳定后用同一套 schema 扩展。

---

## 3. 数据模型：`case_digest` 字段定义

复用 KB 类型化设计中已经预留的 `case_digest` 类型（confidence 0.9, reviewRequired=false），扩展司法文书特有字段：

```ts
type CaseDigestEntry = {
  // 通用字段（继承 KnowledgeEntry）
  id: string;
  type: "case_digest";
  question: string;       // 由 issue 生成，如「试用期超过法定上限的法律后果」
  answer: string;         // reasoning 的精简版 + rule
  tags: string[];         // 案由 + 争议焦点关键词
  confidence: number;     // 默认 0.9

  // 案件标识
  caseNumber: string;     // (2023)粤03民终XXXX号 — 必须，去重 key
  court: string;          // 深圳市中级人民法院
  courtLevel: "基层" | "中级" | "高级" | "最高";
  level: "一审" | "二审" | "再审" | "仲裁";
  judgmentDate: string;   // YYYY-MM-DD
  cause: string;          // 案由：劳动争议 / 合同纠纷 / 知识产权 ...

  // 争议焦点（一份 PDF 可拆 N 条 case_digest）
  issue: string;          // 单一争议焦点
  reasoning: string;      // 法院说理摘录（200-500 字，必须是原文 substring）
  rule: string;           // 可复用的裁判规则一句话（≤80 字）
  outcome: string;        // 该争议焦点的判决主文要点

  // 法条引用
  statutes: Array<{
    name: string;         // 《劳动合同法》
    article: number;      // 19
    valid: boolean;       // 当时是否有效（与现行法对照）
  }>;

  // 风险标注
  effective: boolean;     // 是否生效（被改判/再审则 false）
  weight: "guidance" | "typical" | "reference";  // 指导/典型/普通
  consensusLevel: "high" | "mixed" | "low";      // 同争议同辖区裁判口径一致性

  // 关联与回指
  relatedCases: string[]; // 同案不同审级 case_digest 的 id 列表
  sourceUrl: string;      // 裁判文书网 / pkulaw 链接（PDF 不入库）
  redactionApplied: boolean;  // 脱敏校验通过

  // 元信息
  extractedAt: string;
  extractorVersion: string;
  promptVersion: string;
  modelId: string;
};
```

**关键设计**：
- **一份 PDF → N 条 `case_digest`**：按争议焦点拆分，避免一条 entry 负担过多
- **caseNumber 是去重 key**：同一争议在同一案号下只能有一条
- **statutes.valid 字段**：与现行法条对照后标注，便于检索时降权过期判决

---

## 4. 提取管线（6 步）

```
[PDF / DOCX / 文本]
  ↓ ① 文件接收 + 内容 hash 缓存（沿用 KB ingest 现有逻辑）
[原始文本]
  ↓ ② 结构化分段
[分段后的 sections]
  ↓ ③ 脱敏闸（regex → NER → 跳过人工卡片，因为是公开文书）
[脱敏文本]
  ↓ ④ LLM 抽取（按争议焦点拆分输出）
[case_digest[] 数组]
  ↓ ⑤ 字段校验 + snippet substring 校验
[校验通过的条目]
  ↓ ⑥ 入库（embedding + bitable + sqlite）
```

### 4.1 步骤 ② 结构化分段

判决书有标准结构，按 **headings + 关键词锚点** 分段：

| 段落 | 锚点 | 是否进 LLM |
|---|---|---|
| 当事人信息 | "原告"、"被告"、"上诉人"、"被上诉人" 开头 | ❌ 丢弃 |
| 案由与诉讼请求 | "案由"、"诉称"、"辩称" | ✅ 进上下文 |
| 一审情况（二审才有） | "原审法院" | ✅ 简略进上下文 |
| 本院查明 | "本院经审理查明" | ✅ 进上下文（事实摘要） |
| **本院认为** | "本院认为" | ⭐ **核心**，是抽取主源 |
| 判决结果 | "判决如下"、"裁定如下" | ⭐ 抽取 outcome |
| 程序信息 | "审判长"、"审判员"、"书记员"、"合议庭" | ❌ 丢弃 |

分段失败时（非标准格式判决书）→ 整篇喂给 LLM，但标记 `extractorVersion` 为 fallback，便于后续优化。

### 4.2 步骤 ③ 脱敏

判决书的 PII 与一般材料不同——裁判文书网原文已**部分脱敏**（"张某"代替"张三"），但 KB 入库还要再过一层：

| PII 类型 | 处理 |
|---|---|
| 已脱敏的"张某"、"李某某" | 保留（已是脱敏形态） |
| 未脱敏的全名（少量原文未脱） | 替换为"原告"、"被告"、"上诉人" |
| 身份证号 | 删除 |
| 公司全名 | 保留（公开文书中公司名不脱敏，但内部使用时脱为"原告公司A"） |
| 详细住址 | 删除 |
| 手机号 / 邮箱 | 删除 |
| 案号 | 保留（这是关键索引） |

**脱敏后必须设 `redactionApplied = true`**，否则不允许入库。

### 4.3 步骤 ④ LLM 抽取 prompt 骨架

```
你是司法文书要旨提取助手。
按争议焦点把以下判决书拆成多条 case_digest 条目，输出 JSON 数组，不要输出额外说明。

输入：
- caseNumber: {案号}
- court: {法院名称}
- 文本: {脱敏后的「本院查明」+「本院认为」+「判决结果」}

输出每条字段：
- issue: 单一争议焦点（一句话，≤30 字）
- reasoning: 法院针对该焦点的说理（必须是原文 substring，200-500 字）
- rule: 可复用的裁判规则（一句话，≤80 字）
- outcome: 该焦点对应的判决主文要点
- statutes: 该焦点引用的法条数组（name + article）

规则：
1. reasoning 必须是原文 substring，不要改写，不要总结
2. rule 可以提炼，但不能引入原文未出现的概念
3. 同一焦点合并，不要拆得太碎
4. 焦点之间无说理交叉的，分开成多条
5. 不输出当事人姓名、身份证号、详细地址
```

### 4.4 步骤 ⑤ 字段校验

校验失败 → 该条 reject，不入库。校验项：

| 校验 | 规则 |
|---|---|
| caseNumber 格式 | 正则匹配 `\((\d{4})\)[\u4e00-\u9fa5]+\d+[\u4e00-\u9fa5]+\d+号` |
| reasoning substring | 必须是原文 substring（去除空白后比对） |
| statutes 格式 | name 在已知法律名称白名单中（避免编造法律） |
| statutes.valid | 与现行法条对照（pkulaw 可查），标注但不 reject |
| 字段长度 | issue ≤ 30 字、rule ≤ 80 字、reasoning 200-500 字 |
| 重复 issue | 同 caseNumber 下 issue 相似度 >0.9 → 合并 |

---

## 5. 入库与检索

### 5.1 入库

- `case_digest` 与 `article` 共用同一张 KB 表，通过 `type` 字段区分
- embedding 用 `issue + rule + reasoning 前 100 字` 拼接（避免长文本稀释向量）
- bitable 同步：在多维表格的「源文件」字段填 `caseNumber`，便于人工核查

### 5.2 检索

- 默认情况下 `case_digest` 与 `article` 一起返回，但**视觉上必须区隔**
- 案件工作台分析时，按争议焦点**主动检索类案**：
  ```
  for each issue in 争议焦点:
    candidates = kb.searchByType("case_digest", issue, topK=5)
    rank by: weight (guidance > typical > reference) → consensusLevel → 时间倒序
  ```
- 命中类案时附标语：
  > 类案参考：本条来自 (2023)粤03民终XXXX号，仅供说理思路参考，非法律依据。

---

## 6. 风险标注与治理

### 6.1 强制标注的风险维度

| 维度 | 取值 | 检索时如何处理 |
|---|---|---|
| `effective` | false | 不在默认检索结果中；只在 `--include-overruled` 时返回 + 加警告 |
| `statutes[].valid` | 任一为 false | 标注「⚠️ 引用法条已修订」+ 附现行版本对照 |
| `consensusLevel` | low | 标注「裁判口径不一」+ 附其他法院相反观点示例 |
| `weight` | reference | 排序降权 |

### 6.2 一案多审级关联

二审改判的案件，一审与二审 `case_digest` 必须互相 link：
- 二审 entry 的 `relatedCases` 含一审 id
- 一审 entry 的 `effective` 自动设为 false
- 检索一审 entry 时附「⚠️ 本案已被二审改判，参见 (XXXX)粤民终XX号」

---

## 7. 数据来源与冷启动批次

按 ROI 排，分 3 批入库：

| 批次 | 来源 | 数量级 | 入库优先级 |
|---|---|---|---|
| **R1** | 最高人民法院《指导性案例》（劳动 + 合同 + 知产相关） | 30-50 条 | ⭐⭐⭐⭐⭐ |
| **R2** | 深圳市中院 / 前海 / 福田 / 南山 / 罗湖 / 宝安 / 龙岗 / 龙华 / 坪山 / 光明法院年度典型案例 | 100-300 条 | ⭐⭐⭐⭐ |
| **R3** | pkulaw 按高频争议焦点检索的案件（每焦点 top 10） | 1000-3000 条 | ⭐⭐⭐ |
| **不做** | 全网爬裁判文书网 | 几百万 | 噪声 > 价值 |

R1 全部手工核校；R2 抽 20% 核校；R3 走自动管线 + 人工抽检 5%。

---

## 8. 验收标准

P0 提取管线上线前必须达到：

| 指标 | 阈值 | 测量方式 |
|---|---|---|
| 字段提取准确率 | ≥ 90% | 人工核校 R1 全部 + R2 抽 20 条 |
| reasoning substring 校验通过率 | ≥ 95% | 自动校验 |
| 同案重复入库率 | ≤ 2% | caseNumber 去重统计 |
| 案件工作台类案命中后律师采纳率 | ≥ 50% | 用户在工作台对类案点击「采纳为参考」按钮的比例 |
| 检索误判率（类案当法源用） | ≤ 5% | 抽查工作底稿，看 reasoning 是否被误引为法律依据 |

---

## 9. 路线图

| 阶段 | 范围 | 工作量估计 |
|---|---|---|
| **R1（P0）** | 提取管线（步骤 ①-⑥）+ 校验 + 30-50 条指导案例冷启动 | 1-2 周 |
| **R2** | 深圳本地法院典型案例批量入库 + 关联多审级 | 1 周 |
| **R3** | pkulaw 自动检索批量入库 + 人工抽检流程 | 1 周 + 长期 |
| **P1** | 案件工作台主动按争议焦点检索类案 + UI 区隔展示 | 2-3 天 |
| **P2** | 一案多审级自动关联 + 改判后 effective 自动维护 | 2-3 天 |

---

## 10. 与现有架构的对接

- **复用** `src/knowledge/` 的 ingest 管线、embedding、bitable 同步——不改框架
- **新增** `src/knowledge/extractors/case-digest.ts`：判决书专用抽取器
- **复用** 已接入的 pkulaw（`config.extensions.knowledge-base.authoritySources.pkulaw`）做法条有效性校验和 R3 数据来源
- **配置位**：`config.extensions.knowledge-base.judicialIngest.{enabled, sources, batchSize}`，默认关闭

---

## 11. 风险与开放问题

| 风险 | 应对 |
|---|---|
| 裁判文书网反爬 / 限流 | R3 优先走 pkulaw API；裁判文书网仅作补充，限速访问 |
| LLM 抽取漏掉次要争议焦点 | 提取后追加一次「焦点完整性校验」prompt，问"还有遗漏的焦点吗" |
| 同争议不同地区口径冲突 | `consensusLevel` 字段标注，检索时分组返回 |
| 律师误把类案当法律依据 | UI 强制区隔 + 命中时附醒目标语 |
| R3 自动批量入库引入噪声 | 严格走字段校验 + 5% 人工抽检 + 用户标记「无用」即下架机制 |

**开放问题**（待与产品/律师顾问确认）：
1. 调解书是否入库？默认不入，但如果是典型调解案例（最高法发布的）可考虑
2. 涉及未成年人 / 国家秘密的判决书是否完全排除？建议默认排除
3. 律师上传非公开判决书（自己代理过的案件）是否允许入库？涉及客户保密，需要走脱敏闸 + 客户授权流程，纳入 P0c 脱敏闸的范围
