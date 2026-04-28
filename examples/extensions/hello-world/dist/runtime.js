import { defineExtension } from "../../../../src/extension-api/index.js";

export default defineExtension({
  id: "hello-world",
  createModule() {
    return {
      name: "hello-world",
      priority: 100,
    };
  },
});
