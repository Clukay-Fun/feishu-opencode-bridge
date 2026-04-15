#!/usr/bin/env python3
import re
from pathlib import Path

from docx import Document  # type: ignore

from common.io import read_json_stdin, write_error_stderr, write_json_stdout

CLAUSE_PATTERNS = [
    re.compile(r"^第[一二三四五六七八九十百零〇\d]+条"),
    re.compile(r"^[一二三四五六七八九十]+、"),
    re.compile(r"^\d+(?:\.\d+)+"),
]


def read_docx_paragraphs(input_path: Path) -> list[str]:
    document = Document(str(input_path))
    return [paragraph.text.strip() for paragraph in document.paragraphs if paragraph.text.strip()]


def is_clause_start(line: str) -> bool:
    return any(pattern.search(line) for pattern in CLAUSE_PATTERNS)


def split_clause_heading(line: str) -> tuple[str, str]:
    for pattern in CLAUSE_PATTERNS:
        match = pattern.search(line)
        if match:
            number = match.group(0).strip()
            title = line[match.end():].strip(" ：:　")
            return number, title or "未命名条款"
    return "", line.strip() or "未命名条款"


def infer_parties(lines: list[str]) -> dict:
    parties: dict[str, str] = {}
    for line in lines:
        if "聘请方（甲方）" in line or line.startswith("甲方："):
            parties.setdefault("clientName", line.split("：", 1)[-1].strip() or "【待补】")
        elif line.startswith("对方："):
            parties.setdefault("counterpartyName", line.split("：", 1)[-1].strip() or "【待补】")
        elif "受聘方（乙方）" in line:
            parties.setdefault("agencyName", line.split("：", 1)[-1].strip() or "【待补】")
        elif "承办律师" in line:
            parties.setdefault("leadLawyer", line.split("：", 1)[-1].strip() or "【待补】")
    return parties


def infer_title(lines: list[str], input_path: Path) -> str:
    for line in lines[:20]:
        if "合同" in line:
            return line
    return input_path.stem


def parse_contract(lines: list[str], input_path: Path) -> dict:
    title = infer_title(lines, input_path)
    parties = infer_parties(lines)
    raw_text = "\n".join(lines)
    clauses: list[dict] = []
    appendices: list[dict] = []

    current_clause: dict | None = None
    appendix_mode = False
    appendix_lines: list[str] = []

    for line in lines:
        if "风险代理告知书" in line or line.startswith("附件"):
            appendix_mode = True
        if appendix_mode:
            appendix_lines.append(line)
            continue
        if is_clause_start(line):
            if current_clause:
                clauses.append(current_clause)
            number, title_text = split_clause_heading(line)
            current_clause = {
                "id": f"clause-{len(clauses) + 1}",
                "number": number or f"第{len(clauses) + 1}条",
                "title": title_text,
                "content": "",
            }
            continue
        if current_clause:
            current_clause["content"] = f"{current_clause['content']}\n{line}".strip()

    if current_clause:
        clauses.append(current_clause)

    if appendix_lines:
        appendices.append({
            "id": "appendix-1",
            "title": appendix_lines[0],
            "content": "\n".join(appendix_lines[1:]).strip(),
        })

    source_mode_hint = "template_upload" if any("【" in line or "___" in line or "______" in line for line in lines) else "existing_contract_upload"
    return {
        "title": title,
        "parties": parties,
        "clauses": clauses,
        "appendices": appendices,
        "rawText": raw_text,
        "sourceModeHint": source_mode_hint,
    }


def main() -> int:
    try:
        payload = read_json_stdin()
        input_path = Path(str(payload["inputPath"])).expanduser().resolve()
        if not input_path.exists():
            raise FileNotFoundError(f"input file not found: {input_path}")
        if input_path.suffix.lower() != ".docx":
            raise ValueError("contract_parse 目前仅支持 .docx 文件")
        lines = read_docx_paragraphs(input_path)
        write_json_stdout(parse_contract(lines, input_path))
        return 0
    except Exception as exc:  # noqa: BLE001
        write_error_stderr(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
