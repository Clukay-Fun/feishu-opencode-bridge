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
      blocks: [{ kind: "title", content: "Hello from extension-api" }],
    };
  },
});

export default {
  id: "hello-world",
  commands: [{ name: "hello-world", owner: "business", description: "示例外部扩展命令" }],
  cardTemplates: [helloWorldTemplate],
};
