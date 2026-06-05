# Slice: Bridge Scheduler · Slice 5 · 新闻收集工具(RSS / webfetch)

依据:`docs/adr/0004-bridge-scheduler-architecture.md` 第 9 节 Slice 5。

## 目标

让 scheduled run 真正能"收新闻"——给 OpenCode 提供一个**轻量 RSS 工具**,scheduled task 的 prompt 可以让 AI 调它拉取昨天的 AI 科技新闻并摘要。

**这个 slice 跟 Scheduler 解耦**——是一个独立的 OpenCode 工具,任何 OpenCode session(scheduled run / 用户对话)都能用。

## 依赖

- 独立 slice,不依赖 Scheduler 1-4(但合在一起才让"AI 新闻"端到端用户故事跑通)

## 范围

### 包含

- 新建 `src/news/` 目录(或 `scripts/news/`,看是否需要独立 process)
- 选择一种实现路径(在 ADR 评估后定):
  - **路径 A**(推荐):**RSS 抓取 + 解析**(纯 Node,无外部 API key)
    - 内置几个 AI 科技 RSS 源:36Kr AI 频道 / 机器之心 / 量子位 / Hacker News / TechCrunch AI
    - 单纯 fetch + parse RSS XML(用 Node 内置 `fetch` + 轻量 RSS parser 如 `fast-xml-parser`)
    - 提供 CLI:`npm run news -- fetch --since "2026-06-03" --limit 20 --sources "36kr,jiqizhixin"`
    - 输出 JSON 数组(标题 / 链接 / 发布时间 / 摘要)
  - **路径 B**(可选):**webfetch MCP server**(更通用,可由 LLM 决定抓哪)
    - 装一个现成的 MCP server(如 `@modelcontextprotocol/server-fetch`)
    - 让 OpenCode 通过 MCP 协议调用
    - 需要 OpenCode 配置层面的改动
- 默认走路径 A;路径 B 留 follow-up
- 配置 schema:
  ```json
  {
    "news": {
      "sources": [
        { "id": "36kr-ai", "url": "https://36kr.com/feed-newsflash" },
        { "id": "jiqizhixin", "url": "https://www.jiqizhixin.com/rss" },
        { "id": "qbitai", "url": "https://www.qbitai.com/feed" },
        { "id": "hn-frontpage", "url": "https://hnrss.org/frontpage" }
      ],
      "cacheTtlMinutes": 30,
      "maxItemsPerSource": 50
    }
  }
  ```
- **缓存**:30 分钟内重复请求同一 URL 直接返回内存缓存,避免对源站造成压力
- **错误处理**:某个源 fetch 失败 → skip 该源,继续其他源,**不让整个工具崩**
- CLI 入口能直接给 OpenCode 在 prompt 里调用:
  ```bash
  # 这是 scheduled task prompt 里 AI 会跑的命令
  npm run news -- fetch --since "yesterday" --format markdown
  ```
- 输出格式两种:JSON(结构化) / Markdown(给 AI 直接 summarize)
- 测试:
  - mock fetch + 验证 RSS 解析(用 fixture XML)
  - 缓存命中
  - 单个源失败不影响其他源
  - CLI 各参数(--since / --sources / --limit / --format)

### 不包含

- **不做** 复杂 NLP / 中文分词 / 主题分类——只做"拉 RSS + parse + 按时间过滤"
- **不做** 自建新闻爬虫(只用公开 RSS)
- **不做** 自动推送到飞书——只暴露工具,推送靠 Scheduler 调度
- **不做** MCP server 实现(路径 B,留 follow-up)
- **不动** Scheduler 任何代码
- **不动** OpenCode 配置(用户自行决定怎么让 OpenCode prompt 调用本工具)

### 行为规则

