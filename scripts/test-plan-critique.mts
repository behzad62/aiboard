/** Plan critique gate checks (run: npx tsx scripts/test-plan-critique.mts) */
import {
  parsePlanCritique,
  planCritiqueHasBlockingIssues,
  buildPlanCritiqueDigest,
  buildPlanCritiquePrompt,
  buildPlanRevisionPrompt,
  type PlanCritiqueResult,
} from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

// ---------------------------------------------------------------------------
// parsePlanCritique
// ---------------------------------------------------------------------------

// Bare object, approve verdict, empty arrays.
{
  const parsed = parsePlanCritique('{"verdict":"approve","issues":[],"missingWork":[]}');
  check("approve/empty parses", parsed?.verdict === "approve", parsed);
  check(
    "approve/empty has empty arrays",
    parsed?.issues.length === 0 && parsed?.missingWork.length === 0,
    parsed
  );
}

// Prose + fenced json revise object with two issues + missingWork.
{
  const text = [
    "Here is my review of the plan.",
    "The decomposition is mostly fine but T1 is under-specified and misses a piece.",
    "",
    "```json",
    JSON.stringify({
      verdict: "revise",
      issues: [
        { taskId: "T1", severity: "blocking", issue: "X", suggestion: "Y" },
        { severity: "minor", issue: "Z" },
      ],
      missingWork: ["W"],
    }),
    "```",
  ].join("\n");
  const parsed = parsePlanCritique(text);
  check("prose+fenced revise parses", parsed?.verdict === "revise", parsed);
  check("prose+fenced: 2 issues", parsed?.issues.length === 2, parsed?.issues);
  check(
    "prose+fenced: first issue blocking with taskId/suggestion",
    parsed?.issues[0].severity === "blocking" &&
      parsed?.issues[0].taskId === "T1" &&
      parsed?.issues[0].issue === "X" &&
      parsed?.issues[0].suggestion === "Y",
    parsed?.issues[0]
  );
  check(
    "prose+fenced: second issue minor, no taskId",
    parsed?.issues[1].severity === "minor" && parsed?.issues[1].taskId === undefined,
    parsed?.issues[1]
  );
  check(
    "prose+fenced: missingWork = [W]",
    JSON.stringify(parsed?.missingWork) === JSON.stringify(["W"]),
    parsed?.missingWork
  );
}

// Malformed issue entries dropped: one entry with no issue text, one ok.
{
  const parsed = parsePlanCritique(
    JSON.stringify({
      verdict: "revise",
      issues: [{ severity: "blocking" }, { issue: "ok" }],
      missingWork: [],
    })
  );
  check("malformed issue dropped: length 1", parsed?.issues.length === 1, parsed?.issues);
  check(
    "malformed issue dropped: severity defaults minor",
    parsed?.issues[0].severity === "minor" && parsed?.issues[0].issue === "ok",
    parsed?.issues[0]
  );
}

// Unknown verdict -> null.
{
  check(
    "unknown verdict -> null",
    parsePlanCritique('{"verdict":"maybe","issues":[],"missingWork":[]}') === null
  );
}

// Non-object -> null.
{
  check("non-object -> null", parsePlanCritique("[1,2,3]") === null);
}

// Text with no candidates -> null.
{
  check("no candidates -> null", parsePlanCritique("just some prose, no json here") === null);
}

// Disambiguation: a plan action object and a critique verdict object both appear;
// the critique parser must pick the verdict object, not the plan action.
{
  const text = [
    "```json", '{"action":"plan","tasks":[{"id":"T1","title":"x"}]}', "```",
    "```json", '{"verdict":"revise","issues":[{"severity":"blocking","issue":"missing dep"}],"missingWork":[]}', "```",
  ].join("\n");
  const parsed = parsePlanCritique(text);
  check("picks critique verdict over a plan action object",
    parsed?.verdict === "revise" && parsed?.issues[0]?.issue === "missing dep", parsed);
}

// missingWork entries trimmed + non-empty filtered.
{
  const parsed = parsePlanCritique(
    JSON.stringify({
      verdict: "revise",
      issues: [],
      missingWork: ["  keep me  ", "", "   "],
    })
  );
  check(
    "missingWork trimmed + empties dropped",
    JSON.stringify(parsed?.missingWork) === JSON.stringify(["keep me"]),
    parsed?.missingWork
  );
}

// ---------------------------------------------------------------------------
// planCritiqueHasBlockingIssues
// ---------------------------------------------------------------------------

const critique = (over: Partial<PlanCritiqueResult>): PlanCritiqueResult => ({
  verdict: "revise",
  issues: [],
  missingWork: [],
  ...over,
});

