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
from pdf_to_markdown import convert_with_docling, convert_with_pymupdf4llm, quality_ok
from ocr_provider import parse_with_mineru, parse_with_paddleocr, parse_with_paddleocr_aistudio


TEXT_SUFFIXES = {".txt", ".md"}
HTML_SUFFIXES = {".html", ".htm"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
EXTERNAL_PROVIDERS = {"mineru-agent", "paddleocr-vl", "paddleocr-vl-aistudio"}


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


def with_warning(result: dict[str, object], warnings: list[str], attempted: list[str]) -> dict[str, object]:
    chain = result.get("fallbackChain")
    result["fallbackChain"] = [*attempted, *[item for item in (chain if isinstance(chain, list) else []) if item not in attempted]]
    result["warnings"] = [*warnings, *[item for item in result.get("warnings", []) if isinstance(item, str)]]
    return result


def convert_local_pdf_document(input_path: Path) -> dict[str, object]:
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


def convert_pymupdf_pdf_document(input_path: Path) -> dict[str, object]:
    markdown = normalize_text(convert_with_pymupdf4llm(str(input_path)))
    if not quality_ok(markdown):
        raise RuntimeError("PyMuPDF4LLM quality check failed")
    return {
        "markdown": markdown,
        "plainText": markdown_to_plain_text(markdown),
        "sourceFormat": "pdf",
        "tool": "pymupdf4llm",
        "quality": "high",
        "fallbackChain": ["pymupdf4llm"],
        "warnings": [],
    }


def convert_docling_pdf_document(input_path: Path) -> dict[str, object]:
    markdown = normalize_text(convert_with_docling(str(input_path)))
    if not markdown:
        raise RuntimeError("Docling did not generate markdown")
    return {
        "markdown": markdown,
        "plainText": markdown_to_plain_text(markdown),
        "sourceFormat": "pdf",
        "tool": "docling",
        "quality": quality_for(markdown),
        "fallbackChain": ["docling"],
        "warnings": [],
    }


def convert_tesseract_image(input_path: Path, lang: str) -> dict[str, object]:
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


def run_provider(input_path: Path, provider: str, options: dict[str, object], ocr_lang: str) -> dict[str, object]:
    if provider == "mineru-agent":
        return parse_with_mineru(input_path, options)
    if provider == "paddleocr-vl":
        return parse_with_paddleocr(input_path, options)
    if provider == "paddleocr-vl-aistudio":
        return parse_with_paddleocr_aistudio(input_path, options)
    if provider == "pymupdf4llm":
        return convert_pymupdf_pdf_document(input_path)
    if provider == "docling":
        return convert_docling_pdf_document(input_path)
    if provider == "tesseract":
        return convert_tesseract_image(input_path, ocr_lang)
    raise RuntimeError(f"unsupported parser provider: {provider}")


def configured_provider_order(payload: dict[str, object], key: str, fallback: list[str]) -> list[str]:
    parser = payload.get("parser")
    if isinstance(parser, dict) and isinstance(parser.get(key), list):
        return [str(item) for item in parser[key] if str(item).strip()]
    return fallback


def provider_options(payload: dict[str, object], provider: str, ocr_lang: str) -> dict[str, object]:
    parser = payload.get("parser")
    parser_config = parser if isinstance(parser, dict) else {}
    base: dict[str, object] = {
        "ocrLang": parser_config.get("ocrLang") or ocr_lang,
        "timeoutMs": parser_config.get("timeoutMs") or 180_000,
        "pollIntervalMs": parser_config.get("pollIntervalMs") or 5_000,
        "maxPollMs": parser_config.get("maxPollMs") or 180_000,
    }
    if provider == "mineru-agent":
        mineru = parser_config.get("mineru") if isinstance(parser_config.get("mineru"), dict) else {}
        base.update(mineru)
    if provider == "paddleocr-vl":
        paddle = parser_config.get("paddleocr") if isinstance(parser_config.get("paddleocr"), dict) else {}
        base.update(paddle)
    if provider == "paddleocr-vl-aistudio":
        paddle = parser_config.get("paddleocrAiStudio") if isinstance(parser_config.get("paddleocrAiStudio"), dict) else {}
        base.update(paddle)
    return base


def provider_enabled(payload: dict[str, object], provider: str) -> tuple[bool, str | None]:
    parser = payload.get("parser")
    parser_config = parser if isinstance(parser, dict) else {}
    external_enabled = bool(parser_config.get("externalApiEnabled"))
    if provider in EXTERNAL_PROVIDERS and not external_enabled:
        return False, "externalApiEnabled=false"
    if provider == "mineru-agent":
        mineru = parser_config.get("mineru") if isinstance(parser_config.get("mineru"), dict) else {}
        if not bool(mineru.get("enabled")):
            return False, "mineru.enabled=false"
        if not mineru.get("apiKey"):
            return False, "mineru.apiKey missing"
    if provider == "paddleocr-vl":
        paddle = parser_config.get("paddleocr") if isinstance(parser_config.get("paddleocr"), dict) else {}
        if not bool(paddle.get("enabled")):
            return False, "paddleocr.enabled=false"
        if not paddle.get("apiKey") or not paddle.get("secretKey"):
            return False, "paddleocr.apiKey/secretKey missing"
    if provider == "paddleocr-vl-aistudio":
        paddle = parser_config.get("paddleocrAiStudio") if isinstance(parser_config.get("paddleocrAiStudio"), dict) else {}
        if not bool(paddle.get("enabled")):
            return False, "paddleocrAiStudio.enabled=false"
        if not paddle.get("token"):
            return False, "paddleocrAiStudio.token missing"
    return True, None


def convert_with_provider_order(input_path: Path, payload: dict[str, object], order: list[str], ocr_lang: str) -> dict[str, object]:
    warnings: list[str] = []
    attempted: list[str] = []
    for provider in order:
        enabled, reason = provider_enabled(payload, provider)
        if not enabled:
            warnings.append(f"{provider} skipped: {reason}")
            continue
        attempted.append(provider)
        try:
            return with_warning(run_provider(input_path, provider, provider_options(payload, provider, ocr_lang), ocr_lang), warnings, attempted)
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"{provider} failed: {exc}")
    raise RuntimeError("; ".join(warnings) or "no parser provider available")


