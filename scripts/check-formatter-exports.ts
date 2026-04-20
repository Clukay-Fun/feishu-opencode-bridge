import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

type FormatterExportSnapshot = {
  exports: string[];
};

const FORMATTER_PATH = path.resolve("src/feishu/formatter.ts");
const SNAPSHOT_PATH = path.resolve("docs/archive/design-history/formatter-export-snapshot.json");

async function main(): Promise<void> {
  const [sourceText, snapshotText] = await Promise.all([
    readFile(FORMATTER_PATH, "utf8"),
    readFile(SNAPSHOT_PATH, "utf8"),
  ]);

  const actual = collectNamedExports(sourceText);
  const snapshot = JSON.parse(snapshotText) as FormatterExportSnapshot;
  const expected = [...snapshot.exports].sort(compareNames);

  const added = actual.filter((name) => !expected.includes(name));
  const removed = expected.filter((name) => !actual.includes(name));

  if (added.length > 0 || removed.length > 0) {
    console.error("formatter.ts export surface changed.");
    if (added.length > 0) {
      console.error(`Added exports: ${added.join(", ")}`);
    }
    if (removed.length > 0) {
      console.error(`Removed exports: ${removed.join(", ")}`);
    }
    console.error(`Update ${path.relative(process.cwd(), SNAPSHOT_PATH)} only when the compatibility surface is intentionally changed.`);
    process.exitCode = 1;
  }
}

function collectNamedExports(sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(FORMATTER_PATH, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      continue;
    }

    for (const element of statement.exportClause.elements) {
      names.add(element.name.text);
    }
  }

  return [...names].sort(compareNames);
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
