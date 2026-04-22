"""
职责: 提供 Python 辅助脚本共享的 JSON stdin/stdout 工具。
关注点:
- 统一 Node 与 Python 之间的轻量 IPC 协议。
"""
import json
import sys
from typing import Any


"""Read and parse a JSON payload from stdin."""
def read_json_stdin() -> Any:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("stdin JSON is empty")
    return json.loads(raw)


"""Write a JSON payload to stdout without ASCII escaping."""
def write_json_stdout(payload: Any) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


"""Write one normalized error line to stderr."""
def write_error_stderr(message: str) -> None:
    sys.stderr.write(message.strip() + "\n")
    sys.stderr.flush()
