#!/usr/bin/env python3
"""
职责: 为 document-pipeline 提供外部 OCR / 文档解析 provider。
关注点:
- 沿用 JSON stdin/stdout 协议，供 convert_document.py 编排。
- MinerU Agent 使用 signed upload + polling + markdown download。
- 百度 PaddleOCR-VL 使用 access_token + task polling + markdown_url/JSON fallback。
- AIStudio PaddleOCR-VL 1.5 使用 layout-parsing 同步接口直接返回 Markdown。
"""
from __future__ import annotations

import base64
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from common.io import read_json_stdin, write_error_stderr, write_json_stdout


def http_request(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
    timeout: float = 60,
) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"HTTP {exc.code}: {detail or exc.reason}") from exc


def post_json(url: str, payload: dict[str, Any], timeout: float, headers: dict[str, str] | None = None) -> dict[str, Any]:
    request_headers = {"Content-Type": "application/json"}
    if headers:
        request_headers.update(headers)
    status, body = http_request(
        "POST",
        url,
        headers=request_headers,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        timeout=timeout,
    )
    if status < 200 or status >= 300:
        raise RuntimeError(f"HTTP {status}")
    return json.loads(body.decode("utf-8"))


def post_form(url: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    encoded: dict[str, str] = {}
    for key, value in payload.items():
        if value is None:
            continue
        encoded[key] = value.decode("utf-8") if isinstance(value, bytes) else str(value)
    status, body = http_request(
        "POST",
        url,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data=urllib.parse.urlencode(encoded).encode("utf-8"),
        timeout=timeout,
    )
    if status < 200 or status >= 300:
        raise RuntimeError(f"HTTP {status}")
    return json.loads(body.decode("utf-8"))


def download_text(url: str, timeout: float) -> str:
    status, body = http_request("GET", url, timeout=timeout)
    if status < 200 or status >= 300:
        raise RuntimeError(f"HTTP {status}")
    return body.decode("utf-8")


def download_text_with_headers(url: str, timeout: float, headers: dict[str, str] | None = None) -> str:
    status, body = http_request("GET", url, headers=headers, timeout=timeout)
    if status < 200 or status >= 300:
        raise RuntimeError(f"HTTP {status}")
    return body.decode("utf-8")


def normalize_markdown(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\x00", "").strip()


def markdown_to_plain_text(markdown: str) -> str:
    lines = []
    for line in markdown.replace("\r\n", "\n").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            stripped = stripped.lstrip("#").strip()
        lines.append(stripped)
    return "\n".join(lines).strip()


def poll_until(
    *,
    poll: Any,
    is_done: Any,
    is_failed: Any,
    interval_ms: int,
    max_poll_ms: int,
) -> dict[str, Any]:
    deadline = time.monotonic() + max_poll_ms / 1000
    last: dict[str, Any] | None = None
    while time.monotonic() <= deadline:
        last = poll()
        if is_done(last):
            return last
        if is_failed(last):
            raise RuntimeError(extract_error(last) or "OCR task failed")
        time.sleep(max(interval_ms, 100) / 1000)
    raise TimeoutError(f"OCR task polling timed out after {max_poll_ms}ms: {last}")


def extract_error(value: dict[str, Any]) -> str | None:
    data = value.get("data") if isinstance(value.get("data"), dict) else value.get("result")
    if isinstance(data, dict):
        return str(data.get("err_msg") or data.get("task_error") or value.get("msg") or value.get("error_msg") or "").strip() or None
    return str(value.get("msg") or value.get("error_msg") or "").strip() or None


def parse_with_mineru(input_path: Path, options: dict[str, Any]) -> dict[str, Any]:
    endpoint = str(options.get("endpoint") or "https://mineru.net/api/v1/agent").rstrip("/")
    api_key = str(options.get("apiKey") or "")
    timeout_ms = int(options.get("timeoutMs") or 180_000)
    poll_interval_ms = int(options.get("pollIntervalMs") or 5_000)
    max_poll_ms = int(options.get("maxPollMs") or 180_000)
    language = str(options.get("ocrLang") or "ch")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    submit = post_json(f"{endpoint}/parse/file", {
        "file_name": input_path.name,
        "language": language,
        "enable_table": True,
        "is_ocr": True,
        "enable_formula": True,
    }, timeout_ms / 1000, headers)
    data = submit.get("data") if isinstance(submit.get("data"), dict) else {}
    task_id = str(data.get("task_id") or "")
    file_url = str(data.get("file_url") or "")
    if not task_id or not file_url:
        raise RuntimeError(f"MinerU submit response missing task_id/file_url: {submit}")

    status, _body = http_request("PUT", file_url, data=input_path.read_bytes(), timeout=timeout_ms / 1000)
    if status < 200 or status >= 300:
        raise RuntimeError(f"MinerU upload failed: HTTP {status}")

    result = poll_until(
        poll=lambda: json.loads(download_text_with_headers(f"{endpoint}/parse/{task_id}", timeout_ms / 1000, headers)),
        is_done=lambda item: isinstance(item.get("data"), dict) and item["data"].get("state") == "done",
        is_failed=lambda item: isinstance(item.get("data"), dict) and item["data"].get("state") == "failed",
        interval_ms=poll_interval_ms,
        max_poll_ms=max_poll_ms,
    )
    result_data = result.get("data") if isinstance(result.get("data"), dict) else {}
    markdown_url = str(result_data.get("markdown_url") or "")
    if not markdown_url:
        raise RuntimeError(f"MinerU result missing markdown_url: {result}")
    markdown = normalize_markdown(download_text(markdown_url, timeout_ms / 1000))
    if not markdown:
        raise RuntimeError("MinerU returned empty markdown")
    return {
        "markdown": markdown,
        "plainText": markdown_to_plain_text(markdown),
        "sourceFormat": input_path.suffix.lower().lstrip("."),
        "tool": "mineru-agent",
        "quality": "high",
        "fallbackChain": ["mineru-agent"],
        "warnings": [],
    }


def parse_with_paddleocr(input_path: Path, options: dict[str, Any]) -> dict[str, Any]:
    api_key = str(options.get("apiKey") or "")
    secret_key = str(options.get("secretKey") or "")
    if not api_key or not secret_key:
        raise RuntimeError("PaddleOCR-VL requires apiKey and secretKey")
    timeout_ms = int(options.get("timeoutMs") or 180_000)
    poll_interval_ms = int(options.get("pollIntervalMs") or 5_000)
    max_poll_ms = int(options.get("maxPollMs") or 180_000)
    oauth_endpoint = str(options.get("oauthEndpoint") or "https://aip.baidubce.com/oauth/2.0/token")
    submit_endpoint = str(options.get("submitEndpoint") or "https://aip.baidubce.com/rest/2.0/brain/online/v2/paddle-vl-parser/task")
    query_endpoint = str(options.get("queryEndpoint") or "https://aip.baidubce.com/rest/2.0/brain/online/v2/paddle-vl-parser/task/query")

    token_url = f"{oauth_endpoint}?{urllib.parse.urlencode({'grant_type': 'client_credentials', 'client_id': api_key, 'client_secret': secret_key})}"
    token_response = json.loads(download_text(token_url, timeout_ms / 1000))
    access_token = str(token_response.get("access_token") or "")
    if not access_token:
        raise RuntimeError(f"PaddleOCR token response missing access_token: {token_response}")

    submit_url = f"{submit_endpoint}?{urllib.parse.urlencode({'access_token': access_token})}"
    submit = post_form(submit_url, {
        "file_data": base64.b64encode(input_path.read_bytes()).decode("ascii"),
        "file_name": input_path.name,
    }, timeout_ms / 1000)
    result_data = submit.get("result") if isinstance(submit.get("result"), dict) else {}
    task_id = str(result_data.get("task_id") or "")
    if not task_id:
        raise RuntimeError(f"PaddleOCR submit response missing task_id: {submit}")

    query_url = f"{query_endpoint}?{urllib.parse.urlencode({'access_token': access_token})}"
    result = poll_until(
        poll=lambda: post_form(query_url, {"task_id": task_id}, timeout_ms / 1000),
        is_done=lambda item: isinstance(item.get("result"), dict) and item["result"].get("status") == "success",
        is_failed=lambda item: isinstance(item.get("result"), dict) and item["result"].get("status") == "failed",
        interval_ms=poll_interval_ms,
        max_poll_ms=max_poll_ms,
    )
    final_data = result.get("result") if isinstance(result.get("result"), dict) else {}
    markdown_url = str(final_data.get("markdown_url") or "")
    if markdown_url:
        markdown = normalize_markdown(download_text(markdown_url, timeout_ms / 1000))
    else:
        parse_result_url = str(final_data.get("parse_result_url") or "")
        if not parse_result_url:
            raise RuntimeError(f"PaddleOCR result missing markdown_url/parse_result_url: {result}")
        markdown = normalize_markdown(build_markdown_from_paddle_json(json.loads(download_text(parse_result_url, timeout_ms / 1000))))
    if not markdown:
        raise RuntimeError("PaddleOCR-VL returned empty markdown")
    return {
        "markdown": markdown,
        "plainText": markdown_to_plain_text(markdown),
        "sourceFormat": input_path.suffix.lower().lstrip("."),
        "tool": "paddleocr-vl",
        "quality": "high",
        "fallbackChain": ["paddleocr-vl"],
        "warnings": [],
    }


def parse_with_paddleocr_aistudio(input_path: Path, options: dict[str, Any]) -> dict[str, Any]:
    endpoint = str(options.get("endpoint") or "https://r630f5rbv7l5a5j7.aistudio-app.com/layout-parsing")
    token = str(options.get("token") or "")
    if not token:
        raise RuntimeError("PaddleOCR-VL AIStudio requires token")
    timeout_ms = int(options.get("timeoutMs") or 180_000)
    suffix = input_path.suffix.lower()
    file_type = 0 if suffix == ".pdf" else 1
    response = post_json(endpoint, {
        "file": base64.b64encode(input_path.read_bytes()).decode("ascii"),
        "fileType": file_type,
        "useDocOrientationClassify": bool(options.get("useDocOrientationClassify")),
        "useDocUnwarping": bool(options.get("useDocUnwarping")),
        "useChartRecognition": bool(options.get("useChartRecognition")),
    }, timeout_ms / 1000, {
        "Authorization": f"token {token}",
    })
    result = response.get("result") if isinstance(response.get("result"), dict) else {}
    pages = result.get("layoutParsingResults") if isinstance(result.get("layoutParsingResults"), list) else []
    chunks: list[str] = []
    for index, page in enumerate(pages):
        if not isinstance(page, dict):
            continue
        markdown = page.get("markdown") if isinstance(page.get("markdown"), dict) else {}
        text = normalize_markdown(str(markdown.get("text") or ""))
        if text:
            if len(pages) > 1:
                chunks.append(f"## 第 {index + 1} 页")
            chunks.append(text)
    markdown_text = normalize_markdown("\n\n".join(chunks))
    if not markdown_text:
        raise RuntimeError(f"PaddleOCR-VL AIStudio returned empty markdown: {response}")
    return {
        "markdown": markdown_text,
        "plainText": markdown_to_plain_text(markdown_text),
        "sourceFormat": input_path.suffix.lower().lstrip("."),
        "tool": "paddleocr-vl-aistudio",
        "quality": "high",
        "fallbackChain": ["paddleocr-vl-aistudio"],
        "warnings": [],
    }


def build_markdown_from_paddle_json(value: dict[str, Any]) -> str:
    pages = value.get("pages") if isinstance(value.get("pages"), list) else []
    chunks: list[str] = []
    for page in pages:
        if not isinstance(page, dict):
            continue
        page_num = page.get("page_num")
        chunks.append(f"## 第 {int(page_num) + 1 if isinstance(page_num, int) else len(chunks) + 1} 页")
        layouts = page.get("layouts") if isinstance(page.get("layouts"), list) else []
        for layout in layouts:
            if not isinstance(layout, dict):
                continue
            text = str(layout.get("text") or "").strip()
            if text:
                chunks.append(text)
        page_text = str(page.get("text") or "").strip()
        if page_text and page_text not in chunks:
            chunks.append(page_text)
    return "\n\n".join(chunks)


def main() -> int:
    try:
        payload = read_json_stdin()
        if not isinstance(payload, dict):
            raise ValueError("payload must be a JSON object")
        provider = str(payload.get("provider") or "")
        input_path = Path(str(payload["inputPath"])).expanduser().resolve()
        if not input_path.exists():
            raise FileNotFoundError(f"input file not found: {input_path}")
        options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
        if provider == "mineru-agent":
            write_json_stdout(parse_with_mineru(input_path, options))
        elif provider == "paddleocr-vl":
            write_json_stdout(parse_with_paddleocr(input_path, options))
        elif provider == "paddleocr-vl-aistudio":
            write_json_stdout(parse_with_paddleocr_aistudio(input_path, options))
        else:
            raise ValueError(f"unsupported OCR provider: {provider or 'unknown'}")
        return 0
    except Exception as exc:  # noqa: BLE001
        write_error_stderr(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