1. **不引入重量依赖**:RSS 解析用 `fast-xml-parser` 或 Node 内置正则(若 XML 简单);**不引入 `node-rss` 这种 abandonware**
2. **fetch 必须有超时**:每个源 5 秒,5 个源并发,**总超时 15 秒**
3. **缓存是内存 LRU**:进程重启清空,不持久化
4. **`--since "yesterday"` 解析**:相对时间词支持 `today` / `yesterday` / `last-week` / ISO date
5. **失败容忍**:单个源 404 / 超时 / XML 解析失败 → 写 stderr warn + 该源条目跳过
6. **输出稳定排序**:按 `publishedAt` 倒序,同时间按 source 字母序,**确保跨调用可复现**
7. **CLI exit code**:全部源失败 → 1;部分失败 → 0(stderr 有警告);全部成功 → 0

## 实现步骤

1. 选 RSS parser 库(`fast-xml-parser` 推荐,~30KB)
2. 写 `src/news/rss-fetcher.ts`:并发 fetch + parse
3. 写 `src/news/cache.ts`:内存 LRU
4. 写 `src/news/cli.ts`:argv 解析 + 输出格式化
5. 加 config schema `news` 节
6. `package.json` 加 script `"news": "tsx src/news/cli.ts"`
7. 测试:fixture XML + mock fetch + CLI 各参数

## 验收标准

- [ ] CLI 可用:`npm run news -- fetch --since yesterday --format markdown` 输出昨天的新闻条目
- [ ] 默认源 4 个(36Kr / 机器之心 / 量子位 / HN),配置里可改
- [ ] 缓存命中(单测验证 30 分钟内第二次请求不发 HTTP)
- [ ] 单个源失败不影响整体(单测)
- [ ] 总超时 15 秒(单测)
- [ ] JSON / Markdown 两种输出格式
- [ ] `--since "yesterday"` / ISO 日期 / `today` 三种时间表达
- [ ] 排序稳定(单测)
- [ ] exit code 行为正确(全失败 1 / 部分失败 0 / 全成功 0)
- [ ] typecheck + news 全套测试通过
- [ ] 仅引入 1 个新依赖(`fast-xml-parser`,~30KB)
- [ ] 未触 Scheduler 任何代码

## 验证命令

```bash
npm run typecheck
npm test -- news
npm run news -- fetch --since yesterday --format markdown --limit 5  # 烟测
git diff src/scheduler/ 2>/dev/null  # 应为空
```

## 给执行 Agent 的硬约束

1. **不引入重量依赖**——只允许 `fast-xml-parser`(或更轻的同类),不引入 `node-rss` / `feedparser` 等大库。
2. **失败容忍**——单个源出问题不能拖垮整个工具。
3. **总超时 15 秒**——并发 fetch 不允许等更久。
4. **缓存只在内存**——不写文件,不污染 `data/`。
5. **不做爬虫**——只拉公开 RSS,不要解析 HTML / 用 puppeteer。
6. **不动 Scheduler**——本 slice 跟 scheduler 完全解耦。
7. **不实现 MCP**——路径 B 留 follow-up。
8. **输出稳定排序**——保证调用一致性。

## 完成总结模板

```
1. 跑的验证命令 + 输出(包括真实 fetch 烟测一次)
2. 变更文件清单(应在 src/news/ + package.json + src/config/schema.ts)
3. 选择的 RSS parser 库 + 体积
4. 4 个默认源 URL
5. 缓存实现 + 单测位置
6. 失败容忍单测
7. 输出格式示例(JSON 一条 + Markdown 一条)
8. 真实 fetch 烟测耗时
9. Scheduler 未触确认
10. 未完成项清单(逐条对照)
```

## 用户故事端到端预览

完成本 slice 后,用户的"每天 9 点收 AI 新闻"路径:

```
1. 用户发 NL: /schedule 每天早上9点收集前一天的AI科技新闻发给我
2. Slice 4 NL parser 解析 + 弹确认卡 → 用户点[确认创建]
3. Slice 2 落盘 job,prompt 是 LLM 解析出的:
   "请运行 `npm run news -- fetch --since yesterday --format markdown --limit 10` 拉取昨天的 AI 新闻,然后摘要前 5 条最重要的发给我"
4. Slice 1 node-cron 注册,每天 9 点触发
5. Slice 3 ScheduledRunner 创建 isolated session → AI 调用本 slice 的 news CLI → 拿到 markdown → AI summarize → 投递飞书
```
