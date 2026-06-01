/**
 * 职责: 把 Bridge runtime 日志过滤、格式化成终端 Activity 面板。
 * 关注点:
 * - 解析 `HH:MM:SS [scope] event_name { k="v" ... }` 格式日志行。
 * - 白名单过滤(turn / ws / error / kb / card / module / boot)。
 * - TTY 输出彩色单行,非 TTY 输出 JSON 行。
 * - 关联 turn.completed 和 cost/usage,把 cost 信息合并到 turn 完成行。
 * - 不引入第三方依赖,只用 Node 内置 + 裸 ANSI 转义。
 */
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";

const ANSI = {
  reset: "[0m",
  bold: "[1m",
  dim: "[2m",
  green: "[32m",
  red: "[31m",
  yellow: "[33m",
  blue: "[34m",
  magenta: "[35m",
  cyan: "[36m",
  grey: "[90m",
};

const c = {
  reset: () => ANSI.reset,
  bold: (v) => `${ANSI.bold}${v}${ANSI.reset}`,
  dim: (v) => `${ANSI.dim}${v}${ANSI.reset}`,
  green: (v) => `${ANSI.green}${v}${ANSI.reset}`,
  red: (v) => `${ANSI.red}${v}${ANSI.reset}`,
  yellow: (v) => `${ANSI.yellow}${v}${ANSI.reset}`,
  blue: (v) => `${ANSI.blue}${v}${ANSI.reset}`,
  cyan: (v) => `${ANSI.cyan}${v}${ANSI.reset}`,
  grey: (v) => `${ANSI.grey}${v}${ANSI.reset}`,
};

const noColor = {
  reset: () => "",
  bold: (v) => v,
  dim: (v) => v,
  green: (v) => v,
  red: (v) => v,
  yellow: (v) => v,
  blue: (v) => v,
  cyan: (v) => v,
  grey: (v) => v,
};

const LINE_REGEX = /^(\d\d:\d\d:\d\d)\s+\[([^\]]+)\]\s+(\S+(?:\s\S+)*?)\s*\{(.*)\}\s*$/;
const BRACKET_LEVEL_REGEX = /^\[(warn|error|info)\]:\s*(.*)$/;

/** 解析一行日志,返回 { ts, scope, name, fields, level } 或 null。 */
export function parseLogLine(rawLine) {
  if (!rawLine || typeof rawLine !== "string") return null;
  const line = stripAnsi(rawLine).trimEnd();
  if (!line) return null;

  const bracketMatch = BRACKET_LEVEL_REGEX.exec(line);
  if (bracketMatch) {
    return {
      ts: null,
      scope: "runtime",
      name: "log",
      level: bracketMatch[1],
      message: bracketMatch[2],
      fields: {},
    };
  }

  const match = LINE_REGEX.exec(line);
  if (!match) return null;

  const [, ts, scope, name, fieldsRaw] = match;
  return {
    ts,
    scope,
    name: name.trim(),
    fields: parseFields(fieldsRaw),
    level: "info",
  };
}

/** 解析字段串 `key="value" key=123 ...` → 对象。 */
function parseFields(raw) {
  const result = {};
  if (!raw || !raw.trim()) return result;
  // 简易词法:key=value(双引号包裹的) 或 key=非空白
  const fieldRegex = /(\w[\w.]*)=(?:"((?:[^"\\]|\\.)*)"|(\S+))/g;
  let m;
  while ((m = fieldRegex.exec(raw)) !== null) {
    const key = m[1];
    const value = m[2] !== undefined ? m[2] : m[3];
    result[key] = value;
  }
  return result;
}

