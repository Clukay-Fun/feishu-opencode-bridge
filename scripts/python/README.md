# Python 脚本说明

这个目录存放 Python 侧的实际能力实现。

当前主要分组：

- 合同文档处理
  - `contract_parse.py`
  - `contract_render.py`
  - `contract_edit.py`
  - `contract_finalize.py`
  - `render_contract.py`
- 文档解析
  - `convert_document.py`
  - `doc_to_text.py`
  - `pdf_to_markdown.py`
  - `pdf_to_md.py`
- 公共支持
  - `common/io.py`
  - `common/styles.py`
  - `requirements.txt`

使用原则：

- 这里放真正的 Python 实现
- 如果只是参数转发或兼容入口，优先放到 `scripts/wrappers/`

解析入口约定：

- 新调用方优先使用 `convert_document.py`
- `doc_to_text.py`、`pdf_to_markdown.py` 和 `pdf_to_md.py` 保持兼容
- 统一入口输出 Markdown、纯文本、来源格式、工具名、质量和 fallback 链路
