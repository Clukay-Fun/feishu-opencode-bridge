# #73 V3 Portable 发布包审查报告

审查日期：2026-05-31

## 差距清单

| # | 项目 | 状态 | 决策 |
|---|------|------|------|
| 1 | 产物目录结构 | ✅ 已就绪 | dist/、bin/、scripts/runtime/、scripts/workspace-init/、模板配置、README |
| 2 | 敏感数据 exclude | ✅ 已修补 | 构建后自动 grep 校验 data/logs/config.json/.db/.env/.git |
| 3 | setup.command 调用 onboard 失效 | ✅ 已修补 | bridge.ts + bootstrap.mjs 加 `onboard → setup` alias |
| 4 | onboard/setup 双轨 | ✅ 已收口 | `setup` 是 canonical 命令，`onboard` 保留为别名 |
| 5 | start.command 无配置时引导 | ✅ 已修补 | 检测到无 config.json 自动进入 setup 向导 |
| 6 | scripts/workspace-init 缺失 | ✅ 已修补 | 构建 manifest 加入 `scripts/workspace-init` |
| 7 | Node runtime 打包 | ❌ 不做 | 继续由 install-node.sh 引导，文档说明 |
| 8 | Python OCR 工具链 | ❌ 不做 | 可选能力，doctor 检测缺失时给提示 |
| 9 | 跨平台 CI 矩阵 | ❌ 不做 | 单独 release engineering slice |
| 10 | 包大小 | ✅ 已就绪 | 3.7MB（未压缩）/ 644KB（tar.gz） |

## 包大小

- 未压缩目录：3.7MB
- tar.gz 归档：644KB

## Smoke test 记录

| 步骤 | 结果 | 耗时 |
|------|------|------|
| 解压到 /tmp | ✅ | <1s |
| bridge setup --help | ✅ | 1s |
| bridge setup（首次） | ✅ 触发 npm install | 22s |
| bridge help | ✅ 显示 setup 为主命令 | <1s |

## 命名收口

- `bridge.ts`：`onboard → setup` alias
- `bootstrap.mjs`：`setup → onboard` alias，help 文本显示 `bridge setup`
- `start.mjs`：错误消息更新为 `bridge setup`
- `setup.command`/`setup.bat`：保持调用 `bridge onboard`（通过 alias 转发）

## 验证

```
npm run typecheck    ✅
npm test             783/794 通过（11 个预存 Python 失败）
npm run release:portable  ✅ 敏感数据校验通过
```
