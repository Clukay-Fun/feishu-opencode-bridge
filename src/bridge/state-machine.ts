import type { BridgeTurn } from "./turn.js";

export function transitionTurn(turn: BridgeTurn, nextState: "running" | "done" | "timeout" | "aborted"): BridgeTurn {
  const nextTurn: BridgeTurn = {
    ...turn,
    state: nextState,
  };
  if (nextState === "running") {
    nextTurn.startedAt = turn.startedAt ?? Date.now();
  } else if (turn.startedAt !== undefined) {
    nextTurn.startedAt = turn.startedAt;
  }
  return nextTurn;
}
