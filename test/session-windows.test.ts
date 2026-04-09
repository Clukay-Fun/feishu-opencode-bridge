import { describe, expect, it } from "vitest";

import type { MappingRecord, SessionWindowRecord } from "../src/store/mappings.js";
import {
  addSession,
  createSessionEntry,
  getActiveSession,
  normalizeSessionWindowRecord,
  removeSession,
  resolveSessionMode,
  setActiveSession,
} from "../src/runtime/session-windows.js";

describe("session windows", () => {
  it("resolves chat types into configured modes", () => {
    expect(resolveSessionMode("p2p", { p2p: "multi", group: "single", topicGroup: "single" })).toBe("multi");
    expect(resolveSessionMode("group", { p2p: "multi", group: "single", topicGroup: "multi" })).toBe("single");
    expect(resolveSessionMode("topic_group", { p2p: "single", group: "single", topicGroup: "multi" })).toBe("multi");
  });

  it("keeps only one active session in single mode", () => {
    const record: SessionWindowRecord = {
      mode: "single",
      activeSessionId: "ses_old",
      sessions: [
        { sessionId: "ses_old", label: "old", createdAt: 1, lastUsedAt: 1 },
        { sessionId: "ses_new", label: "new", createdAt: 2, lastUsedAt: 2 },
      ],
    };

    const normalized = normalizeSessionWindowRecord(record, "single", 20);
    expect(normalized.sessions).toHaveLength(1);
    expect(normalized.activeSessionId).toBe("ses_old");
  });

  it("adds and switches sessions in multi mode", () => {
    const now = 100;
    let record = normalizeSessionWindowRecord(undefined, "multi", 3);
    record = addSession(record, createSessionEntry("ses_1", now, "one"), 3);
    record = addSession(record, createSessionEntry("ses_2", now + 1, "two"), 3);
    record = setActiveSession(record, "ses_1", now + 2, 3);

    expect(getActiveSession(record)?.sessionId).toBe("ses_1");
    expect(record.sessions).toHaveLength(2);
  });

  it("trims multi-session windows by LRU", () => {
    let record = normalizeSessionWindowRecord(undefined, "multi", 2);
    record = addSession(record, createSessionEntry("ses_1", 1, "one"), 2);
    record = addSession(record, createSessionEntry("ses_2", 2, "two"), 2);
    record = addSession(record, createSessionEntry("ses_3", 3, "three"), 2);

    expect(record.sessions.map((session) => session.sessionId)).toEqual(["ses_3", "ses_2"]);
  });

  it("removes stale sessions and promotes the next active item", () => {
    const record = removeSession({
      mode: "multi",
      activeSessionId: "ses_2",
      sessions: [
        { sessionId: "ses_2", label: "two", createdAt: 2, lastUsedAt: 2 },
        { sessionId: "ses_1", label: "one", createdAt: 1, lastUsedAt: 1 },
      ],
    }, "ses_2", 5);

    expect(record.activeSessionId).toBe("ses_1");
    expect(record.sessions).toHaveLength(1);
  });

  it("keeps topic windows isolated by conversation key", () => {
    const mappings: MappingRecord = {};
    mappings["oc_group_1:om_root_a"] = addSession(
      normalizeSessionWindowRecord(undefined, "single", 20),
      createSessionEntry("ses_topic_a", 1, "topic-a"),
      20,
    );
    mappings["oc_group_1:om_root_b"] = addSession(
      normalizeSessionWindowRecord(undefined, "single", 20),
      createSessionEntry("ses_topic_b", 2, "topic-b"),
      20,
    );

    expect(getActiveSession(mappings["oc_group_1:om_root_a"])?.sessionId).toBe("ses_topic_a");
    expect(getActiveSession(mappings["oc_group_1:om_root_b"])?.sessionId).toBe("ses_topic_b");
    expect(mappings["oc_group_1:om_root_a"].activeSessionId).not.toBe(mappings["oc_group_1:om_root_b"].activeSessionId);
  });
});
