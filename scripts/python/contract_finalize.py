#!/usr/bin/env python3
from pathlib import Path

from docx import Document  # type: ignore
from docx.table import Table  # type: ignore

from common.io import read_json_stdin, write_error_stderr, write_json_stdout


def get_text(paragraph):
    return paragraph.text.strip()


def clear_and_set_text(paragraph, text: str) -> None:
    for run in list(paragraph.runs):
        run.clear()
    if paragraph.runs:
        paragraph.runs[0].text = text
    else:
        paragraph.add_run(text)


def delete_paragraph(paragraph) -> None:
    element = paragraph._element
    parent = element.getparent()
    if parent is not None:
        parent.remove(element)


def iter_container_paragraphs(container):
    for paragraph in container.paragraphs:
        yield paragraph
    for table in getattr(container, "tables", []):
        yield from iter_table_paragraphs(table)


def iter_table_paragraphs(table: Table):
    for row in table.rows:
        for cell in row.cells:
            yield from iter_container_paragraphs(cell)


def process_document(document: Document, data: dict) -> None:
    client_name = str(data.get("client_name") or "").strip()
    client_id_code = str(data.get("client_id_code") or "").strip()
    client_address = str(data.get("client_address") or "").strip()
    client_phone = str(data.get("client_phone") or "").strip()
    client_representative = str(data.get("client_representative") or "").strip()
    lead_lawyer = str(data.get("lead_lawyer") or "").strip()
    counterparty_name = str(data.get("counterparty_name") or "").strip()
    case_cause = str(data.get("case_cause") or "").strip()

    is_company = bool(data.get("is_company"))
    show_risk_notice = bool(data.get("show_risk_notice"))

    keep_stage = {
        "仲裁阶段": bool(data.get("engage_arbitration")),
        "一审诉讼": bool(data.get("engage_first_instance")),
        "二审诉讼": bool(data.get("engage_second_instance")),
        "执行程序": bool(data.get("engage_enforcement")),
        "调解、和解事宜": bool(data.get("engage_settlement")),
    }

    stage_fixed = bool(data.get("is_stage_fixed"))
    stage_fee_clauses = {
        "1.仲裁阶段：": str(data.get("fee_arbitration_clause") or "").strip(),
        "2.一审阶段：": str(data.get("fee_first_instance_clause") or "").strip(),
        "3.二审阶段：": str(data.get("fee_second_instance_clause") or "").strip(),
        "4.执行阶段：": str(data.get("fee_enforcement_clause") or "").strip(),
    }

    risk_blocks = [
        "☐基础收费+风险收费",
        "☑基础收费+风险收费",
        "甲乙双方选择风险代理收费方式",
        "1.基础费用：",
        "2.风险收费：",
        "如果甲方实际收到的是现金以外的有形资产或财产权益",
        "对于风险收费，甲方只要有回款或有回收其他有形资产或财产权益",
        "本代理为风险收费方式",
    ]

    paragraphs = list(iter_container_paragraphs(document))
    delete_from_index = None

    for index, paragraph in enumerate(paragraphs):
        text = get_text(paragraph)
        if not text:
            continue

        if text.startswith("聘请方（甲方）："):
            clear_and_set_text(paragraph, f"聘请方（甲方）：{client_name}")
            continue
        if text == "甲方：" or text.startswith("甲方："):
            clear_and_set_text(paragraph, f"甲方：{client_name}")
            continue
        if text.startswith("法定代表人/负责人："):
            if is_company:
                clear_and_set_text(paragraph, f"法定代表人/负责人：{client_representative}")
            else:
                delete_paragraph(paragraph)
            continue
        if text.startswith("证件号/社会统一信用代码："):
            clear_and_set_text(paragraph, f"证件号/社会统一信用代码：{client_id_code}")
            continue
        if text.startswith("地址："):
            clear_and_set_text(paragraph, f"地址：{client_address}")
            continue
        if text.startswith("联系电话："):
            clear_and_set_text(paragraph, f"联系电话：{client_phone}")
            continue
        if text.startswith("甲方因与") and "纠纷案件" in text:
            clear_and_set_text(paragraph, f"甲方因与{counterparty_name}{case_cause}纠纷案件，委托乙方代理，经双方协商，订立下列各条款，共同遵照履行。")
            continue
        if text.startswith("（一）乙方指派"):
            clear_and_set_text(paragraph, f"（一）乙方指派{lead_lawyer}律师作为案件中甲方的委托代理人，甲方同意上述律师指派其他律师和助理配合完成辅助工作，但乙方更换代理律师应取得甲方认可。")
            continue
        if text.endswith("仲裁阶段；"):
            if keep_stage["仲裁阶段"]:
                clear_and_set_text(paragraph, "☑仲裁阶段；")
            else:
                delete_paragraph(paragraph)
            continue
        if text.endswith("一审诉讼；"):
            if keep_stage["一审诉讼"]:
                clear_and_set_text(paragraph, "☑一审诉讼；")
            else:
                delete_paragraph(paragraph)
            continue
        if text.endswith("二审诉讼；"):
            if keep_stage["二审诉讼"]:
                clear_and_set_text(paragraph, "☑二审诉讼；")
            else:
                delete_paragraph(paragraph)
            continue
        if text.endswith("执行程序；"):
            if keep_stage["执行程序"]:
                clear_and_set_text(paragraph, "☑执行程序；")
            else:
                delete_paragraph(paragraph)
            continue
        if "调解、和解事宜" in text:
            if keep_stage["调解、和解事宜"]:
                clear_and_set_text(paragraph, "☑上述案件代理程序中，有关调解、和解事宜。")
            else:
                delete_paragraph(paragraph)
            continue
        if text == "☑按阶段收费" or text == "□按阶段收费":
            if stage_fixed:
                clear_and_set_text(paragraph, "☑按阶段收费")
            else:
                delete_paragraph(paragraph)
            continue
        if text.startswith("甲乙双方约定乙方律师费如下："):
            if not stage_fixed:
                delete_paragraph(paragraph)
            continue
        for prefix, replacement in stage_fee_clauses.items():
            if text.startswith(prefix):
                if stage_fixed and replacement:
                    clear_and_set_text(paragraph, replacement)
                else:
                    delete_paragraph(paragraph)
                break
        else:
            if stage_fixed and any(text.startswith(prefix) for prefix in risk_blocks):
                delete_paragraph(paragraph)
                continue
            if (not stage_fixed) and (text == "☑按阶段收费" or text.startswith("甲乙双方约定乙方律师费如下：")):
                delete_paragraph(paragraph)
                continue
            if text.startswith("法定代表人/负责人/授权代表："):
                if is_company:
                    clear_and_set_text(paragraph, f"法定代表人/负责人/授权代表：__________   承办律师：{lead_lawyer}")
                else:
                    clear_and_set_text(paragraph, f"承办律师：{lead_lawyer}")
                continue
            if text.startswith("委托人："):
                clear_and_set_text(paragraph, "委托人：")
                continue
            if text.startswith("附：《风险代理告知书》") and not show_risk_notice:
                if delete_from_index is None:
                    delete_from_index = index
                continue
            if "风险代理告知书" in text and not show_risk_notice:
                if delete_from_index is None:
                    delete_from_index = index - 1 if index > 0 else index
                continue

    if not show_risk_notice:
        remove_tail = False
        for paragraph in list(document.paragraphs):
            text = get_text(paragraph)
            if (
                text.startswith("附：《风险代理告知书》")
                or text == "附件"
                or "风险代理告知书" in text
            ):
                remove_tail = True
            if remove_tail:
                delete_paragraph(paragraph)
    elif delete_from_index is not None:
        current = list(document.paragraphs)
        start = max(0, delete_from_index)
        for paragraph in current[start:]:
            delete_paragraph(paragraph)


def main() -> int:
    try:
        payload = read_json_stdin()
        input_path = Path(str(payload["inputPath"])).expanduser().resolve()
        output_path = Path(str(payload.get("outputPath") or input_path)).expanduser().resolve()
        data = payload.get("data")
        if not input_path.exists():
            raise FileNotFoundError(f"input file not found: {input_path}")
        if input_path.suffix.lower() != ".docx":
            raise ValueError("contract_finalize 目前仅支持 .docx 文件")
        if not isinstance(data, dict):
            raise ValueError("data 不能为空")
        document = Document(str(input_path))
        process_document(document, data)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        document.save(str(output_path))
        write_json_stdout({"outputPath": str(output_path)})
        return 0
    except Exception as exc:  # noqa: BLE001
        write_error_stderr(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
