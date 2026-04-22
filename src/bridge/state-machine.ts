/**
 * 职责: 管理 BridgeTurn 的状态流转，并返回新的不可变状态对象。
 * 关注点:
 * - 统一处理 turn 在不同阶段之间的状态迁移。
 * - 在进入执行态时补齐 startedAt 等派生字段。
 */
import type { BridgeTurn } from "./turn.js";

/** 按目标状态生成新的 turn 对象，并补齐 startedAt。 */
export function transitionTurn(turn: BridgeTurn, nextState: "running" | "awaiting-sse" | "done" | "timeout" | "aborted"): BridgeTurn {
  const nextTurn: BridgeTurn = {
    ...turn,
    state: nextState,
  };
  if (nextState === "running" || nextState === "awaiting-sse") {
    nextTurn.startedAt = turn.startedAt ?? Date.now();
  } else if (turn.startedAt !== undefined) {
    nextTurn.startedAt = turn.startedAt;
  }
  return nextTurn;
}
