import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  initializeWorldSession,
  ensureWorldSession,
  resetWorldSession,
} from "../lib/world-state.mjs";

describe("Actor session lifecycle", () => {
  it("requires explicit initialization for a new backend", () => {
    const world = { profile: "白鹭千圣", _worldSessions: {} };
    assert.throws(
      () => ensureWorldSession(world, "cc"),
      /not initialized/,
    );

    const session = initializeWorldSession(world, "cc", { reason: "test initial" });
    assert.ok(session.sid);
    assert.equal(session.firstTurn, true);
    assert.equal(session.turnCount, 0);
    assert.equal(session.generation, 1);
  });

  it("refuses to repair a missing SID silently", () => {
    const world = {
      profile: "白鹭千圣",
      _worldSessions: {
        cc: {
          sid: null,
          firstTurn: false,
          model: "deepseek-v4-pro[1m]",
          startedAt: "2026-06-18T06:21:37.916Z",
          lastUsedAt: "2026-06-20T20:33:17+08:00",
          resetReason: "manual from GUI",
          lastUsage: { input_tokens: 10 },
          turnCount: 34,
          generation: 1,
        },
      },
    };

    assert.throws(
      () => ensureWorldSession(world, "cc"),
      /SID is missing; reset is required/,
    );
    assert.equal(world._worldSessions.cc.sid, null);
    assert.equal(world._worldSessions.cc.turnCount, 34);
  });

  it("changes SID only through an explicit reset and clears its accounting", () => {
    const world = { profile: "白鹭千圣", _worldSessions: {} };
    const session = initializeWorldSession(world, "cc", { reason: "test initial" });
    const oldSid = session.sid;
    session.firstTurn = false;
    session.turnCount = 12;
    session.lastUsage = { input_tokens: 100 };
    session.lastUsedAt = "2026-06-28T10:00:00+08:00";

    const reset = resetWorldSession(
      world,
      "cc",
      "manual test reset",
      "2026-06-28T11:00:00+08:00",
    );

    assert.notEqual(reset.sid, oldSid);
    assert.equal(reset.firstTurn, true);
    assert.equal(reset.turnCount, 0);
    assert.equal(reset.lastUsage, null);
    assert.equal(reset.lastUsedAt, null);
    assert.equal(reset.resetReason, "manual test reset");
    assert.equal(reset.generation, 2);
  });
});
