/**
 * 职责: 约束源码模块之间的依赖边界。
 * 关注点:
 * - 防止 runtime/bridge 直接依赖业务实现。
 * - 固化飞书 SDK、formatter 兼容出口和业务卡片模板的使用边界。
 */
module.exports = {
  forbidden: [
    {
      name: "core-must-not-import-domain-modules",
      severity: "error",
      comment: "冻结后的 core seam 不允许直接依赖业务模块；业务能力应通过 RuntimeModule seam 接入。",
      from: {
        path: "^src/(runtime/(app|turn-executor)\\.ts|bridge/router\\.ts)$",
      },
      to: {
        path: "^src/(contract-assistant|knowledge|labor|memory)/",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "runtime-bridge-must-not-import-knowledge-implementation",
      severity: "error",
      comment: "KnowledgeBaseService 属于知识库业务实现；runtime/bridge 只能 type-import KnowledgeBasePort，或通过 knowledge/factory 与 RuntimeModule seam 接入。",
      from: {
        path: "^src/(runtime|bridge)/",
      },
      to: {
        path: "^src/knowledge/index\\.ts$",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "config-layer-must-only-import-domain-config",
      severity: "error",
      comment: "中央配置层只允许导入业务模块的 config.ts；不得从配置入口拖入业务实现、runtime module 或模块 index。",
      from: {
        path: "^src/config/",
      },
      to: {
        path: "^src/(contract-assistant|knowledge|labor|memory)/(?!config\\.ts$)",
      },
    },
    {
      name: "feishu-sdk-only-at-transport-ingress-boundary",
      severity: "error",
      comment: "飞书 SDK 只允许在 Feishu API、WebSocket 入口、HTTP callback 和 FeishuTransport 边界使用。",
      from: {
        path: "^src/",
        pathNot: "^src/(feishu/(api|ws)\\.ts|http/server\\.ts|runtime/feishu-transport\\.ts)$",
      },
      to: {
        path: "^@larksuiteoapi/node-sdk$",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "formatter-compat-export-only",
      severity: "error",
      comment: "formatter.ts 只保留兼容 re-export；新代码应直接使用 card family 入口。",
      from: {
        path: "^src/",
        pathNot: "^src/feishu/formatter\\.ts$",
      },
      to: {
        path: "^src/feishu/formatter\\.ts$",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "business-card-templates-only-via-family-adapters",
      severity: "error",
      comment: "业务模板运行时只能由 feishu card family adapter 调用；runtime 和业务模块不得直接 import 模板目录。",
      from: {
        path: "^src/(runtime/|labor/|knowledge/|contract-assistant/)",
      },
      to: {
        path: "^src/feishu/templates/",
        dependencyTypesNot: ["type-only"],
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    exclude: {
      path: "^(dist|node_modules)/",
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json",
    },
    enhancedResolveOptions: {
      extensions: [".ts", ".js", ".json"],
    },
  },
};
