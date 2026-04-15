import { spawn } from "node:child_process";
import path from "node:path";

export type PythonToolSuccess<T> = {
  ok: true;
  data: T;
};

export type PythonToolFailure = {
  ok: false;
  error: string;
};

export type PythonToolResult<T> = PythonToolSuccess<T> | PythonToolFailure;

type SpawnPythonToolOptions = {
  timeoutMs?: number | undefined;
  cwd?: string | undefined;
  pythonCommands?: string[] | undefined;
  scriptPath?: string | undefined;
};

export async function spawnPythonTool<T>(
  script: string,
  input: unknown,
  options?: SpawnPythonToolOptions,
): Promise<PythonToolResult<T>> {
  const scriptPath = options?.scriptPath ?? path.resolve(process.cwd(), "scripts/python", `${script}.py`);
  const pythonCommand = await resolvePythonCommand(options?.pythonCommands);
  if (!pythonCommand) {
    return { ok: false, error: "未找到可用的 Python 解释器" };
  }

  return await new Promise<PythonToolResult<T>>((resolve) => {
    const child = spawn(pythonCommand, [scriptPath], {
      cwd: options?.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({ ok: false, error: `Python 工具 ${script} 执行超时` });
    }, options?.timeoutMs ?? 60_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      settled = true;
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      settled = true;
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || stdout.trim() || `Python 工具 ${script} 执行失败（退出码 ${code ?? "unknown"}）` });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as T;
        resolve({ ok: true, data: parsed });
      } catch (error) {
        resolve({
          ok: false,
          error: error instanceof Error ? `Python 工具 ${script} 返回了无效 JSON：${error.message}` : `Python 工具 ${script} 返回了无效 JSON`,
        });
      }
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

export async function resolvePythonCommand(candidates?: string[]): Promise<string | null> {
  for (const command of dedupeCommands([
    ...(candidates ?? []),
    process.env.KNOWLEDGE_PDF_TO_MD_PYTHON,
    process.env.PYTHON,
    "python3",
    "python",
  ])) {
    const ok = await checkPythonCommand(command);
    if (ok) {
      return command;
    }
  }
  return null;
}

async function checkPythonCommand(command: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(command, ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function dedupeCommands(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}
