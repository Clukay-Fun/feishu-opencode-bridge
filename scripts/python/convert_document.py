#!/usr/bin/env python3
"""
职责: 统一常见文件到 Markdown / 纯文本的转换协议。
关注点:
- 收口 PDF、DOCX、TXT/MD、HTML 和图片 OCR 的入口。
- 返回工具名、质量判断、fallback 链路和告警，便于 Node 侧诊断。
"""
from __future__ import annotations

from pathlib import Path
import re
import shutil
import subprocess

from common.io import read_json_stdin, write_error_stderr, write_json_stdout
from doc_to_text import extract_text
from pdf_to_markdown import convert as convert_pdf


TEXT_SUFFIXES = {".txt", ".md"}
HTML_SUFFIXES = {".html", ".htm"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}


def normalize_text(text: str) -> str:
    return re.sub(r"\n{3,}", "\n\n", text.replace("\r\n", "\n").replace("\x00", "")).strip()


def markdown_to_plain_text(markdown: str) -> str:
    text = re.sub(r"^#{1,6}\s*", "", markdown, flags=re.MULTILINE)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    return normalize_text(text)


def plain_text_to_markdown(text: str) -> str:
    lines = [line.strip() for line in text.replace("\r\n", "\n").splitlines()]
    blocks = [line for line in lines if line]
    return "\n\n".join(blocks).strip()


def strip_html(source: str) -> str:
    source = re.sub(r"<script\b[^>]*>[\s\S]*?</script>", " ", source, flags=re.IGNORECASE)
    source = re.sub(r"<style\b[^>]*>[\s\S]*?</style>", " ", source, flags=re.IGNORECASE)
    source = re.sub(r"</(?:p|div|section|article|li|tr|h[1-6])>", "\n", source, flags=re.IGNORECASE)
    source = re.sub(r"<br\s*/?>", "\n", source, flags=re.IGNORECASE)
    source = re.sub(r"<[^>]+>", " ", source)
    source = source.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
    return normalize_text(source)


def quality_for(text: str) -> str:
    length = len(text.strip())
    if length >= 200:
        return "high"
    if length >= 40:
        return "medium"
    return "low"


def convert_plain(input_path: Path) -> dict[str, object]:
    text = input_path.read_text(encoding="utf-8", errors="ignore")
    markdown = normalize_text(text)
    return {
        "markdown": markdown,
        "plainText": markdown_to_plain_text(markdown),
        "sourceFormat": input_path.suffix.lower().lstrip(".") or "text",
        "tool": "doc-to-text",
        "quality": quality_for(markdown),
        "fallbackChain": ["doc-to-text"],
        "warnings": [],
    }


def convert_docx(input_path: Path) -> dict[str, object]:
    text, fmt = extract_text(input_path)
    markdown = plain_text_to_markdown(text)
    return {
        "markdown": markdown,
        "plainText": normalize_text(text),
        "sourceFormat": fmt,
        "tool": "doc-to-text",
        "quality": quality_for(text),
        "fallbackChain": ["doc-to-text"],
        "warnings": [],
    }


def convert_html(input_path: Path) -> dict[str, object]:
    html = input_path.read_text(encoding="utf-8", errors="ignore")
    text = strip_html(html)
    return {
        "markdown": plain_text_to_markdown(text),
        "plainText": text,
        "sourceFormat": "html",
        "tool": "doc-to-text",
        "quality": quality_for(text),
        "fallbackChain": ["html-text"],
        "warnings": [],
    }


def convert_pdf_document(input_path: Path) -> dict[str, object]:
    markdown, method = convert_pdf(str(input_path))
    markdown = normalize_text(markdown)
    return {
        "markdown": markdown,
        "plainText": markdown_to_plain_text(markdown),
        "sourceFormat": "pdf",
        "tool": method,
        "quality": "high" if method == "pymupdf4llm" else quality_for(markdown),
        "fallbackChain": ["pymupdf4llm"] if method == "pymupdf4llm" else ["pymupdf4llm", "docling"],
        "warnings": [] if method == "pymupdf4llm" else ["PyMuPDF4LLM 未生成可用结果，已回退到 Docling"],
    }


def convert_image_ocr(input_path: Path, lang: str) -> dict[str, object]:
    tesseract = shutil.which("tesseract")
    if not tesseract:
        raise RuntimeError("image OCR requires tesseract CLI")
    output = subprocess.run(
        [tesseract, str(input_path), "stdout", "-l", lang],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=60,
    )
    if output.returncode != 0:
        raise RuntimeError(output.stderr.strip() or "tesseract OCR failed")
    text = normalize_text(output.stdout)
    if not text:
        raise RuntimeError("tesseract OCR produced no text")
    return {
        "markdown": plain_text_to_markdown(text),
        "plainText": text,
        "sourceFormat": input_path.suffix.lower().lstrip("."),
        "tool": "tesseract",
        "quality": quality_for(text),
        "fallbackChain": ["tesseract"],
        "warnings": [],
    }


def convert_document(input_path: Path, ocr_lang: str) -> dict[str, object]:
    suffix = input_path.suffix.lower()
    if suffix in TEXT_SUFFIXES:
        return convert_plain(input_path)
    if suffix in HTML_SUFFIXES:
        return convert_html(input_path)
    if suffix == ".docx":
        return convert_docx(input_path)
    if suffix == ".pdf":
        return convert_pdf_document(input_path)
    if suffix in IMAGE_SUFFIXES:
        return convert_image_ocr(input_path, ocr_lang)
    raise ValueError(f"unsupported file type: {suffix}")


def main() -> int:
    try:
        payload = read_json_stdin()
        input_path = Path(str(payload["inputPath"])).expanduser().resolve()
        if not input_path.exists():
            raise FileNotFoundError(f"input file not found: {input_path}")
        ocr_lang = str(payload.get("ocrLang") or "chi_sim+eng")
        write_json_stdout(convert_document(input_path, ocr_lang))
        return 0
    except Exception as exc:  # noqa: BLE001
        write_error_stderr(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
