import json
import sys
from typing import Any


def read_json_stdin() -> Any:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("stdin JSON is empty")
    return json.loads(raw)


def write_json_stdout(payload: Any) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def write_error_stderr(message: str) -> None:
    sys.stderr.write(message.strip() + "\n")
    sys.stderr.flush()
