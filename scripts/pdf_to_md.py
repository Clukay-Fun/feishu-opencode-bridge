#!/usr/bin/env python3
from pathlib import Path
import subprocess
import sys


def main() -> int:
    script_path = Path(__file__).with_name("python").joinpath("pdf_to_md.py")
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