check(
  "approve-with-issues -> not blocking",
  planCritiqueHasBlockingIssues(
    critique({ verdict: "approve", issues: [{ severity: "blocking", issue: "x" }] })
  ) === false
);
check(
  "revise + only minor issues + no missingWork -> not blocking",
  planCritiqueHasBlockingIssues(
    critique({ verdict: "revise", issues: [{ severity: "minor", issue: "x" }] })
  ) === false
);
check(
  "revise + one blocking issue -> blocking",
  planCritiqueHasBlockingIssues(
    critique({ verdict: "revise", issues: [{ severity: "blocking", issue: "x" }] })
  ) === true
);
check(
  "revise + missingWork non-empty, zero issues -> blocking",
  planCritiqueHasBlockingIssues(
    critique({ verdict: "revise", issues: [], missingWork: ["forgot"] })
  ) === true
);

// ---------------------------------------------------------------------------
// buildPlanCritiquePrompt
// ---------------------------------------------------------------------------

{
  const tasksJson = JSON.stringify(
    [{ id: "T1", title: "Do a thing", outputPaths: ["src/a.ts"] }],
    null,
    1
  );
  const prompt = buildPlanCritiquePrompt({
    request: "Build a widget app",
    treeText: "src/\n  index.ts",
    phaseSpec: {
      id: "P1",
      objective: "ship the widget",
      acceptanceCriteria: ["widget renders"],
      qualityCriteria: ["typed"],
      verification: ["tsc --noEmit"],
    },
    tasksJson,
    notes: "use TypeScript strict",
    verifyCommand: "npx tsc --noEmit",
    workerNames: ["Alpha", "Beta"],
  });
  check("critique prompt embeds the tasks JSON", prompt.includes(tasksJson), prompt.slice(0, 200));
  check(
    "critique prompt has the verdict schema line",
    prompt.includes('{"verdict":"approve"'),
    "missing schema line"
  );
  check(
    "critique prompt mentions dependsOn attack point",
    prompt.includes("dependsOn"),
    "missing dependsOn"
  );
  check(
    "critique prompt mentions verifyCommand attack point",
    prompt.includes("verifyCommand"),
    "missing verifyCommand"
  );
  check(
    "critique prompt mentions overlapping outputPaths",
    prompt.includes("outputPaths"),
    "missing outputPaths"
  );
  check("critique prompt lists worker names", prompt.includes("Alpha") && prompt.includes("Beta"));
  check("critique prompt embeds the request", prompt.includes("Build a widget app"));
}

// Optional fields omitted must not crash and must still produce the schema line.
{
  const prompt = buildPlanCritiquePrompt({
    request: "Minimal request",
    treeText: "",
    tasksJson: "[]",
    workerNames: ["Solo"],
  });
  check(
    "critique prompt works with only required inputs",
    prompt.includes('{"verdict":"approve"') && prompt.includes("Minimal request"),
    prompt.slice(0, 120)
  );
}

// ---------------------------------------------------------------------------
// buildPlanRevisionPrompt
// ---------------------------------------------------------------------------

{
  const originalPlanJson = JSON.stringify([{ id: "T1", title: "Original" }], null, 1);
  const critiqueDigest = "- [blocking T1] missing error handling — fix: add try/catch";
  const prompt = buildPlanRevisionPrompt({
    request: "Build a widget app",
    treeText: "src/",
    originalPlanJson,
    critiqueDigest,
    maxTasks: 6,
  });
  check("revision prompt embeds the original plan JSON", prompt.includes(originalPlanJson));
  check("revision prompt embeds the critique digest", prompt.includes(critiqueDigest));
  check("revision prompt states the maxTasks number", prompt.includes("6"), "missing maxTasks 6");
  check("revision prompt embeds the request", prompt.includes("Build a widget app"));
  check(
    "revision prompt asks for a plan action",
    prompt.includes('action "plan"') || prompt.includes('"action":"plan"'),
    "missing plan-emission instruction"
  );
}

// ---------------------------------------------------------------------------
// buildPlanCritiqueDigest
// ---------------------------------------------------------------------------

{
  const critiqueResult: PlanCritiqueResult = {
    verdict: "revise",
    issues: [
      { taskId: "T1", severity: "blocking", issue: "missing error handling", suggestion: "add try/catch" },
      { severity: "minor", issue: "prefer const" },
    ],
    missingWork: ["no tests for the parser"],
  };
  const digest = buildPlanCritiqueDigest(critiqueResult, 2000);
  const lines = digest.split("\n");
  check(
    "digest renders blocking, then missing work, then minor — in that order",
    lines[0] === "- [blocking T1] missing error handling — fix: add try/catch" &&
      lines[1] === "- [missing work] no tests for the parser" &&
      lines[2] === "- [minor] prefer const",
    lines
  );
  // A tiny maxChars cap truncates with the engine's trailing marker.
  const capped = buildPlanCritiqueDigest(critiqueResult, 10);
  check(
    "digest truncates at a tiny maxChars cap",
    capped.length < digest.length && capped.endsWith("…[truncated]") && capped.startsWith(digest.slice(0, 10)),
    capped
  );
}

process.exit(failed === 0 ? 0 : 1);
