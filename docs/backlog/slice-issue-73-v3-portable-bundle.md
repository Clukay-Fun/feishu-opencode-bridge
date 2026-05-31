# Slice: #73 V3 Portable 发布包(收口)

## 背景

Portable 包**基础设施大部分已经存在**:

- `scripts/release/build-portable.mjs`(180 行)已实现构建,有完整 `PORTABLE_PACKAGE_MANIFEST`
- `bin/bridge` / `bin/bridge.cmd` / `bin/bridge.ps1` 跨平台主启动器
- `bin/start.command` / `bin/start.bat` / `bin/setup.command` / `bin/setup.bat` 双击入口
- `scripts/runtime/portable.mjs`(146 行)运行时辅助
- `scripts/runtime/install-node.ps1` / `install-node.sh` Node 安装脚本
- 配置模板 `config.general.example.json` / `config.legal.example.json` 已在 manifest
- `package.json` 已注册 `"release:portable": "node scripts/release/build-portable.mjs"`

但有**至少一个已知 gap**:旧启动器 `setup.command` 调用 `bin/bridge onboard`,而我们 #70 完成的新 `bridge.ts` 命令是 `setup`(没有 `onboard`)。**双击 setup.command 会报"未知命令"**。

所以 V3 收口 slice 的核心不是从零造,而是**审查 + 命名收口 + 在干净环境烟测**。

## 目标

让 `npm run release:portable` 产出的包**真的能拿去 一台空机器解压双击启动**,完成首次配置后跑起来。

具体三件事:

1. **审查现有 portable 实现**,列出差距清单
2. **修补差距**——重点是 setup/onboard 命名收口
3. **在干净目录烟测**——验证整个用户流程

## 范围

### 包含

#### 1. 审查现有 portable 实现

跑一次构建,观察实际产物,出 audit checklist:

```bash
npm run release:portable
ls dist-portable/                   # 或实际输出目录
```

逐项确认:

- [ ] 产物目录结构(是否包含 dist/、scripts/runtime/、bin/、模板配置、README)
- [ ] **敏感数据 exclude**:`data/`、`logs/`、`config.json`、`.git/`、Obsidian 笔记、本地 memory.db 一律不在产物里
- [ ] 启动器是否真的能调用主入口
- [ ] Node runtime 是否打包(目前看不打包,要求用户自装 Node;或通过 `install-node.sh` 引导)
- [ ] 配置模板是否完整(general / legal)
- [ ] README 是否说明用户该怎么用

产出 `docs/backlog/issue-73-v3-audit-report.md`,5-10 项现状清单 + 每项决策(已就绪 / 需要修补 / 不做)。

#### 2. 修补关键差距

**必须修补**:

- **`setup.command` / `setup.bat` 调用 `bin/bridge onboard` 失效**:统一改为 `bin/bridge setup`(或反向把 `bridge.ts` 加 `onboard` 作为 `setup` 的 alias,保持向后兼容)
- **`scripts/runtime/onboard.mjs` 和 `bridge.ts setup` 双轨**:决定哪个是 canonical;另一个标 deprecated 或转发
- 首次启动自动跑 setup 向导(`start.command` 检测到无 config.json 时,先跑 setup)

**按需修补**(audit 结果决定):

- 敏感数据 exclude 规则补齐
- README 用户指南补全(首次配置三步走)
- Node 安装引导脚本可用性检查

#### 3. Clean-room 烟测

在 `/tmp` 下解压产物,模拟律所拿到 zip 的体验:

```bash
mkdir /tmp/bridge-clean && cd /tmp/bridge-clean
unzip /path/to/feishu-opencode-bridge-portable.zip
./bin/setup.command   # 或对应平台启动器
# 走完整流程:setup → 填 demo App ID/Secret → doctor → start
```

记录卡点,反哺步骤 2 的修补。

#### 4. 文档更新

- `docs/deploy.md`:加"portable 包用户三步走"小节(下载 / 解压 / 双击启动器)
- `README.md`:在显眼位置加 portable 包下载链接占位
- `scripts/release/README.md`(如有):更新构建命令说明

### 不包含

