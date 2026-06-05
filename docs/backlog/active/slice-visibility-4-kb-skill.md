# Slice: Agent Visibility · Slice 4 · Knowledge Base Skill

依据:[`docs/adr/0005-bridge-agent-visibility-boundary.md`](../../adr/0005-bridge-agent-visibility-boundary.md)。
**前置**:Slice 3 验收通过。

## 目标

让 agent 知道 Bridge 有知识库能力、什么时候建议用、入口在哪。**本 slice 只做 skill,不做 MCP**——`Bridge_kb_query` 属于 `_query` 类(有 embedding/DB IO),要等 ADR 0005 把 `_query` 命名规范 + 调用频次约束在 v2 落实后再做。

## 范围

### 包含

- `.opencode/skills/knowledge-base/SKILL.md`(新建):
  - **何时建议用知识库**(明确触发场景):
    - 用户问"法律XX怎么规定" / "公司过往合同里有没有类似条款"
    - 不要在普通常识问题上建议
  - **入口说明**:
    - 自然语言:`法律问答 <问题>`
    - slash:`/法律问答 <问题>` / `/法律咨询开始`
    - 入库:`/知识入库` ... `/知识入库结束`
  - **回答规范**(尤其重要):
    - 引用知识库返回时,必须**保留来源标注**
    - 不要把知识库结果当 ground truth — 标注 "来自 Bridge 知识库,日期 / 来源 XX"
    - 知识库未命中时**明确说**,不要编造
  - **agent 自己不能查**:目前没有 `_query` MCP,agent 只能引导用户发命令,**不能**自称 "我帮你查了知识库" 然后编内容

### 不包含

- `Bridge_kb_query` MCP(v2)
- `Bridge_case_query`(v2)
- 任何写权限(入库、删库 走 Bridge 命令)
- system prompt 收敛(Slice 5)

## 验收

- "公司过往合同里有没有竞业限制类似条款?" → agent 建议 "建议发送 `法律问答 公司竞业限制条款` 让 Bridge 走知识库"
- "查一下劳动法第 38 条" → agent 引导走知识库入口,**不**编造法条原文
- agent **不**自称 "我查了知识库" — 当前没有 `Bridge_kb_query`,任何此类声明都是伪造

## 未完成项清单

- system prompt 收敛(Slice 5)
- `Bridge_kb_query` 工具实现(v2,需先在 ADR 0005 / 新 ADR 把 `_query` 调用频次/来源契约定下来)
- 多知识库切换的状态(若需要,可加 `Bridge_kb_status`,但要避免和本 skill 漂)
