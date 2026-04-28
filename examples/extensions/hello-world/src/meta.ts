/**
 * 职责: 声明 hello-world 外部扩展的源码态 data-only meta。
 * 关注点:
 * - 演示 devMeta 如何在 tsx 启动时直接指向 TypeScript 源码。
 * - 只依赖 extension-api，不触碰 bridge/runtime/feishu/store 内部路径。
 */
import { defineCardTemplate } from "../../../../src/extension-api/index.js";

const helloWorldTemplate = defineCardTemplate({
  id: "hello-world.card",
  schema: {
    parse(value) {
      return value;
    },
  },
  render() {
    return {
      title: "Hello World",
      template: "blue",
      iconToken: "chat_outlined",
      blocks: [{ kind: "title", content: "Hello from extension-api source entry" }],
    };
  },
});

export default {
  id: "hello-world",
  commands: [{ name: "hello-world", owner: "business", description: "示例外部扩展命令" }],
  cardTemplates: [helloWorldTemplate],
};