- **不引入** 新打包工具(pkg / bun compile / Node SEA / Tauri)
- **不重写** `build-portable.mjs` 整体结构(只补差距)
- **不打包** Node runtime 进 zip(继续由 `install-node.sh` 引导用户安装,或文档说明)
- **不打包** Python OCR 工具链(可选能力,doctor 检测缺失时给安装提示)
- **不实现** SaaS / 云托管形态(产品决策,超出本 slice)
- **不做** 跨平台 CI 矩阵自动构建(后续 release engineering slice)
- **不动** `src/runtime/` / `src/bridge/` 核心代码
- **不动** 业务模块(knowledge / contract / labor / case-workbench / memory)

### 行为规则

1. **敏感数据 zero-leak**:产物里**绝不**出现 `data/`、`logs/`、`config.json`(用户本地)、Obsidian 笔记、`*.db`、`.env`、`secrets.*`、`.git/`。每次构建结束必须 grep 验证。
2. **命名收口**:`setup` 是 canonical 命令名(已在 #70 落地)。`onboard` 要么作 alias 转发到 `setup`,要么从启动器移除。**不允许两套并存让用户困惑**。
3. **首次启动自动引导**:`start.command` 检测无 config.json 时,先弹 setup 而不是直接报错。
4. **错误带下一步**:启动器层报错(如 Node 未装)必须给 "下一步:运行 install-node.sh" 之类的提示,不允许只 echo error。
5. **不打包 native 二进制跨平台分发**:`better-sqlite3` 等原生模块**每个平台单独构建**,产物按平台分(`portable-darwin-arm64.zip` / `portable-win-x64.zip` 等)。
6. **smoke test 必须真跑**:不允许"读代码觉得能跑"就过。必须在 clean 目录走完 setup → start 的完整路径。

## 实现步骤

### 步骤 1:跑 audit

```bash
npm run release:portable
ls -R dist-portable/ | head -80          # 看产物结构
du -sh dist-portable/                     # 包大小
find dist-portable/ -name "*.db" -o -name "*.log" -o -name "config.json" -o -name ".env"
                                          # 必须无输出
```

产出 audit report 列差距清单。

### 步骤 2:命名收口

定位所有 `onboard` 引用:

```bash
grep -rn "onboard\|bridge.*onboard" bin/ scripts/runtime/ scripts/release/
```

按决策修补:

- 推荐方案 A:`bridge.ts` 加 `case "onboard"` 转发到 setup,启动器无需改
- 备选方案 B:启动器统一改为 `bin/bridge setup`,`onboard.mjs` 标 deprecated

### 步骤 3:首次启动自动引导

修改 `bin/start.command` / `bin/start.bat`:

```bash
if [ ! -f "$ROOT/config.json" ] && [ ! -f "$BRIDGE_HOME/config.json" ]; then
  echo "首次启动,先运行配置向导..."
  exec "$ROOT/bin/bridge" setup
fi
exec "$ROOT/bin/bridge" start
```

### 步骤 4:敏感数据 exclude 校验

在 `build-portable.mjs` 末尾加构建后校验:

```js
const forbidden = ["data/", "logs/", "config.json", ".env", ".git/", "*.db"];
for (const pattern of forbidden) {
  if (await findInOutput(pattern)) throw new Error(`产物泄漏: ${pattern}`);
}
```

### 步骤 5:Clean-room smoke test

```bash
# 1. 构建
npm run release:portable
# 2. 解压到 /tmp 干净目录
mkdir -p /tmp/bridge-smoke && tar -xf dist-portable/*.tar.gz -C /tmp/bridge-smoke
# 3. 模拟用户跑首次启动
cd /tmp/bridge-smoke && ./bin/setup.command --feishu-app-id=test --feishu-app-secret=test
# 4. doctor
./bin/bridge doctor
# 5. 验证 config 写到位、敏感数据未泄漏
```

记录每步耗时和卡点。

### 步骤 6:文档

- `docs/deploy.md` 加"portable 包三步走"
- `README.md` 加下载占位
- `docs/backlog/issue-73-v3-audit-report.md`(步骤 1 产物)

## 验收标准

- [ ] `npm run release:portable` 成功输出 portable 包
- [ ] 产物**不含** `data/` / `logs/` / `config.json` / `*.db` / `.env` / `.git/` / Obsidian 笔记
- [ ] 产物含 dist/、bin/、scripts/runtime/、config.general.example.json、config.legal.example.json、README
- [ ] `setup.command` / `setup.bat` 双击能进入向导(命名收口完成)
- [ ] `start.command` 检测无 config 时自动跑 setup
- [ ] Clean-room smoke test 完整跑通:解压 → setup → doctor → start
- [ ] `docs/deploy.md` 有用户三步走指南
- [ ] `docs/backlog/issue-73-v3-audit-report.md` 存在,列出现状差距和决策
- [ ] core 主流程 git diff 为空(`src/runtime/` / `src/bridge/`)
- [ ] 业务模块 git diff 为空
- [ ] 无新打包工具依赖(pkg / bun / SEA / Tauri)
- [ ] typecheck + 全量测试通过
- [ ] **未完成项清单**显式列出(若 audit 决定不做某项,在清单写明)

## 验证命令

```bash
npm run typecheck
npm test
npm run release:portable

# 敏感数据校验
find dist-portable/ \( -name "*.db" -o -name "*.log" -o -name "config.json" -o -name ".env" \) | wc -l   # 应为 0
find dist-portable/ -path "*/data/*" -o -path "*/logs/*" -o -path "*/.git/*" | wc -l                       # 应为 0

# Clean-room smoke test(在 /tmp 下跑)
# 见步骤 5

# 核心未触
git diff src/runtime/ src/bridge/ src/feishu/ src/knowledge/ src/contract-assistant/ src/labor/ 2>/dev/null   # 应为空
```

## 给执行 Agent 的硬约束

1. **不引入新打包工具**。继续用 zip / tar.gz 目录形态。pkg / bun compile / Node SEA / Tauri / Electron 一律不引入。
2. **不打包 Node 二进制**。继续靠 `install-node.sh` / `install-node.ps1` 引导,或文档明确说明。
3. **敏感数据 zero-leak 是硬约束**。构建后必须 grep 校验,泄漏必须 fail build。
4. **命名收口必须做**——onboard 和 setup 不允许两套并存让用户困惑。
5. **smoke test 必须真跑**——不允许"读代码觉得能跑"。
6. **不动 core 主流程 / 业务模块**——本 slice 范围严格在 `bin/` / `scripts/release/` / `scripts/runtime/` / `docs/`。
7. **不实现 SaaS / 云托管形态**——产品决策,超出范围。
8. **失败提示必须可读**——启动器报错给"下一步"建议,不允许只 echo error。
9. **完成总结里"未完成项清单"必须扫整份汇报**。任何 section 出现"未 / 但 / 暂未 / 以备后续"等字眼都必须在清单显式重复声明。

## 完成总结模板

```
1. 跑的验证命令 + 输出(含 smoke test 输出)
2. 变更文件清单(应在 bin/ + scripts/release/ + scripts/runtime/ + docs/)
3. audit report 摘要(差距清单 + 决策)
4. 命名收口方案(A 或 B,以及实际改了哪些文件)
5. 首次启动自动引导验证位置
6. 敏感数据 exclude 校验代码位置 + 校验输出
7. smoke test 完整流程记录(每步耗时 / 卡点 / 通过否)
8. 包大小(bytes)
9. 文档更新点(deploy.md / README.md / audit report)
10. core / 业务模块未触确认(git diff 输出空)
11. **未完成项清单**:逐条对照"包含"章节,凡未实现的子项必须显式列出,无则写"无"
```

## 完成后的状态

- **#73 issue 完整闭环可 close**(V1 ✅ + V2 ✅ + V3 ✅)
- 内部团队 + 外部律所装机门槛大幅降低
- portable 包形态稳定,后续 release engineering(如 CI 自动构建跨平台矩阵)单独 slice 跟踪
- 真正的"单 .exe"和"SaaS 形态"都是 follow-up 候选,不阻塞本 slice
