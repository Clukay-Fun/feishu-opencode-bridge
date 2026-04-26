#!/usr/bin/env python3
"""
职责: DOCX XML/ZIP 级编辑能力 PoC。
关注点:
- 沿用现有 Python JSON stdin/stdout 契约，便于 Node/Vitest 包装验证。
- 使用 zipfile + lxml 处理 DOCX package，不把 python-docx 段落级抽象扩成通用工具。
- 只验证单 w:t 节点内的安全替换边界，跨 run 替换留给后续正式能力。
"""
from __future__ import annotations

import difflib
import json
import zipfile
from pathlib import Path
from typing import Any

from lxml import etree  # type: ignore

from common.io import read_json_stdin, write_error_stderr, write_json_stdout

WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": WORD_NS}
DOCUMENT_XML = "word/document.xml"


def resolve_path(value: object, field: str) -> Path:
    path = Path(str(value or "")).expanduser().resolve()
    if not str(value or "").strip():
        raise ValueError(f"{field} 不能为空")
    return path


def ensure_docx(input_path: Path) -> None:
    if not input_path.exists():
        raise FileNotFoundError(f"input file not found: {input_path}")
    if input_path.suffix.lower() != ".docx":
        raise ValueError("docx_edit 仅支持 .docx 文件")
    if not zipfile.is_zipfile(input_path):
        raise ValueError("input is not a valid DOCX zip package")


def read_docx_part(input_path: Path, part_name: str) -> bytes:
    ensure_docx(input_path)
    with zipfile.ZipFile(input_path) as package:
        if part_name not in package.namelist():
            raise ValueError(f"DOCX 缺少 {part_name}")
        return package.read(part_name)


def parse_xml(xml_bytes: bytes) -> etree._Element:
    parser = etree.XMLParser(resolve_entities=False, remove_blank_text=False, recover=False)
    return etree.fromstring(xml_bytes, parser)


def serialize_xml(root: etree._Element) -> bytes:
    return etree.tostring(root, encoding="UTF-8", xml_declaration=True, standalone=False)


def text_nodes(root: etree._Element) -> list[etree._Element]:
    return list(root.xpath(".//w:t", namespaces=NS))


def paragraph_nodes(root: etree._Element) -> list[etree._Element]:
    return list(root.xpath(".//w:p", namespaces=NS))


def read_attr(element: etree._Element, name: str) -> str | None:
    value = element.get(f"{{{WORD_NS}}}{name}")
    return value if value is not None else element.get(name)


def structure_summary(xml_bytes: bytes) -> dict[str, Any]:
    root = parse_xml(xml_bytes)
    paragraphs = paragraph_nodes(root)
    runs = list(root.xpath(".//w:r", namespaces=NS))
    text_count = len(text_nodes(root))
    p_styles = [
        read_attr(item, "val") or ""
        for item in root.xpath(".//w:pStyle", namespaces=NS)
    ]
    r_styles = [
        read_attr(item, "val") or ""
        for item in root.xpath(".//w:rStyle", namespaces=NS)
    ]
    return {
        "paragraphCount": len(paragraphs),
        "runCount": len(runs),
        "textNodeCount": text_count,
        "paragraphStyles": p_styles,
        "runStyles": r_styles,
    }


def list_package_parts(input_path: Path) -> list[str]:
    ensure_docx(input_path)
    with zipfile.ZipFile(input_path) as package:
        return package.namelist()


def inspect_docx(payload: dict[str, Any]) -> dict[str, Any]:
    input_path = resolve_path(payload.get("inputPath"), "inputPath")
    parts = list_package_parts(input_path)
    xml_parts = [part for part in parts if part.endswith(".xml")]
    revision_parts: list[str] = []
    revision_markers: dict[str, int] = {}
    with zipfile.ZipFile(input_path) as package:
        for part in xml_parts:
            data = package.read(part)
            count = sum(data.count(marker) for marker in (b"<w:ins", b"<w:del", b"<w:pPrChange", b"<w:rPrChange"))
            if count:
                revision_parts.append(part)
                revision_markers[part] = count
    return {
        "inputPath": str(input_path),
        "hasDocumentXml": DOCUMENT_XML in parts,
        "partCount": len(parts),
        "xmlPartCount": len(xml_parts),
        "headers": [part for part in parts if part.startswith("word/header") and part.endswith(".xml")],
        "footers": [part for part in parts if part.startswith("word/footer") and part.endswith(".xml")],
        "comments": [part for part in parts if "comments" in part and part.endswith(".xml")],
        "hasRevisions": bool(revision_parts),
        "revisionParts": revision_parts,
        "revisionMarkers": revision_markers,
    }


