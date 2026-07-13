import assert from "node:assert/strict";
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

const planOnly = renderPolicy("plan_only");
assert.doesNotMatch(planOnly, /build-budget-usd/);
assert.doesNotMatch(planOnly, /build-time-minutes/);

const budgeted = renderPolicy("budgeted");
assert.match(budgeted, /build-budget-usd/);
assert.match(budgeted, /build-time-minutes/);

console.log("PASS native Build policy UI");
