#!/usr/bin/env python3
import json
from pathlib import Path
import subprocess
import sys


def main() -> int:
    parser_compatible = len(sys.argv) == 5 and sys.argv[1] == "--state" and sys.argv[3] == "--output"
    if not parser_compatible:
        print("usage: render_contract.py --state <state.json> --output <output.docx>", file=sys.stderr)
        return 2

    state_path = Path(sys.argv[2]).expanduser().resolve()
    output_path = Path(sys.argv[4]).expanduser().resolve()
    if not state_path.exists():
        print(f"state file not found: {state_path}", file=sys.stderr)
        return 2

    payload = {
        "state": json.loads(state_path.read_text(encoding="utf-8")),
        "outputPath": str(output_path),
    }
    script_path = Path(__file__).with_name("contract_render.py")
    result = subprocess.run(
        [sys.executable, str(script_path)],
        input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
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
