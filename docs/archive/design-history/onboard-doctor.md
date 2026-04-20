# onboard / doctor 最终方案

## 定位

| 入口 | 时机 | 职责 | 交互 |
|------|------|------|------|
| `npm run onboard` / 双击 `setup` | 首次 | 安装依赖 + 扫码创建应用 + 生成配置 | 引导式，自动执行可自动化的步骤 |
| `npm run doctor` | 排障 | 环境诊断报告 | 一次跑完，红绿标记 |
| `npm run dev` (preflight) | 每次启动 | 运行时连通性 | 不交互，失败直接退出 |

三者检查范围有意重叠但各自侧重。onboard/doctor 不替代 preflight，preflight 保持现有实现不动。

## 身份模型

```
一个飞书应用（lark-cli config init --new 自动创建，自带 bot 能力）
├── tenant_access_token → bridge 用
│   WebSocket 接收消息、bot 身份发消息/更新卡片
│   获取方式：appId + appSecret 直接换
│
└── user_access_token → lark-cli 用
    操作文档、多维表格、日历、任务
    获取方式：扫码 OAuth 授权
```

- bridge 是多用户的（应用身份），lark-cli 是单用户的（部署者个人身份）
- 当前定位：单人 / 信任小组使用
- 两种 token 独立，不互通，不代理

## 文件结构

```
scripts/
  setup.mjs             ← 主逻辑，跨平台，零 npm 依赖
  start.mjs             ← 主逻辑，跨平台
  checks.mjs            ← 共享检查函数
  onboard.mjs           ← npm run onboard（开发者入口，调用 checks）
  doctor.mjs            ← npm run doctor（开发者入口，调用 checks）
setup.command           ← macOS 双击入口
setup.bat               ← Windows 双击入口
start.command           ← macOS 双击入口
start.bat               ← Windows 双击入口
```

`package.json` 新增：

```json
{
  "onboard": "node scripts/onboard.mjs",
  "doctor": "node scripts/doctor.mjs"
}
```

所有脚本纯 ESM，只用 `fs`、`child_process`、`net`、`https` 内置模块。

## 平台入口

### macOS（setup.command）

```bash
#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node &>/dev/null; then
  echo "正在安装 Node.js ..."
  if command -v brew &>/dev/null; then
    brew install node@20
  else
    echo "请先安装 Node.js: https://nodejs.org"
    read -p "按回车退出"
    exit 1
  fi
fi
node scripts/setup.mjs
```

### Windows（setup.bat）

```batch
@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo 正在下载 Node.js 安装包 ...
  curl -o node-setup.msi https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi
  start /wait node-setup.msi
  del node-setup.msi
)
node scripts\setup.mjs
```

### macOS（start.command）

```bash
#!/bin/bash
cd "$(dirname "$0")"
node scripts/start.mjs
```

### Windows（start.bat）

```batch
@echo off
cd /d "%~dp0"
node scripts\start.mjs
```

## setup.mjs 流程

```
Feishu OpenCode Bridge — 首次安装

[1/5] 检查 Node.js
      ✓ Node.js v20.11.0

[2/5] 安装项目依赖
      正在执行 npm install ...
      ✓ 依赖安装完成

[3/5] 检查 OpenCode
      ├── 已安装 → ✓ opencode v0.1.0
      └── 未安装 → 提示安装命令，不自动执行

[4/5] 配置飞书应用
      检测 lark-cli ...
      ├── 未安装 → 提示安装，确认后自动安装
      └── 已安装 → 继续

      检测登录态 (lark-cli auth status) ...
      ├── 已登录 → 读取 appId，跳到生成配置
      └── 未登录或未配置 → 执行 lark-cli config init --new
          → 用户在浏览器扫码授权
          → 解析 JSON 输出，拿到 appId + appSecret
          → 自动执行 lark-cli auth login
          → 输出授权 URL，提示用户在浏览器打开
          → 脚本等待授权完成

      ✓ appId / appSecret 已获取

[5/5] 生成 config.json
      以 config.example.json 为模板
      替换 feishu.appId、feishu.appSecret
      其余字段保持默认值
      ✓ config.json 已生成

安装完成！
  启动方式：双击 start.command (macOS) 或 start.bat (Windows)
  开发模式：npm run dev
```

