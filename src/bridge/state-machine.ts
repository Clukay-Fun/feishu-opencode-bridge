import type { BridgeTurn } from "./turn.js";

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