def convert_document(input_path: Path, ocr_lang: str, payload: dict[str, object]) -> dict[str, object]:
    suffix = input_path.suffix.lower()
    if suffix in TEXT_SUFFIXES:
        return convert_plain(input_path)
    if suffix in HTML_SUFFIXES:
        return convert_html(input_path)
    if suffix == ".docx":
        return convert_docx(input_path)
    if suffix == ".pdf":
        return convert_with_provider_order(
            input_path,
            payload,
            configured_provider_order(payload, "pdfProviderOrder", ["pdf-parse", "pymupdf4llm", "docling", "paddleocr-vl-aistudio", "mineru-agent"]),
            ocr_lang,
        )
    if suffix in IMAGE_SUFFIXES:
        return convert_with_provider_order(
            input_path,
            payload,
            configured_provider_order(payload, "imageProviderOrder", ["paddleocr-vl-aistudio", "mineru-agent", "tesseract"]),
            ocr_lang,
        )
    raise ValueError(f"unsupported file type: {suffix}")


def main() -> int:
    try:
        payload = read_json_stdin()
        input_path = Path(str(payload["inputPath"])).expanduser().resolve()
        if not input_path.exists():
            raise FileNotFoundError(f"input file not found: {input_path}")
        ocr_lang = str(payload.get("ocrLang") or "chi_sim+eng")
        write_json_stdout(convert_document(input_path, ocr_lang, payload))
        return 0
    except Exception as exc:  # noqa: BLE001
        write_error_stderr(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
