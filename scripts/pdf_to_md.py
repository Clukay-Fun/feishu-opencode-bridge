#!/usr/bin/env python3
import sys
from pathlib import Path


def quality_ok(markdown: str) -> bool:
    lines = markdown.strip().splitlines()
    non_empty = [line for line in lines if line.strip()]
    if not non_empty:
        return False
    avg_len = sum(len(line) for line in non_empty) / len(non_empty)
    return avg_len >= 20 and len(non_empty) / max(len(lines), 1) >= 0.3


def convert_with_pymupdf4llm(pdf_path: str) -> str:
    import pymupdf4llm  # type: ignore

    return pymupdf4llm.to_markdown(pdf_path)


def convert_with_docling(pdf_path: str) -> str:
    from docling.document_converter import DocumentConverter  # type: ignore

    converter = DocumentConverter()
    result = converter.convert(pdf_path)
    return result.document.export_to_markdown()


def convert(pdf_path: str) -> tuple[str, str]:
    errors: list[str] = []

    try:
        markdown = convert_with_pymupdf4llm(pdf_path)
        if quality_ok(markdown):
            return markdown, "pymupdf4llm"
        errors.append("PyMuPDF4LLM 质量检查未通过")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"PyMuPDF4LLM 失败: {exc}")

    try:
        markdown = convert_with_docling(pdf_path)
        if markdown.strip():
            return markdown, "docling"
        errors.append("Docling 未生成 Markdown")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"Docling 失败: {exc}")

    raise RuntimeError("; ".join(errors))


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: pdf_to_md.py <input.pdf> <output.md>", file=sys.stderr)
        return 2

    input_path = Path(sys.argv[1]).expanduser().resolve()
    output_path = Path(sys.argv[2]).expanduser().resolve()

    if not input_path.exists():
        print(f"input file not found: {input_path}", file=sys.stderr)
        return 2

    markdown, parser_used = convert(str(input_path))
    markdown = markdown.strip()
    if not markdown:
        print("no markdown content generated", file=sys.stderr)
        return 1

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(markdown, encoding="utf-8")
    print(parser_used)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
