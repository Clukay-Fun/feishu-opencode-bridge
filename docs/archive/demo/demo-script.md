# Demo Script

## Summary

4/20 提交版固定演示链路如下：

1. 私聊开发助手
2. 群聊协作
3. 权限按钮流
4. Lark CLI 联动

建议全程使用同一个公开 HTTPS 域名回调环境，保证权限按钮可以真实点击。

## Scene 1 · 私聊开发助手

目标：展示桥接层不是普通聊天机器人，而是带会话管理的 OpenCode 运行时入口。

### Steps

1. 在飞书私聊中发送 `/new`
2. 发送第一条开发任务，例如：

   ```text
   帮我检查当前项目的入口启动链路
   ```

3. 等待 Process Card 流式更新
4. 发送 `/sessions`
5. 发送 `/model`
6. 确认可用模型卡正常展示
7. 发送模型切换命令：

   ```text
   /model use openai/gpt-5.4-mini
   ```

8. 发送第二条任务，观察后续仍在当前窗口继续

### Expected

- Process Card 持续更新
- `/sessions` 能列出当前窗口的会话列表
- `/model` 返回模型卡
- `/model use ...` 可继续透传给 OpenCode 执行

## Scene 2 · 群聊协作

目标：展示群聊首次 `@bot` 绑定、后续免 `@` 继续协作。

### Steps

1. 在群里发送：

   ```text
   @OpenCode 帮我总结一下这个仓库现在的能力边界
   ```

2. 确认机器人正常响应
3. 不再 `@bot`，直接发送第二条群消息
4. 发送 `/who`
5. 发送 `/leave`
6. 再发送一条不带 `@bot` 的普通消息

### Expected

- 首次 `@bot` 后，当前用户被写入群白名单
- 后续免 `@` 仍然继续响应
- `/who` 返回群绑定状态卡
- `/leave` 后再次免 `@` 不再响应

## Scene 3 · 权限按钮流

目标：展示真按钮权限流，而不是文本假按钮。

### Steps

1. 在私聊或群聊里给出一个会触发权限确认的任务
2. 等待紫色权限卡出现
3. 点击：
   - `/allow once · 仅此一次`
   - 或 `/allow always · 始终允许`
   - 或 `/deny · 拒绝`
4. 观察原卡被直接更新为终态
5. 重新触发一次权限请求，验证文本 fallback：
   - `/allow once`
   - `/allow always`
   - `/deny`

### Expected

- 原权限卡出现真实可点击按钮
- 点击后原卡直接更新为终态
- 文本命令 `/allow once`、`/allow always`、`/deny` 仍然可作为 fallback

## Scene 4 · Lark CLI 联动

目标：展示“在飞书里驱动 OpenCode，再由 OpenCode 调 `lark-cli` 落地飞书工作流”。

固定三选三场景如下。

### 场景 A · 创建会议纪要文档

```text
用 lark-doc 创建一份云文档，标题叫“Bridge Demo Meeting Notes”，写入今天的演示要点。
```

### 场景 B · 创建评审日程

```text
用 lark-calendar 创建一个明天下午 3 点开始、30 分钟的评审日程，标题叫“Bridge Demo Review”。
```

### 场景 C · 创建待办任务

```text
用 lark-task 创建一个待办，标题叫“整理 4/20 提交材料”，截止到本周五。
```

### 场景 D · 劳动 Skill 输出案件分析文档

```text
进入劳动分析流程，基于一组劳动争议材料输出一份飞书工作台文档，正文包含案件摘要、证据链总表、时间线、争议焦点与风险、法律依据，并自动插入时间线画板、证据关系图、请求项思维导图和补证流程图；同时挂出证据台账 Base。
```

演示参考文档：

- https://www.feishu.cn/docx/WaAVdy0KLo0QKzxxobUcunfUnBJ

演示参考 Base：

- https://pcn3o8owp0yw.feishu.cn/wiki/Ifu8w1HqcimlK0kWYAFcgoTzn4e

### Expected

- 至少成功演示其中 2 个
- 第 3 个和第 4 个可作为备选
- 重点强调 bridge 不直接操作飞书资源，而是把 OpenCode 和 `lark-cli` 串成一个会话化工作流

## Recording Notes

- Process Card、权限卡、群聊绑定卡建议都录一段短 GIF
- 如果时间有限，至少保留：
  - 私聊流程截图
  - 群聊绑定截图
  - 权限按钮截图
