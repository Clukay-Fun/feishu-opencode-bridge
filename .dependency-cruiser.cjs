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