### 第 4 步细节

`lark-cli config init --new` 的输出格式：

```json
{
  "appId": "cli_a951d123c6791ceb",
  "appSecret": "明文secret",
  "brand": "feishu"
}
```

setup 脚本解析这个 JSON，直接拿到 appId 和 appSecret，不需要用户手动粘贴任何内容。

如果整个 lark-cli 路径走不通（用户拒绝安装），降级为手动输入：

```
无法自动配置飞书应用。
请手动填写以下信息（从 open.feishu.cn 获取）：

请输入 App ID: cli_xxxxx
请输入 App Secret: ********
```

### 已安装 lark-cli 但 config.json 已存在

如果 config.json 已存在，提示：

```
检测到 config.json 已存在，是否重新配置？[y/N]
```

默认不覆盖。

## start.mjs 流程

```
Feishu OpenCode Bridge

[1/3] 检查配置 ...            ✓ config.json
[2/3] 启动 OpenCode Server ... ✓ (后台运行，PID 12345)
[3/3] 启动 Bridge ...          ✓

服务已就绪。关闭此窗口或按 Ctrl+C 停止所有服务。
```

流程：

1. 读取 config.json，校验基本字段
2. 后台启动 `opencode serve`（工作目录 = 项目根目录）
   - stdout/stderr 重定向到 `logs/opencode.log`
   - 使用 `child_process.spawn` + `detached: true`（跨平台）
3. 等待 opencode health 可达（最多 10s，轮询间隔 1s）
4. 前台启动 bridge（`node dist/src/index.js` 或 `tsx src/index.ts`）
5. 注册 SIGINT/SIGTERM 处理，退出时 kill opencode 子进程

## 检查项

### checks.mjs 统一返回结构

```javascript
{ id, group, label, status, detail }
// status: "pass" | "fail" | "warn" | "skip"
// group: "bridge" | "lark"
```

### Bridge 组（必需）

| id | 检查内容 | pass 条件 | fail 提示 |
|---|---|---|---|
| `config-exists` | config.json 是否存在 | 文件存在 | `cp config.example.json config.json` |
| `config-feishu` | appId / appSecret 是否已填写 | 非空且不含 `your-` / `example` | 去飞书开放平台获取 |
| `config-opencode` | opencode.baseUrl 是否已填写 | 非空 | 提示填写 |
| `config-publicurl` | server.publicBaseUrl 是否已修改 | 不含 `example.com`；cardActions 未启用时 skip | warn：权限按钮需要公网回调 |
| `node-version` | Node.js >= 20 | `process.version` 满足 | 提示升级 |
| `deps-installed` | node_modules 是否存在 | 目录存在 | 提示 `npm install` |
| `opencode-bin` | opencode 命令是否可用 | `which opencode` 成功 | 提示安装 |
| `opencode-serve` | opencode serve 是否在运行 | `fetch(baseUrl/health)` 成功 | 提示 `opencode serve` |

`config-exists` 失败时，后续 `config-*` 项全部 skip。

### Lark 组（可选，不影响退出码）

| id | 检查内容 | pass 条件 | fail 提示 |
|---|---|---|---|
| `lark-bin` | lark-cli 命令是否可用 | `which lark-cli` 成功 | 提示安装方式 |
| `lark-version` | 版本 >= 1.0.8 | `lark-cli --version` 满足 | warn：建议升级 |
| `lark-auth` | 是否已登录 | `lark-cli auth status` 输出 `tokenStatus: "valid"` | 提示 `lark-cli auth login` |
| `lark-doctor` | lark-cli doctor 是否通过 | 退出码 0 | warn：显示摘要 |
| `lark-app-match` | lark-cli 的 appId 与 bridge config 一致 | `~/.lark-cli/config.json` 的 appId 与 config.json 的 `feishu.appId` 相同 | warn：身份可能不一致 |

