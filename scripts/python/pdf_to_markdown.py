#!/usr/bin/env python3
"""
职责: 将 PDF 转成 Markdown，并在多个解析后端之间做降级切换。
关注点:
- 优先尝试结构更好的 PDF 转 Markdown 方案。
- 对结果做最小质量检查，避免输出明显失真的文本。
"""
from pathlib import Path

from common.io import read_json_stdin, write_error_stderr, write_json_stdout


"""Check whether generated markdown looks dense enough to be useful."""
def quality_ok(markdown: str) -> bool:
    lines = markdown.strip().splitlines()
    non_empty = [line for line in lines if line.strip()]
    if not non_empty:
        return False
    avg_len = sum(len(line) for line in non_empty) / len(non_empty)
    return avg_len >= 20 and len(non_empty) / max(len(lines), 1) >= 0.3


"""Convert PDF with PyMuPDF4LLM for higher-fidelity markdown output."""
def convert_with_pymupdf4llm(pdf_path: str) -> str:
    import pymupdf4llm  # type: ignore

    return pymupdf4llm.to_markdown(pdf_path)


"""Convert PDF with Docling as the fallback backend."""
def convert_with_docling(pdf_path: str) -> str:
    from docling.document_converter import DocumentConverter  # type: ignore

    converter = DocumentConverter()
    result = converter.convert(pdf_path)
    return result.document.export_to_markdown()


"""Try supported backends in order and return the first acceptable result."""
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


"""Read JSON input, convert the target PDF, and emit JSON output."""
def main() -> int:
    try:
        payload = read_json_stdin()
        input_path = Path(str(payload["inputPath"])).expanduser().resolve()
        if not input_path.exists():
            raise FileNotFoundError(f"input file not found: {input_path}")
        markdown, method = convert(str(input_path))
        markdown = markdown.strip()
        if not markdown:
            raise RuntimeError("no markdown content generated")
        write_json_stdout({
            "markdown": markdown,
            "method": method,
            "pageCount": None,
        })
        return 0
    except Exception as exc:  # noqa: BLE001
        write_error_stderr(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
