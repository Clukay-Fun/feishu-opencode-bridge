/**
 * 职责: 覆盖Python OCR provider 调用与错误处理。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { spawnPythonTool } from "../src/utils/python-tool.js";

describe("ocr_provider python tool", () => {
  it("runs the MinerU signed upload flow and returns markdown", async () => {
    await withMockServer(async ({ baseUrl, requests }) => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "ocr-mineru-"));
      try {
        const inputPath = path.join(tempDir, "scan.pdf");
        await writeFile(inputPath, "fake-pdf");

        const result = await spawnPythonTool<{
          markdown: string;
          tool: string;
          fallbackChain: string[];
        }>("ocr_provider", {
          provider: "mineru-agent",
          inputPath,
          options: {
            endpoint: `${baseUrl}/mineru`,
            pollIntervalMs: 100,
            maxPollMs: 1_000,
          },
        });

        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }
        expect(result.data.markdown).toBe("# MinerU\n\n扫描文本");
        expect(result.data.tool).toBe("mineru-agent");
        expect(result.data.fallbackChain).toEqual(["mineru-agent"]);
        expect(requests.map((item) => item.methodPath)).toEqual([
          "POST /mineru/parse/file",
          "PUT /upload/mineru",
          "GET /mineru/parse/task-1",
          "GET /mineru/full.md",
        ]);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  it("runs the PaddleOCR-VL task flow and returns markdown", async () => {
    await withMockServer(async ({ baseUrl, requests }) => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "ocr-paddle-"));
      try {
        const inputPath = path.join(tempDir, "scan.png");
        await writeFile(inputPath, "fake-png");

        const result = await spawnPythonTool<{
          markdown: string;
          tool: string;
          fallbackChain: string[];
        }>("ocr_provider", {
          provider: "paddleocr-vl",
          inputPath,
          options: {
            apiKey: "key",
            secretKey: "secret",
            oauthEndpoint: `${baseUrl}/oauth/token`,
            submitEndpoint: `${baseUrl}/paddle/task`,
            queryEndpoint: `${baseUrl}/paddle/query`,
            pollIntervalMs: 100,
            maxPollMs: 1_000,
          },
        });

        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }
        expect(result.data.markdown).toBe("# Paddle\n\n图片文本");
        expect(result.data.tool).toBe("paddleocr-vl");
        expect(result.data.fallbackChain).toEqual(["paddleocr-vl"]);
        expect(requests.map((item) => item.methodPath)).toEqual([
          "GET /oauth/token",
          "POST /paddle/task",
          "POST /paddle/query",
          "GET /paddle/full.md",
        ]);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});

async function withMockServer(
  run: (context: { baseUrl: string; requests: Array<{ methodPath: string; body: string }> }) => Promise<void>,
): Promise<void> {
  const requests: Array<{ methodPath: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const methodPath = `${request.method ?? "GET"} ${url.pathname}`;
    requests.push({ methodPath, body });
    routeMockRequest(methodPath, response, `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock server did not bind to a TCP port");
  }
  try {
    await run({ baseUrl: `http://127.0.0.1:${address.port}`, requests });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function routeMockRequest(methodPath: string, response: ServerResponse, baseUrl: string): void {
  if (methodPath === "POST /mineru/parse/file") {
    writeJson(response, {
      code: 0,
      msg: "ok",
      data: {
        task_id: "task-1",
        file_url: `${baseUrl}/upload/mineru`,
      },
    });
    return;
  }
  if (methodPath === "PUT /upload/mineru") {
    response.writeHead(200);
    response.end("ok");
    return;
  }
  if (methodPath === "GET /mineru/parse/task-1") {
    writeJson(response, {
      code: 0,
      msg: "ok",
      data: {
        task_id: "task-1",
        state: "done",
        markdown_url: `${baseUrl}/mineru/full.md`,
      },
    });
    return;
  }
  if (methodPath === "GET /mineru/full.md") {
    response.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    response.end("# MinerU\n\n扫描文本");
    return;
  }
  if (methodPath === "GET /oauth/token") {
    writeJson(response, { access_token: "token-1" });
    return;
  }
  if (methodPath === "POST /paddle/task") {
    writeJson(response, {
      error_code: 0,
      error_msg: "",
      result: { task_id: "task-2" },
    });
    return;
  }
  if (methodPath === "POST /paddle/query") {
    writeJson(response, {
      error_code: 0,
      error_msg: "",
      result: {
        task_id: "task-2",
        status: "success",
        markdown_url: `${baseUrl}/paddle/full.md`,
      },
    });
    return;
  }
  if (methodPath === "GET /paddle/full.md") {
    response.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    response.end("# Paddle\n\n图片文本");
    return;
  }
  response.writeHead(404);
  response.end("not found");
}

function writeJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