def unpack_docx(payload: dict[str, Any]) -> dict[str, Any]:
    input_path = resolve_path(payload.get("inputPath"), "inputPath")
    output_dir = resolve_path(payload.get("outputDir"), "outputDir")
    ensure_docx(input_path)
    if output_dir.exists():
        raise FileExistsError(f"outputDir already exists: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(input_path) as package:
        package.extractall(output_dir)
        parts = package.namelist()
    return {
        "inputPath": str(input_path),
        "outputDir": str(output_dir),
        "partCount": len(parts),
        "hasDocumentXml": DOCUMENT_XML in parts,
    }


def pack_docx(payload: dict[str, Any]) -> dict[str, Any]:
    input_dir = resolve_path(payload.get("inputDir"), "inputDir")
    output_path = resolve_path(payload.get("outputPath"), "outputPath")
    if not input_dir.is_dir():
        raise FileNotFoundError(f"input directory not found: {input_dir}")
    if not (input_dir / "[Content_Types].xml").exists():
        raise ValueError("unpacked DOCX 缺少 [Content_Types].xml")
    if not (input_dir / DOCUMENT_XML).exists():
        raise ValueError(f"unpacked DOCX 缺少 {DOCUMENT_XML}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    files = sorted(file for file in input_dir.rglob("*") if file.is_file())
    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as package:
        for file in files:
            package.write(file, file.relative_to(input_dir).as_posix())
    ensure_docx(output_path)
    return {
        "inputDir": str(input_dir),
        "outputPath": str(output_path),
        "partCount": len(files),
        "hasDocumentXml": DOCUMENT_XML in list_package_parts(output_path),
    }


def read_candidates(payload: dict[str, Any]) -> list[str]:
    raw = payload.get("candidates")
    values: list[str] = []
    if isinstance(raw, list):
        values.extend(str(item).strip() for item in raw)
    candidates_path_value = payload.get("candidatesPath")
    if candidates_path_value:
        candidates_path = resolve_path(candidates_path_value, "candidatesPath")
        values.extend(line.strip() for line in candidates_path.read_text(encoding="utf-8").splitlines())
    deduped: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value and value not in seen:
            deduped.append(value)
            seen.add(value)
    if not deduped:
        raise ValueError("candidates 不能为空")
    return deduped


def analyze_docx(payload: dict[str, Any]) -> dict[str, Any]:
    input_path = resolve_path(payload.get("inputPath"), "inputPath")
    candidates = read_candidates(payload)
    xml_bytes = read_docx_part(input_path, DOCUMENT_XML)
    root = parse_xml(xml_bytes)
    nodes = text_nodes(root)
    paragraphs = paragraph_nodes(root)
    node_texts = [str(node.text or "") for node in nodes]
    paragraph_texts = [
        "".join(str(text or "") for text in paragraph.xpath(".//w:t/text()", namespaces=NS))
        for paragraph in paragraphs
    ]
    items = []
    reachable_count = 0
    paragraph_only_count = 0
    for candidate in candidates:
        single_matches = [text for text in node_texts if candidate in text]
        paragraph_matches = [text for text in paragraph_texts if candidate in text]
        single_reachable = len(single_matches) > 0
        paragraph_reachable = len(paragraph_matches) > 0
        if single_reachable:
            reachable_count += 1
        if paragraph_reachable and not single_reachable:
            paragraph_only_count += 1
        items.append({
            "candidate": candidate,
            "singleRunReachable": single_reachable,
            "singleRunMatchCount": len(single_matches),
            "paragraphReachable": paragraph_reachable,
            "paragraphMatchCount": len(paragraph_matches),
            "sampleSingleRunText": single_matches[0] if single_matches else None,
        })
    total = len(candidates)
    return {
        "inputPath": str(input_path),
        "candidateCount": total,
        "singleRunReachableCount": reachable_count,
        "paragraphOnlyReachableCount": paragraph_only_count,
        "singleRunCoverageRate": reachable_count / total if total else 0,
        "items": items,
    }


def replace_docx(payload: dict[str, Any]) -> dict[str, Any]:
    input_path = resolve_path(payload.get("inputPath"), "inputPath")
    output_path = resolve_path(payload.get("outputPath"), "outputPath")
    old = str(payload.get("from") or "")
    new = str(payload.get("to") or "")
    if not old:
        raise ValueError("from 不能为空")
    xml_bytes = read_docx_part(input_path, DOCUMENT_XML)
    before_summary = structure_summary(xml_bytes)
    root = parse_xml(xml_bytes)
    changed_nodes = 0
    replacement_count = 0
    for node in text_nodes(root):
        text = str(node.text or "")
        if old not in text:
            continue
        count = text.count(old)
        node.text = text.replace(old, new)
        changed_nodes += 1
        replacement_count += count
    if replacement_count <= 0:
        raise ValueError("target text not found in a single w:t node")
    after_xml = serialize_xml(root)
    after_summary = structure_summary(after_xml)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(input_path) as source, zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as target:
        for info in source.infolist():
            data = after_xml if info.filename == DOCUMENT_XML else source.read(info.filename)
            target.writestr(info, data)
    diff_lines = list(difflib.unified_diff(
        xml_bytes.decode("utf-8", errors="replace").splitlines(),
        after_xml.decode("utf-8", errors="replace").splitlines(),
        lineterm="",
    ))
    return {
        "inputPath": str(input_path),
        "outputPath": str(output_path),
        "part": DOCUMENT_XML,
        "replacementCount": replacement_count,
        "changedTextNodeCount": changed_nodes,
        "structureBefore": before_summary,
        "structureAfter": after_summary,
        "structureUnchanged": before_summary == after_summary,
        "xmlDiffLineCount": len(diff_lines),
        "hasRevisionsBefore": inspect_docx({"inputPath": str(input_path)})["hasRevisions"],
        "hasRevisionsAfter": inspect_docx({"inputPath": str(output_path)})["hasRevisions"],
    }


def main() -> int:
    try:
        payload = read_json_stdin()
        if not isinstance(payload, dict):
            raise ValueError("payload must be a JSON object")
        action = str(payload.get("action") or "").strip()
        if action == "inspect":
            write_json_stdout(inspect_docx(payload))
        elif action == "unpack":
            write_json_stdout(unpack_docx(payload))
        elif action == "pack":
            write_json_stdout(pack_docx(payload))
        elif action == "analyze":
            write_json_stdout(analyze_docx(payload))
        elif action == "replace":
            write_json_stdout(replace_docx(payload))
        else:
            raise ValueError(f"unsupported action: {action or 'unknown'}")
        return 0
    except Exception as exc:  # noqa: BLE001
        write_error_stderr(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
