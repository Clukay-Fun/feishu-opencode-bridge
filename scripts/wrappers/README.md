# Wrappers 说明

这个目录存放兼容型外层包装脚本。

它们本身不承载核心业务逻辑，职责是：

- 保留旧调用方式
- 转发参数
- 调用真正实现所在的脚本

当前内容：

- `pdf_to_md.py`
  - 外层 PDF 转 Markdown 入口
  - 真正实现位于 `scripts/python/`
