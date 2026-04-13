import { formatCheckHint, formatCheckLine, getDoctorExitCode, isMainModule, runAllChecks } from "./checks.mjs";

export async function runDoctor(options = {}) {
  const logger = options.logger ?? console;
  const results = await runAllChecks({
    cwd: options.cwd,
    env: options.env,
    includeDoctorExtras: true,
    includeLarkDoctor: true,
    runCommandFn: options.runCommandFn,
    findExecutableFn: options.findExecutableFn,
    fetchImpl: options.fetchImpl,
  });

  const bridge = results.filter((result) => result.group === "bridge");
  const lark = results.filter((result) => result.group === "lark");
  const memory = results.filter((result) => result.group === "memory");

  logger.log("### Bridge");
  for (const result of bridge) {
    logger.log(formatCheckLine(result));
    const hint = formatCheckHint(result);
    if (hint) {
      logger.log(hint);
    }
  }

  logger.log("");
  logger.log("### Lark");
  for (const result of lark) {
    logger.log(formatCheckLine(result));
    const hint = formatCheckHint(result);
    if (hint) {
      logger.log(hint);
    }
  }

  if (memory.length > 0) {
    logger.log("");
    logger.log("### Memory");
    for (const result of memory) {
      logger.log(formatCheckLine(result));
      const hint = formatCheckHint(result);
      if (hint) {
        logger.log(hint);
      }
    }
  }

  return getDoctorExitCode(results);
}

if (isMainModule(import.meta.url)) {
  try {
    const exitCode = await runDoctor();
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
