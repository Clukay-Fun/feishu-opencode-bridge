module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    sourceType: "module",
    ecmaVersion: "latest",
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  ignorePatterns: ["dist", "node_modules"],
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/consistent-type-imports": ["error", { "prefer": "type-imports" }],
  },
  overrides: [
    {
      files: ["src/**/*.ts"],
      excludedFiles: ["src/config/loader.ts"],
      rules: {
        "no-restricted-syntax": [
          "error",
          {
            selector: "CallExpression[callee.name='require'][arguments.0.value=/config\\.json$/]",
            message: "不要直接 require config.json；请通过 src/config/loader.ts 加载配置。",
          },
          {
            selector: "CallExpression[callee.name='readFile'][arguments.0.value=/config\\.json$/]",
            message: "不要直接读取 config.json；请通过 src/config/loader.ts 加载配置。",
          },
          {
            selector: "CallExpression[callee.name='readFileSync'][arguments.0.value=/config\\.json$/]",
            message: "不要直接读取 config.json；请通过 src/config/loader.ts 加载配置。",
          },
          {
            selector: "CallExpression[callee.property.name='readFile'][arguments.0.value=/config\\.json$/]",
            message: "不要直接读取 config.json；请通过 src/config/loader.ts 加载配置。",
          },
          {
            selector: "CallExpression[callee.property.name='readFileSync'][arguments.0.value=/config\\.json$/]",
            message: "不要直接读取 config.json；请通过 src/config/loader.ts 加载配置。",
          },
        ],
      },
    },
  ],
};
