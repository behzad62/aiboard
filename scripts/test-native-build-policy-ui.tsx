import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BuildRunPolicyControl } from "../components/BuildRunPolicyControl";

function renderPolicy(runPolicy: "finish" | "budgeted" | "plan_only"): string {
  return renderToStaticMarkup(
    <BuildRunPolicyControl
      value={{
        runPolicy,
        skillMode: "balanced",
        budgetUsd: 2.75,
        timeLimitMinutes: 45,
        alwaysRequireIndependentVerifier: false,
      }}
      onChange={() => undefined}
    />
  );
}

const finish = renderPolicy("finish");
assert.match(
  finish,
  /Continues until completed, blocked, or explicitly stopped\./
);
assert.doesNotMatch(finish, /build-budget-usd/);
assert.doesNotMatch(finish, /build-time-minutes/);
assert.match(finish, /Always run independent verification/);
assert.match(
  finish,
  /High-risk builds always require an independent verifier\. Enable this to verify low-risk builds too\./
);
assert.match(finish, /build-always-independent-verifier/);

const planOnly = renderPolicy("plan_only");
assert.doesNotMatch(planOnly, /build-budget-usd/);
assert.doesNotMatch(planOnly, /build-time-minutes/);

const budgeted = renderPolicy("budgeted");
assert.match(budgeted, /build-budget-usd/);
assert.match(budgeted, /build-time-minutes/);

console.log("PASS native Build policy UI");