function stripAnsi(s) {
  return s.replace(/\[[0-9;]*m/g, "");
}

/**
 * 决定一个 parsed event 是否进入 ticker。
 * 白名单:turn 完成 / WS 连接事件 / 错误警告 / 卡片回调 / 知识库入库 / 模块状态 / 启动期。
 */
export function shouldDisplay(event) {
  if (!event) return false;

  // 错误 / 警告
  if (event.level === "error") return true;
  if (event.level === "warn") return true;

  // turn 完成
  if (event.scope === "bridge/queue" && event.name === "turn.completed") return true;

  // 飞书 WS 连接事件
  if (event.scope === "feishu/ws" || event.scope === "feishu/connection") {
    if (/connection opened|reconnect|disconnect|closed/i.test(event.name)) return true;
  }

  // 卡片回调
  if (event.scope === "feishu/card" && /action|received/i.test(event.name)) return true;

  // 知识库入库
  if (event.scope === "knowledge/ingest") return true;

  // 模块状态降级 / 恢复
  if (event.scope === "runtime/modules" && /degrad|recover|loaded/i.test(event.name)) return true;

  // 启动期扩展加载
  if (event.scope.startsWith("extensions/") && /loaded|enabled/i.test(event.name)) return true;

  return false;
}

/**
 * 格式化为带颜色的单行字符串。
 * @param {object} event - parseLogLine 的输出 + 可选 cost 信息
 * @param {boolean} useColor
 */
export function formatEvent(event, useColor = true) {
  const co = useColor ? c : noColor;
  const ts = event.ts ?? new Date().toTimeString().slice(0, 8);
  const tsCol = co.grey(ts);

  // 错误
  if (event.level === "error") {
    return `${tsCol}  ${co.red("✗")}  ${co.red("ERROR")}    ${co.bold(event.scope ?? "")} ${event.message ?? event.name}`;
  }
  // 警告
  if (event.level === "warn") {
    const detail = event.message ?? event.name;
    return `${tsCol}  ${co.yellow("⚠")}  ${co.yellow("WARN")}     ${co.dim(event.scope ?? "")} ${detail}`;
  }

  // turn.completed
  if (event.scope === "bridge/queue" && event.name === "turn.completed") {
    const duration = event.fields.durationMs ? `${(Number(event.fields.durationMs) / 1000).toFixed(1)}s` : "?";
    const len = event.fields.replyLength ? `${event.fields.replyLength}字` : "";
    const chat = event.fields.chatId?.startsWith("oc_p2p_") ? "p2p" : event.fields.chatId?.startsWith("oc_") ? "chat" : "?";
    const sender = (event.fields.userId ?? "?").slice(0, 12);
    const tail = [duration, len].filter(Boolean).join(" · ");
    const head = `${tsCol}  ${co.green("✓")}  ${co.bold("turn")}     ${chat.padEnd(6)} ${co.dim(sender)}  ${co.dim(tail)}`;
    // Q / A 各占一行,每段 40 字截断,dim 色 + 12 空格缩进
    const userQ = truncatePreview(event.fields.userTextPreview, 40);
    const replyA = truncatePreview(event.fields.replyTextPreview, 40);
    const lines = [head];
    const indent = "            ";
    if (userQ) lines.push(`${indent}${co.dim("Q「" + userQ + "」")}`);
    if (replyA) lines.push(`${indent}${co.dim("A「" + replyA + "」")}`);
    return lines.join("\n");
  }

  // ws
  if (event.scope === "feishu/ws" || event.scope === "feishu/connection") {
    return `${tsCol}  ${co.cyan("↻")}  ${co.bold("ws")}       ${event.name}`;
  }

  // 卡片回调
  if (event.scope === "feishu/card") {
    const action = event.fields.action ?? event.fields.actionKind ?? "?";
    return `${tsCol}  ${co.blue("↗")}  ${co.bold("card")}     action ${action}`;
  }

  // 知识库入库
  if (event.scope === "knowledge/ingest") {
    const file = event.fields.fileName ?? event.fields.path ?? "?";
    const chunks = event.fields.chunks ? `${event.fields.chunks} chunks` : "";
    return `${tsCol}  ${co.cyan("📥")}  ${co.bold("kb")}       ${event.name}  ${co.dim(file)} ${co.dim(chunks)}`;
  }

  // 模块状态
  if (event.scope === "runtime/modules") {
    return `${tsCol}  ${co.yellow("⚠")}  ${co.bold("module")}   ${event.fields.moduleId ?? "?"} ${event.name}`;
  }

  // 扩展加载
  if (event.scope.startsWith("extensions/")) {
    return `${tsCol}  ${co.green("✓")}  ${co.bold("boot")}     ${event.scope} ${event.name}`;
  }

  // fallback
  return `${tsCol}  ${co.dim("·")}  ${co.dim(event.scope)} ${event.name}`;
}

/** 非 TTY 输出:JSON 行。 */
export function formatEventJson(event) {
  const base = {
    ts: event.ts ?? new Date().toISOString().slice(11, 19),
    scope: event.scope,
    name: event.name,
    level: event.level,
  };
  if (event.cost) base.cost = event.cost;
  if (event.message) base.message = event.message;
  // 只挑常用字段,不全量倾倒
  const picks = ["chatId", "userId", "turnId", "durationMs", "replyLength", "moduleId", "fileName", "chunks", "action", "userTextPreview", "replyTextPreview"];
  for (const k of picks) {
    if (event.fields?.[k] !== undefined) base[k] = event.fields[k];
  }
  return JSON.stringify(base);
}

/**
 * Activity Ticker:把日志行转成显示输出。
 * @param {object} options
 * @param {boolean} options.color - 是否着色(TTY 模式)
 * @param {boolean} options.json - 非 TTY JSON 模式
 * @param {function(string):void} options.emit - 输出回调
 */
export function createActivityTicker(options = {}) {
  const color = options.color !== false;
  const json = options.json === true;
  const emit = options.emit ?? ((line) => process.stdout.write(line + "\n"));
  const costBuffer = new Map();
  const COST_BUFFER_MAX = 100;

  return {
    /**
     * @returns 解析后的 event(被白名单接受时)或 null(未被接受 / 不可解析 / 是 cost 缓存)。
     *          调用方可基于返回值挂钩计数(如 dashboard 的 turn / error 计数)。
     */
    handle(rawLine) {
      const event = parseLogLine(rawLine);
      if (!event) return null;

      // 缓存 cost,等 turn.completed 时合并
      if (event.scope === "cost/usage" && /usage recorded/i.test(event.name)) {
        const cid = event.fields.correlationId ?? event.fields.turnId;
        if (cid) {
          costBuffer.set(cid, {
            estimatedCostCny: event.fields.estimatedCostCny,
            totalTokens: event.fields.totalTokens,
            provider: event.fields.provider,
            model: event.fields.model,
          });
          if (costBuffer.size > COST_BUFFER_MAX) {
            const firstKey = costBuffer.keys().next().value;
            costBuffer.delete(firstKey);
          }
        }
        return null;
      }

      if (!shouldDisplay(event)) return null;

      // turn.completed 合并 cost
      if (event.scope === "bridge/queue" && event.name === "turn.completed") {
        const cid = event.fields.correlationId ?? event.fields.turnId;
        if (cid && costBuffer.has(cid)) {
          event.cost = costBuffer.get(cid);
          costBuffer.delete(cid);
        }
      }

      const out = json ? formatEventJson(event) : formatEvent(event, color);
      emit(out);
      return event;
    },

    /**
     * 生成心跳字符串(uptime),不自己 emit——交给调用方决定怎么显示。
     * - sticky 模式:调用方用 \r\x1b[K 原地刷新
     * - JSON 模式:调用方 emit JSON 行
     * - 普通追加模式:调用方加 \n 后 emit
     */
    status({ uptimeSec }) {
      const co = color ? c : noColor;
      const ts = co.grey(new Date().toTimeString().slice(0, 8));
      if (json) {
        return JSON.stringify({
          ts: new Date().toISOString().slice(11, 19),
          scope: "ticker",
          name: "status",
          uptimeSec,
        });
      }
      const uptime = formatUptime(uptimeSec);
      return `${ts}  ${co.dim("·")}  ${co.dim("status")}   uptime ${co.bold(uptime)}`;
    },
  };
}

/** 安全截断文本预览,过长时加省略号。 */
function truncatePreview(value, maxChars) {
  if (!value || typeof value !== "string") return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
}

function formatUptime(sec) {
  if (sec < 60) return `${Math.floor(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

/**
 * 跨平台轮询式日志 tail。每 intervalMs 检查文件 size 增量,读新数据按行 emit。
 * @returns {{stop():void}}
 */
export function createLogTailer({ filePath, intervalMs = 500, onLine, startFromEnd = true, signal } = {}) {
  if (!filePath || typeof onLine !== "function") {
    throw new Error("filePath 和 onLine 是必填");
  }
  let lastSize = 0;
  let partialBuffer = "";
  let timer = null;
  let stopped = false;

  async function initPosition() {
    try {
      const stat = await fsp.stat(filePath);
      lastSize = startFromEnd ? stat.size : 0;
    } catch {
      lastSize = 0;
    }
  }

  async function poll() {
    if (stopped) return;
    try {
      const stat = await fsp.stat(filePath);
      if (stat.size < lastSize) {
        // 文件被截断或轮转,重置
        lastSize = 0;
        partialBuffer = "";
      }
      if (stat.size > lastSize) {
        const chunk = await readRange(filePath, lastSize, stat.size);
        lastSize = stat.size;
        const combined = partialBuffer + chunk;
        const lines = combined.split(/\r?\n/);
        partialBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line) onLine(line);
        }
      }
    } catch {
      // 文件暂未创建或读失败,下次重试
    }
    if (!stopped) {
      timer = setTimeout(poll, intervalMs);
    }
  }

  initPosition().then(() => {
    if (!stopped) {
      timer = setTimeout(poll, intervalMs);
    }
  });

  if (signal) {
    signal.addEventListener("abort", () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    });
  }

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Dashboard renderer:alt-screen 全屏模式,顶部 status panel + 活动区,每秒/事件全屏重绘。
 *
 * 操作时序:
 *   - enter():切到 alt screen + 隐藏光标,主屏不动
 *   - recordEvent(parsed):收到一个 ticker.handle 返回的 event,更新内部计数
 *   - pushEvent(line):把渲染好的事件 push 到活动缓冲(超出容量丢最早)
 *   - render():全屏重绘 panel + 活动区
 *   - leave():恢复光标 + 切回主屏(原终端历史完整恢复)
 *
 * 仅适用于 TTY + 彩色模式。代价:bridge 跑着时不能滚屏看历史(在 alt screen 内)。
 * 完整日志仍写 bridge-runtime.log,需要历史用 `tail -f` 看。
 *
 * @param {object} options
 * @param {boolean} [options.color=true]
 * @param {{endpoint:string, profile:string, extensions:string[], logPath:string, startedAt:Date}} options.panel
 * @param {NodeJS.WritableStream} [options.stdout=process.stdout]
 * @param {number} [options.activityCapacity=20]
 * @param {boolean} [options.hideCursor=true]
 */
export function createDashboardRenderer(options = {}) {
  const color = options.color !== false;
  const co = color ? c : noColor;
  const stdout = options.stdout ?? process.stdout;
  const capacity = options.activityCapacity ?? 20;
  const hideCursor = options.hideCursor !== false;
  const panel = options.panel ?? {};

  const state = {
    turnCount: 0,
    errorCount: 0,
    warnCount: 0,
    activity: [],
  };
  let entered = false;

  function enter() {
    if (entered) return;
    stdout.write("[?1049h"); // alt screen on
    if (hideCursor) stdout.write("[?25l");
    entered = true;
  }

  function leave() {
    if (!entered) return;
    if (hideCursor) stdout.write("[?25h");
    stdout.write("[?1049l"); // back to main
    entered = false;
  }

  function pushEvent(line) {
    state.activity.push(line);
    while (state.activity.length > capacity) state.activity.shift();
  }

  function recordEvent(parsed) {
    if (!parsed) return;
    if (parsed.scope === "bridge/queue" && parsed.name === "turn.completed") {
      state.turnCount++;
    } else if (parsed.level === "error") {
      state.errorCount++;
    } else if (parsed.level === "warn") {
      state.warnCount++;
    }
  }

  function render() {
    if (!entered) return;
    const startedMs = panel.startedAt instanceof Date ? panel.startedAt.getTime() : Date.now();
    const uptimeSec = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));

    const out = [];
    out.push("[H[2J[H"); // top-left + clear + top-left
    out.push("");
    out.push("═══════════════════════════════════════════════════════");
    out.push(`  ${co.bold("Feishu OpenCode Bridge")}`);
    out.push("═══════════════════════════════════════════════════════");
    out.push("");
    out.push(`  Status     ${co.green("● Running")}      ${co.dim("Uptime")} ${co.bold(formatUptime(uptimeSec))}`);
    out.push(`  Endpoint   ${panel.endpoint ?? "?"}`);
    out.push(
      `  Profile    ${panel.profile ?? "?"}` +
      `      ${co.dim("Turns")} ${co.bold(String(state.turnCount))}` +
      `   ${co.dim("Errors")} ${co.bold(String(state.errorCount))}` +
      `   ${co.dim("Warnings")} ${co.bold(String(state.warnCount))}`
    );
    if (panel.extensions && panel.extensions.length) {
      out.push("");
      const exts = panel.extensions.map((e) => `${co.green("●")} ${e}`).join("   ");
      out.push(`  Extensions ${exts}`);
    }
    out.push("");
    out.push(`  Logs       ${panel.logPath ?? "?"}`);
    out.push(`  Quit       Ctrl+C`);
    out.push("");
    out.push("───────────────────────────────────────────────────────");
    out.push(`  ${co.dim("Live activity (turns · ws · errors · kb · cards, last " + capacity + ")")}`);
    out.push("───────────────────────────────────────────────────────");
    out.push("");
    for (const line of state.activity) {
      out.push(line);
    }
    stdout.write(out.join("\n"));
  }

  return {
    enter,
    leave,
    render,
    pushEvent,
    recordEvent,
    getState: () => ({ ...state, activity: [...state.activity] }),
  };
}

/**
 * Sticky writer:把一行"心跳状态"钉在终端底部,事件在它上面滚,它原地刷新。
 * 用 ANSI \r\x1b[K 清当前行后重写,无需 scroll region 这种复杂招数。
 *
 * 调用流:
 *   - emit(line):事件来了 → 清 sticky → 输出 line+\n → 重画 sticky
 *   - setStatus(text):心跳更新 → 清 sticky → 存 text → 重画 sticky
 *   - cleanup():进程退出 → 清 sticky + 输出 \n,留干净 prompt
 *
 * 仅适用于 TTY。非 TTY(管道 / 重定向)请用普通 emit,不要走 sticky。
 *
 * @param {object} options
 * @param {NodeJS.WritableStream} options.stdout - 默认 process.stdout
 * @returns {{emit(line: string): void, setStatus(text: string): void, cleanup(): void}}
 */
export function createStickyWriter(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  let stickyText = "";
  let stickyVisible = false;

  function clearSticky() {
    if (stickyVisible) {
      stdout.write("\r\u001b[2K");
      stickyVisible = false;
    }
  }

  function drawSticky() {
    if (stickyText) {
      stdout.write(stickyText);
      stickyVisible = true;
    }
  }

  return {
    emit(line) {
      clearSticky();
      stdout.write(line + "\n");
      drawSticky();
    },
    setStatus(text) {
      clearSticky();
      stickyText = text;
      drawSticky();
    },
    cleanup() {
      clearSticky();
      stdout.write("\n");
    },
  };
}

async function readRange(filePath, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = fs.createReadStream(filePath, { start, end: end - 1, encoding: "utf-8" });
    stream.on("data", (data) => chunks.push(data));
    stream.on("end", () => resolve(chunks.join("")));
    stream.on("error", reject);
  });
}
