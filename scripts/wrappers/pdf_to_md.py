#!/usr/bin/env python3
"""
职责: 转发 PDF 转 Markdown 请求到 scripts/python 下的真实实现。
关注点:
- 给外部调用保留稳定路径。
- 透传返回码和标准输出/错误。
"""
from pathlib import Path
import subprocess
import sys


"""Delegate to the Python PDF wrapper under `scripts/python`."""
def main() -> int:
    script_path = Path(__file__).resolve().parents[1].joinpath("python", "pdf_to_md.py")
    result = subprocess.run(
        [sys.executable, str(script_path), *sys.argv[1:]],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.stdout:
        sys.stdout.write(result.stdout.decode("utf-8", errors="ignore"))
    if result.stderr:
        sys.stderr.write(result.stderr.decode("utf-8", errors="ignore"))
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
