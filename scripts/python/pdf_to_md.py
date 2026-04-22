#!/usr/bin/env python3
"""
职责: 提供兼容旧调用方式的 PDF 转 Markdown 包装入口。
关注点:
- 以命令行参数形式接收输入/输出路径。
- 复用 JSON stdin/stdout 版本的核心转换脚本。
"""
from pathlib import Path
import subprocess
import sys


"""Translate argv-style invocation into the JSON contract used by the core converter."""
def main() -> int:
    if len(sys.argv) != 3:
        print("usage: pdf_to_md.py <input.pdf> <output.md>", file=sys.stderr)
        return 2

    script_path = Path(__file__).with_name("pdf_to_markdown.py")
    input_path = Path(sys.argv[1]).expanduser().resolve()
    output_path = Path(sys.argv[2]).expanduser().resolve()

    payload = '{"inputPath": "%s"}' % str(input_path).replace("\\", "\\\\")
    result = subprocess.run(
        [sys.executable, str(script_path)],
        input=payload.encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr.decode("utf-8", errors="ignore"))
        return result.returncode

    import json

    parsed = json.loads(result.stdout.decode("utf-8"))
    markdown = str(parsed.get("markdown") or "").strip()
    method = str(parsed.get("method") or "").strip()
    if not markdown:
        print("no markdown content generated", file=sys.stderr)
        return 1
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(markdown, encoding="utf-8")
    print(method)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
