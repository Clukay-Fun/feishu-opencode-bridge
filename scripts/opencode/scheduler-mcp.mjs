#!/usr/bin/env node
/**
 * Minimal MCP server that exposes Bridge Scheduler capability to OpenCode.
 *
 * This tool is intentionally informational. Real task creation is owned by
 * Feishu OpenCode Bridge: users create jobs by sending natural language in
 * Feishu and confirming the Bridge card. Management stays on /cron commands.
 */

import readline from "node:readline";

const SERVER_NAME = "feishu-opencode-bridge-scheduler";
const PROTOCOL_VERSION = "2024-11-05";

const tools = [
  {
    name: "scheduler_help",
    description: [
      "Explain Feishu OpenCode Bridge scheduler capability.",
      "Use this when the user asks whether scheduling, reminders, delayed tasks, recurring tasks, or /cron management are available.",
      "This tool does not create jobs directly; Bridge creates jobs from Feishu natural language and confirmation cards.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The user's scheduling-related question or request.",
        },
      },
      additionalProperties: false,
    },
  },
];

function schedulerHelpText(question) {
  return [
    "Bridge scheduler is available.",
    "",
    "It is a Feishu OpenCode Bridge runtime capability, exposed through natural language and /cron management commands. It is not a native model timer.",
    "",
    "To create a task, the user should send natural language in Feishu. Bridge will intercept it before the normal OpenCode turn and show a confirmation card.",
    "",
    "Examples:",
    "- 1分钟后发个问候给我",
    "- 明天上午9点提醒我开会",
    "- 每天早上9点生成今日简报",
    "- 每周五下午5点总结本周工作",
    "",
    "Management commands:",
    "- /cron help",
    "- /cron list",
    "- /cron show <ID>",
    "- /cron pause <ID>",
    "- /cron resume <ID>",
    "- /cron run <ID>",
    "- /cron delete <ID>",
    "- /cron runs <ID>",
    "",
    question ? `User question: ${question}` : "",
  ].filter(Boolean).join("\n");
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function reject(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(request) {
  const { id, method, params } = request;

  if (method === "initialize") {
    respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: "0.1.0" },
    });
    return;
  }

  if (method === "tools/list") {
    respond(id, { tools });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    if (name !== "scheduler_help") {
      reject(id, -32602, `Unknown tool: ${name}`);
      return;
    }
    respond(id, {
      content: [
        {
          type: "text",
          text: schedulerHelpText(params?.arguments?.question),
        },
      ],
    });
    return;
  }

  if (id !== undefined && id !== null) {
    reject(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    void handle(JSON.parse(trimmed));
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});
