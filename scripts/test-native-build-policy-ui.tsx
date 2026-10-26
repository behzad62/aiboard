import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BuildRunPolicyControl } from "../components/BuildRunPolicyControl";

function renderPolicy(runPolicy: "finish" | "budgeted" | "plan_only", gated = false): string {
  return renderToStaticMarkup(
    <BuildRunPolicyControl
      value={{
        runPolicy,
        skillMode: "balanced",
        budgetUsd: 2.75,
        timeLimitMinutes: 45,
        alwaysRequireIndependentVerifier: false,
        evidenceGatedPlanning: gated,
      }}
      onChange={() => undefined}
    />
  );
}

const finish = renderPolicy("finish");
assert.match(finish, /Plan, code, review and test until the job is done/);
assert.match(finish, /No user-set cost or time cap/);
assert.doesNotMatch(finish, /build-budget-usd/);
assert.doesNotMatch(finish, /build-time-minutes/);
assert.match(finish, /Independently verify the final build/);
assert.match(finish, /Off: this extra check runs for high-risk builds only/);
assert.match(finish, /separately\s+from individual task reviews/);
assert.match(finish, /build-always-independent-verifier/);
assert.match(finish, /Approve the plan and independently review tasks/);
assert.match(finish, /Off: the Architect plans and reviews tasks/);
// Native Runner V2 does not consume buildSkillMode: don't expose working-looking no-op options.
assert.match(finish, /Skill presets \(Fast, Balanced, Strict, Safe\) are not offered/);
assert.doesNotMatch(finish, /<button[^>]+>\s*Fast skills/);

const gated = renderPolicy("finish", true);
assert.match(gated, /Each submitted worker task then gets its own/);
assert.match(gated, /higher-risk changes receive deeper checks and tests/);
assert.match(gated, /Review answers independently/);

const planOnly = renderPolicy("plan_only");
assert.match(planOnly, /No workers run and no implementation code is written/);
assert.doesNotMatch(planOnly, /build-budget-usd/);
assert.doesNotMatch(planOnly, /build-time-minutes/);

const budgeted = renderPolicy("budgeted");
assert.match(budgeted, /estimated USD spend or active-time limit/);
assert.match(budgeted, /build-budget-usd/);
assert.match(budgeted, /build-time-minutes/);
assert.match(budgeted, /At least one limit/);

console.log("PASS native Build policy UI");
