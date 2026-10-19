import assert from "node:assert/strict";
import test from "node:test";

import { assertOpenArchitectQuestionAllowsEvent, assertPendingUserGuidanceAllowsEvent, type SchedulerProjection } from "../src/scheduler-store.js";

test("an owner's repair answer passes the pending-guidance and open-question gates (tunnel run deadlock)", () => {
  const pendingGuidance = { userGuidance: { g1: { status: "submitted", version: 1, guidanceId: "g1" } }, architectQuestions: {} } as unknown as SchedulerProjection;
  const openQuestion = { blockingArchitectQuestionId: "q1", userGuidance: {}, architectQuestions: {} } as unknown as SchedulerProjection;
  for (const type of ["repair.issue_budget_extended", "repair.external_blocker_cleared", "repair.cycle_limit_extended"] as const) {
    const owner = { type, actor: { role: "user" as const, id: "local-user" }, payload: {} };
    assert.doesNotThrow(() => assertPendingUserGuidanceAllowsEvent(pendingGuidance, owner), type);
    assert.doesNotThrow(() => assertOpenArchitectQuestionAllowsEvent(openQuestion, owner), type);
    assert.throws(() => assertPendingUserGuidanceAllowsEvent(pendingGuidance, { ...owner, actor: { role: "architect" as never, id: "a" } }), /must be acknowledged/, "only the owner");
  }
});