`lark-bin` 失败时，后续 lark 项全部 skip。

### doctor 额外项

| id | 检查内容 |
|---|---|
| `build-exists` | dist/ 目录是否存在（生产部署） |
| `port-available` | config.server.port 是否被占用 |

## onboard.mjs vs doctor.mjs

| | onboard | doctor |
|---|---|---|
| 欢迎信息 | 有 | 无 |
| 操作指引 | 有，每条 fail 附带具体命令 | 无，只标红绿 |
| npm install | 检测到缺失时自动执行 | 只报告 |
| 退出码 | 0（引导完成）/ 1（有必需项未满足） | 0（全 pass）/ 1（有 fail） |
| lark 组影响退出码 | 不影响 | 不影响 |

两者共用 `checks.mjs` 的检查逻辑，各自包装输出格式。

## 输出格式

### onboard 示例

```
Feishu OpenCode Bridge — 环境引导

── Bridge 必需项 ──────────────────────────
 ✓ config.json
 ✓ feishu.appId / appSecret
 ✓ opencode.baseUrl
 - server.publicBaseUrl (跳过：cardActions 未启用)
 ✓ Node.js v20.11.0
 ✓ node_modules
 ✓ opencode 已安装
 ✗ opencode serve 未运行
   → opencode serve

── Lark Workflow (可选) ───────────────────
 ✓ lark-cli v1.0.8
 ✓ lark-cli 已登录 (房怡康)
 ✓ lark-cli appId 与 bridge 一致
 ✓ lark-cli doctor 通过

── 结果 ───────────────────────────────────
 必需项：7/8 通过，1 项需要处理
 可选项：4/4 通过

 处理完成后运行 start.command 或 npm run dev 启动。
```

### doctor 示例

```
── Bridge ─────────────────────────────────
 ✓ config.json
 ✓ feishu credentials
 ✓ opencode.baseUrl
 ✓ Node.js v20.11.0
 ✓ node_modules
 ✓ opencode binary
 ✓ opencode serve
 ✓ dist/ exists
 ✓ port 3000 available

── Lark ───────────────────────────────────
 ✓ lark-cli v1.0.8
 ✓ auth valid
 ✓ appId match
 ✓ doctor pass

9/9 bridge checks passed
4/4 lark checks passed
```

### 颜色

- `✓` 绿色 `\x1b[32m`
- `✗` 红色 `\x1b[31m`
- `-` 灰色 `\x1b[90m`
- 其余默认色
- 通过 `process.stdout.isTTY` 判断是否输出颜色

## 不做的事

- 不自动执行 `opencode serve`（长驻进程，用户控制启动方式和工作目录）
- `lark-cli auth login` 可自动执行（device code flow，脚本输出 URL 等待用户在浏览器扫码，非交互式）
- 不读取或转发任何 token / secret，只检查字段非空且非 placeholder
- 不引入任何 npm 依赖
- 不检查飞书 API 连通性（preflight 的职责）
- 不把 lark 组的 fail 算进退出码
- 不做多用户身份隔离（当前是单人/信任小组定位）
- 不替用户登录、不转发 token、不缓存凭证

## 关键发现（已确认）

| 项 | 结论 |
|---|---|
| 飞书应用创建 | `lark-cli config init --new` 自动创建，扫码完成 |
| appId / appSecret 获取 | `config init --new` 的 JSON 输出直接包含明文 appSecret |
| 创建的应用有无 bot 能力 | 有，自带 bot 能力 |
| auth status 输出格式 | JSON，`tokenStatus: "valid"` 判断登录态 |
| lark-cli 本地配置路径 | `~/.lark-cli/config.json`，appId 明文，appSecret 存 keychain |
| appSecret keychain 读取 | 不可行，lark-cli 用 master.key 加密，无公开解密接口 |
| WebSocket 能否用 user token | 不能，`WSClient` 只接受 appId + appSecret |
