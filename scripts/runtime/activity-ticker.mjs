/**
 * 职责: 把 Bridge runtime 日志过滤、格式化成终端 Activity 面板。
 * 关注点:
 * - 解析 `HH:MM:SS [scope] event_name { k="v" ... }` 格式日志行。
 * - 白名单过滤(message / reply / turn / ws / error / kb / card / module / boot)。
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
const TURN_PREVIEW_CHARS = 140;
const MESSAGE_PREVIEW_CHARS = 220;
/** verbose 模式:显示所有 ID(session/turn/window/msg);默认隐藏。 */
const VERBOSE = process.env.BRIDGE_TICKER_VERBOSE === "1";

/** 剥离常见 Markdown 标记(粗体 / 斜体 / 删除线 / 行内代码 / 链接),保留纯文本。 */
export function stripMarkdown(text) {
  if (!text) return "";
  return String(text)
    .replace(/\*\*([^*]+)\*\*/g, "$1")     // **bold**
    .replace(/__([^_]+)__/g, "$1")           // __bold__
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")  // *italic*(避开 **)
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, "$1")      // _italic_
    .replace(/~~([^~]+)~~/g, "$1")           // ~~strike~~
    .replace(/`([^`]+)`/g, "$1")             // `code`
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1") // ![alt](url) -> alt
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")  // [text](url) -> text
    .replace(/^#{1,6}\s+/gm, "")             // # heading
    .replace(/^\s*[-*+]\s+/gm, "")           // - bullet
    .replace(/\s+/g, " ")
    .trim();
}

/** 智能截断:优先在句末标点,其次在词/标点边界,最后硬切。 */
export function smartTruncate(text, maxChars) {
  if (!text) return "";
  const cleaned = stripMarkdown(text);
  if (cleaned.length <= maxChars) return cleaned;

  const slice = cleaned.slice(0, maxChars);
  // 优先句末标点(60% 以内不接受)
  const sentenceEnd = Math.max(
    slice.lastIndexOf("。"),
    slice.lastIndexOf("！"),
    slice.lastIndexOf("？"),
    slice.lastIndexOf("."),
    slice.lastIndexOf("!"),
    slice.lastIndexOf("?"),
  );
  if (sentenceEnd >= maxChars * 0.6) {
    return cleaned.slice(0, sentenceEnd + 1);
  }
  // 次选词/中点标点
  const wordBoundary = Math.max(
    slice.lastIndexOf("，"),
    slice.lastIndexOf("、"),
    slice.lastIndexOf("；"),
    slice.lastIndexOf(","),
    slice.lastIndexOf(";"),
    slice.lastIndexOf(" "),
  );
  if (wordBoundary >= maxChars * 0.6) {
    return cleaned.slice(0, wordBoundary) + "…";
  }
  return cleaned.slice(0, maxChars - 1) + "…";
}

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
 * 白名单:对话摘要 / turn 完成 / WS 连接事件 / 错误警告 / 卡片回调 / 知识库入库 / 模块状态 / 启动期。
 */
export function shouldDisplay(event) {
  if (!event) return false;

  // 错误 / 警告
  if (event.level === "error") return true;
  if (event.level === "warn") return true;

  // turn 开始 / 完成 / 失败(turn.started 不渲染但 dashboard 用来跟踪 in-flight 心跳)
  if (event.scope === "bridge/queue" && (event.name === "turn.completed" || event.name === "turn.started" || event.name === "turn.failed")) return true;

  // 普通对话摘要
  if (event.scope === "bridge/message" && event.name === "inbound.received") return true;
  if (event.scope === "feishu/reply" && event.name === "transport.sent") {
    return event.fields.legacyEvent === "final message sent" || event.fields.legacyEvent === "fallback final message sent";
  }

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
export function formatEvent(event, useColor = true, lastChatContext = null) {
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

  // turn.started 只用于 dashboard 跟踪 in-flight,不渲染独立行
  if (event.scope === "bridge/queue" && event.name === "turn.started") {
    return "";
  }

  // turn.completed
  if (event.scope === "bridge/queue" && event.name === "turn.completed") {
    const duration = event.fields.durationMs ? `${(Number(event.fields.durationMs) / 1000).toFixed(1)}s` : "?";
    const len = event.fields.replyLength ? `${event.fields.replyLength}字` : "";
    const chatCtx = buildChatContext(event.fields, lastChatContext);
    const summary = [duration, len].filter(Boolean).join(" · ");
    const head = `${tsCol}  ${co.green("✓")}  ${co.bold("turn")}    ${chatCtx.chat} · ${co.dim(chatCtx.sender)}  ${co.dim(summary)}`;
    const replyA = smartTruncate(event.fields.replyTextPreview, TURN_PREVIEW_CHARS);
    const lines = [head];
    const indent = "            ";
    // 用户输入在 inbound.received 已展示过,turn.completed 只显示 bot 回复
    if (replyA) lines.push(`${indent}${co.green("◂")} ${replyA}`);
    // VERBOSE 模式才显示 IDs
    if (VERBOSE) {
      pushDetail(lines, co, "session", event.fields.sessionId);
      pushDetail(lines, co, "turn", event.fields.turnId);
      pushDetail(lines, co, "window", event.fields.conversationKey);
    }
    return lines.join("\n");
  }

  // 入站用户消息
  if (event.scope === "bridge/message" && event.name === "inbound.received") {
    const chatCtx = buildChatContext({ ...event.fields, userId: event.fields.senderId }, lastChatContext);
    const text = smartTruncate(event.fields.textPreview, MESSAGE_PREVIEW_CHARS);
    const kind = event.fields.messageType ?? "text";
    const lines = [`${tsCol}  ${co.cyan("▸")}  ${co.bold("user")}    ${chatCtx.chat} · ${co.dim(chatCtx.sender)}  ${co.dim(kind)}`];
    if (text) lines.push(`            ${`「${text}」`}`);
    if (VERBOSE) {
      pushDetail(lines, co, "msg", event.fields.messageId);
      pushDetail(lines, co, "window", event.fields.conversationKey);
    }
    return lines.join("\n");
  }

  // 出站最终回复或命令结果
  if (event.scope === "feishu/reply" && event.name === "transport.sent") {
    const chatCtx = buildChatContext(event.fields, lastChatContext);
    const kind = event.fields.payloadKind ?? "?";
    const text = smartTruncate(event.fields.textPreview, MESSAGE_PREVIEW_CHARS);
    const len = event.fields.len ? `${event.fields.len}字` : "";
    const lines = [`${tsCol}  ${co.green("◂")}  ${co.bold("bot")}     ${chatCtx.chat} · ${co.dim(chatCtx.sender)}  ${co.dim(`${kind} · ${len}`)}`];
    if (text) lines.push(`            ${`「${text}」`}`);
    if (VERBOSE) pushDetail(lines, co, "msg", event.fields.messageId);
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
  const picks = ["chatId", "chatType", "conversationKey", "threadKey", "senderId", "messageId", "userId", "turnId", "sessionId", "durationMs", "replyLength", "moduleId", "fileName", "chunks", "action", "userTextPreview", "replyTextPreview", "textPreview", "payloadKind", "legacyEvent"];
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
  // 上一次同类事件的 chat fingerprint,用于"↑同上"压缩
  let lastChatContext = null;
  const CHAT_CONTEXT_TTL_MS = 5 * 60 * 1000; // 5 分钟内才算"连续"
  let lastChatContextAt = 0;

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

      // chat context 过期重置(避免"↑同上"挂到 5 分钟前的别的对话)
      const now = Date.now();
      if (lastChatContext && now - lastChatContextAt > CHAT_CONTEXT_TTL_MS) {
        lastChatContext = null;
      }

      const out = json
        ? formatEventJson(event)
        : formatEvent(event, color, lastChatContext);

      // formatEvent 返回 "" 表示"流过但不渲染"(如 turn.started,仅供 dashboard 跟踪)
      if (out === "") {
        return event;
      }

      // 更新 lastChatContext 仅在涉及 chat 的事件类型
      const isChatEvent = (
        (event.scope === "bridge/queue" && event.name === "turn.completed") ||
        (event.scope === "bridge/message" && event.name === "inbound.received") ||
        (event.scope === "feishu/reply" && event.name === "transport.sent")
      );
      if (isChatEvent && event.fields) {
        const chat = formatChatLabel(event.fields.chatId, event.fields.chatType, event.fields.conversationKey);
        const sender = (event.fields.userId ?? event.fields.senderId ?? "?").slice(0, 12);
        lastChatContext = { fingerprint: `${chat}:${sender}` };
        lastChatContextAt = now;
      }

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

function pushDetail(lines, co, label, value) {
  if (!value) return;
  lines.push(`            ${co.dim(label.padEnd(7))} ${value}`);
}

/**
 * 构造 chat context:返回 { chat, sender, compact, current }。
 * compact=true 表示跟上一条同一 chat+sender,前端用"↑同上"占位。
 * current 是供调用方记录给下一次比较的 fingerprint。
 */
function buildChatContext(fields, lastChatContext) {
  const chat = formatChatLabel(fields.chatId, fields.chatType, fields.conversationKey);
  const sender = (fields.userId ?? fields.senderId ?? "?").slice(0, 12);
  const fingerprint = `${chat}:${sender}`;
  const compact = lastChatContext && lastChatContext.fingerprint === fingerprint;
  return { chat, sender, compact, fingerprint, current: { fingerprint } };
}

function formatChatLabel(chatId, chatType, conversationKey) {
  if (chatType === "p2p" || (typeof chatId === "string" && chatId.startsWith("oc_p2p_")) || (typeof conversationKey === "string" && conversationKey.endsWith(":main"))) return "p2p";
  if (chatType === "group" || chatType === "chat" || (typeof chatId === "string" && chatId.startsWith("oc_"))) return "chat";
  return "?";
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
  // 仍允许显式传 activityCapacity 作上限,但实际渲染容量按终端高度动态算
  const maxCapacity = options.activityCapacity ?? 100;
  const hideCursor = options.hideCursor !== false;
  const panel = options.panel ?? {};

  const state = {
    turnCount: 0,
    errorCount: 0,
    warnCount: 0,
    activity: [],            // 已完成事件的渲染行(每条可能多行)
    pendingTurns: new Map(), // turnId → { chatId, userId, startedAt }
  };
  let entered = false;
  let resizeHandler = null;

  function computePanelLines() {
    // 静态 panel 行数估算:7 + (扩展 2 行) + 4 行 logs/quit/sep = ~17
    return panel.extensions && panel.extensions.length ? 19 : 17;
  }

  function computeActivityBudget() {
    // 返回活动区可用"物理行数"(不是条目数),render 会按事件实际行数从后往前装填
    const rows = stdout.rows ?? 30;
    const panelLines = computePanelLines();
    const pendingLines = state.pendingTurns.size;
    return Math.max(3, rows - panelLines - pendingLines - 1);
  }

  function pickVisibleActivity(budgetLines) {
    // 每个事件可能多行,加 1 行空行分隔。从最新事件往前填,直到耗尽预算
    const out = [];
    let used = 0;
    for (let i = state.activity.length - 1; i >= 0; i--) {
      const entry = state.activity[i];
      const entryLines = entry.split("\n").length + 1; // +1 是事件间空行
      if (used + entryLines > budgetLines && out.length > 0) break;
      out.unshift(entry);
      used += entryLines;
    }
    return out;
  }

  function makeSeparator() {
    const cols = Math.max(20, (stdout.columns ?? 60) - 1);
    return "─".repeat(cols);
  }

  function makeHeader() {
    const cols = Math.max(20, (stdout.columns ?? 60) - 1);
    return "═".repeat(cols);
  }

  function enter() {
    if (entered) return;
    stdout.write("\u001b[?1049h");      // alt screen on
    if (hideCursor) stdout.write("\u001b[?25l");
    entered = true;
    // 监听 resize,屏幕变化时重画
    resizeHandler = () => render();
    stdout.on?.("resize", resizeHandler);
  }

  function leave() {
    if (!entered) return;
    if (resizeHandler && stdout.off) stdout.off("resize", resizeHandler);
    resizeHandler = null;
    if (hideCursor) stdout.write("\u001b[?25h");
    stdout.write("\u001b[?1049l");      // back to main
    entered = false;
  }

  function pushEvent(line) {
    state.activity.push(line);
    while (state.activity.length > maxCapacity) state.activity.shift();
  }

  function recordEvent(parsed) {
    if (!parsed) return;
    // 跟踪 in-flight turn(实时心跳用):turn.started → pending,turn.completed/failed → 移除
    const fields = parsed.fields ?? {};
    if (parsed.scope === "bridge/queue") {
      if (parsed.name === "turn.started" && fields.turnId) {
        state.pendingTurns.set(fields.turnId, {
          turnId: fields.turnId,
          chatId: fields.chatId,
          userId: fields.userId,
          conversationKey: fields.conversationKey,
          chatType: fields.chatType,
          startedAt: Date.now(),
        });
      } else if (parsed.name === "turn.completed" || parsed.name === "turn.failed") {
        state.turnCount++;
        if (fields.turnId) state.pendingTurns.delete(fields.turnId);
      }
    } else if (parsed.level === "error") {
      state.errorCount++;
    } else if (parsed.level === "warn") {
      state.warnCount++;
    }
  }

  function renderPendingTurn(p, now) {
    const elapsedSec = Math.floor((now - p.startedAt) / 1000);
    const chat = formatChatLabel(p.chatId, p.chatType, p.conversationKey);
    const sender = (p.userId ?? "?").slice(0, 12);
    const ts = new Date(p.startedAt).toTimeString().slice(0, 8);
    return `${co.grey(ts)}  ${co.yellow("⋯")}  ${co.bold("bot")}     ${chat} · ${co.dim(sender)}  ${co.dim(`${elapsedSec}s · processing`)}`;
  }

  function render() {
    if (!entered) return;
    const startedMs = panel.startedAt instanceof Date ? panel.startedAt.getTime() : Date.now();
    const now = Date.now();
    const uptimeSec = Math.max(0, Math.floor((now - startedMs) / 1000));
    const budget = computeActivityBudget();
    const visibleActivity = pickVisibleActivity(budget);
    const sep = makeSeparator();
    const hdr = makeHeader();

    const out = [];
    out.push("\u001b[H\u001b[2J\u001b[H"); // top-left + clear + top-left
    out.push("");
    out.push(hdr);
    out.push(`  ${co.bold("Feishu OpenCode Bridge")}`);
    out.push(hdr);
    out.push("");
    out.push(`  Status     ${co.green("● Running")}      Uptime ${co.bold(formatUptime(uptimeSec))}`);
    out.push(`  Endpoint   ${panel.endpoint ?? "?"}`);
    out.push(
      `  Profile    ${panel.profile ?? "?"}` +
      `      Turns ${co.bold(String(state.turnCount))}` +
      `   Errors ${co.bold(String(state.errorCount))}` +
      `   Warnings ${co.bold(String(state.warnCount))}` +
      (state.pendingTurns.size ? `   In-flight ${co.bold(String(state.pendingTurns.size))}` : "")
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
    out.push(sep);
    out.push(`  ${co.bold("Live activity")}`);
    out.push(sep);
    out.push("");
    for (let i = 0; i < visibleActivity.length; i++) {
      out.push(visibleActivity[i]);
      if (i < visibleActivity.length - 1) out.push("");
    }
    // 进行中的 turn(实时心跳):跟在活动区后面,每次重绘秒数往上跳
    for (const p of state.pendingTurns.values()) {
      out.push(renderPendingTurn(p, now));
    }
    stdout.write(out.join("\n"));
  }

  return {
    enter,
    leave,
    render,
    pushEvent,
    recordEvent,
    getState: () => ({ ...state, activity: [...state.activity], pendingTurns: new Map(state.pendingTurns) }),
  };
}

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
