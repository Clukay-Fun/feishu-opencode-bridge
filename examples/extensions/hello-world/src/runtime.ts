/**
 * 职责: 声明 hello-world 外部扩展的源码态 runtime module。
 * 关注点:
 * - 演示 devRuntime 如何通过 extension-api 接入外部扩展 adapter。
 * - 保持 createModule 同步，异步初始化应放进 module.start()。
 */
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
