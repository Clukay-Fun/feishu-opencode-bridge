/**
 * 职责: 约束源码模块之间的依赖边界。
 * 关注点:
 * - 用 framework 白名单反选业务目录，避免新增业务目录逃过边界规则。
 * - 固化飞书 SDK、formatter 兼容出口和业务卡片模板的使用边界。
 */
const FRAMEWORK_TOP_LEVEL_DIRS = [
  "bridge",
  "config",
  "document-pipeline",
  "extensions",
  "feishu",
  "http",
  // knowledge 是共享服务模块：提供 KnowledgeBasePort/factory/document pipeline 复用点，
  // 因此不参与业务目录反选；实现类仍由专门规则禁止 runtime/bridge 直接 import。
  "knowledge",
  "logging",
  // memory 当前作为共享运行时上下文服务处理，暂不纳入业务扩展横向依赖规则。
  "memory",
  "opencode",
  "runtime",
  "store",
  "types",
  "utils",
  "workflows",
];

const FRAMEWORK_TOP_LEVEL_PATTERN = FRAMEWORK_TOP_LEVEL_DIRS.join("|");
const BUSINESS_TOP_LEVEL_SEGMENT = `(?!(?:${FRAMEWORK_TOP_LEVEL_PATTERN})(?:/|$))[^/]+`;
const BUSINESS_TOP_LEVEL_PATH = `^src/(${BUSINESS_TOP_LEVEL_SEGMENT})/`;
const EXTERNAL_EXTENSION_PATH = "^(extensions/[^/]+|examples/extensions/[^/]+)/";

module.exports = {
  forbidden: [
    {
      name: "external-extensions-must-only-import-extension-api",
      severity: "error",
      comment: "外部扩展只能依赖 src/extension-api 公共契约；不得直接 import bridge/runtime/feishu/store 或业务实现。",
      from: {
        path: EXTERNAL_EXTENSION_PATH,
      },
      to: {
        path: "^src/(?!extension-api/)",
      },
    },
    {
      name: "core-must-not-import-domain-modules",
      severity: "error",
      comment: "冻结后的 core seam 不允许直接依赖反选出的业务模块；业务能力应通过 RuntimeModule seam 接入。",
      from: {
        path: "^src/(runtime/(app|turn-executor)\\.ts|bridge/router\\.ts)$",
      },
      to: {
        path: BUSINESS_TOP_LEVEL_PATH,
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
      name: "config-layer-must-not-import-runtime-domain",
      severity: "error",
      comment: "中央配置层只允许通过 extensions/builtin-meta.ts 读取 data-only configDefinition；不得直接导入业务 runtime、service 或业务目录文件。",
      from: {
        path: "^src/config/",
      },
      to: {
        path: BUSINESS_TOP_LEVEL_PATH,
        pathNot: `^src/${BUSINESS_TOP_LEVEL_SEGMENT}/config\\.ts$`,
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "business-extensions-must-not-import-each-other",
      severity: "error",
      comment: "反选出的业务目录之间不得横向 import；跨模块协作必须通过 port、shared workflow 或 runtime assembly 注入。",
      from: {
        path: BUSINESS_TOP_LEVEL_PATH,
      },
      to: {
        path: BUSINESS_TOP_LEVEL_PATH,
        pathNot: "^src/$1/",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "extension-meta-must-stay-data-only",
      severity: "error",
      comment: "extension.meta.ts 只能承载 data-only 声明，不得加载 RuntimeModule、service、模块 index 或 runtime 层。",
      from: {
        path: "^src/(?!extensions/)[^/]+/extension\\.meta\\.ts$",
      },
      to: {
        path: "^src/(runtime/|[^/]+/(runtime-module\\.ts|index\\.ts|extension\\.ts|.*service.*\\.ts))",
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
        path: `^src/(runtime/|${BUSINESS_TOP_LEVEL_SEGMENT}/)`,
      },
      to: {
        path: "^src/feishu/templates/",
        dependencyTypesNot: ["type-only"],
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "(^|/)node_modules/",
    },
    exclude: {
      path: "^dist/|(^|/)node_modules/",
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
