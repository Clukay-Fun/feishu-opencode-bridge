# Scripts 目录说明

这个目录按职责分成几个子目录：

- `runtime/`
  - 首次引导、启动与诊断入口
  - 例如 `onboard`、`doctor`、`start`
- `checks/`
  - 面向 CI 和仓库约束的检查脚本
  - 例如文档 diff 检查、formatter 导出面检查
- `kb/`
  - 知识库本地 CLI 入口与便捷包装脚本
- `ext/`
  - 外部扩展包的本地安装、列出、删除和打包入口
  - 例如 `npm run ext:install -- ./my-extension`、`npm run ext:pack -- ./my-extension`
- `wrappers/`
  - 兼容型外层入口，负责把调用转发到真正实现
- `python/`
  - Python 侧的实际能力实现，例如合同文档处理与 PDF / 文档解析

整理原则：

- 运行入口与仓库检查分开
- 便捷 wrapper 与真正实现分开
- `scripts/` 根目录尽量只保留目录与说明，不再继续平铺新增脚本
