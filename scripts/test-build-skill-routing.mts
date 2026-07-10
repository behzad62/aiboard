/** Build skill routing checks (run: npx tsx scripts/test-build-skill-routing.mts) */
import { selectSkills } from "../lib/skills/router";
import type { BuildTask } from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const docsFixTask: BuildTask = {
  id: "T3",
  title: "Update docs for architecture-diagram workflow and LLM configuration",
  instructions:
    "Required skill evidence is missing. Return a Skill evidence section or update README.md only.",
  contextFiles: ["tests/frontend-contract.test.js", "README.md"],
  outputPaths: ["README.md"],
  expectedOutputs: "README.md documents the workflow and LLM configuration",
  status: "fixing",
};

const activation = selectSkills({
  phase: "worker",
  actor: "worker",
  userRequest: "Create a web app that diagrams local git repositories.",
  task: docsFixTask,
  touchedPaths: [...docsFixTask.contextFiles, ...docsFixTask.outputPaths],
  riskFlags: ["runner"],
  runnerAvailable: true,
  repoAvailable: true,
  skillMode: "safe",
  mcpServers: ["playwright"],
});

check(
  "docs-only fixing task remains documentation-scoped under safe runner mode",
  activation.overlays.includes("agent:documentation-and-adrs") &&
    !activation.overlays.includes("agent:test-driven-development") &&
    !activation.overlays.includes("superpowers:systematic-debugging") &&
    !activation.overlays.includes("agent:security-and-hardening"),
  activation
);
check(
  "docs-only fixing task has no blocking code/security evidence requirements",
  activation.evidenceRequired.every((item) => /exemption|docs-only/i.test(item)) &&
    !activation.evidenceRequired.some((item) =>
      /RED test|GREEN test|Root cause|Trust boundary/i.test(item)
    ),
  activation.evidenceRequired
);

const repoCommitTask: BuildTask = {
  id: "T10",
  title: "Commit posture timing and documentation update",
  kind: "repo",
  completionMode: "evidence",
  verificationPolicy: "tool",
  instructions:
    "Use typed repo actions to inspect status and commit already-landed src/game.js and README.md changes.",
  contextFiles: ["src/game.js", "README.md"],
  outputPaths: [],
  expectedOutputs: "Commit evidence and repo status.",
  status: "planned",
};

const repoCommitActivation = selectSkills({
  phase: "worker",
  actor: "worker",
  userRequest: "Commit completed paintball arena implementation changes.",
  task: repoCommitTask,
  touchedPaths: repoCommitTask.contextFiles,
  riskFlags: ["repo"],
  runnerAvailable: true,
  repoAvailable: true,
  skillMode: "strict",
});

check(
  "repo evidence tasks do not require worker skill overlays",
  repoCommitActivation.overlays.length === 0 &&
    repoCommitActivation.evidenceRequired.length === 0,
  repoCommitActivation
);

const repoBrowserVerificationTask: BuildTask = {
  id: "T7",
  title: "Final repo verification with browser acceptance",
  kind: "repo",
  completionMode: "either",
  verificationPolicy: "external",
  instructions:
    "Run final repo status, repo diff, Playwright browser acceptance, console checks, and screenshot evidence. Report evidence in the worker response.",
  contextFiles: ["index.html", "src/game.js", "src/renderer.js", "src/main.js"],
  outputPaths: ["diff/status"],
  expectedOutputs:
    "Final verification evidence with browser acceptance, console status, repo status, and repo diff.",
  status: "planned",
};

const repoBrowserVerificationActivation = selectSkills({
  phase: "worker",
  actor: "worker",
  userRequest: "Verify and report final browser acceptance evidence for the game.",
  task: repoBrowserVerificationTask,
  touchedPaths: repoBrowserVerificationTask.contextFiles,
  riskFlags: ["repo"],
  runnerAvailable: true,
  repoAvailable: true,
  skillMode: "strict",
  mcpServers: ["playwright"],
});

check(
  "repo browser verification tasks receive browser evidence guidance without TDD",
  repoBrowserVerificationActivation.overlays.includes("aiboard:browser-acceptance") &&
    !repoBrowserVerificationActivation.overlays.includes(
      "superpowers:strict-test-driven-development"
    ) &&
    !repoBrowserVerificationActivation.overlays.includes("agent:test-driven-development") &&
    repoBrowserVerificationActivation.evidenceRequired.some((item) =>
      /browser-acceptance|browser_navigate|console/i.test(item)
    ),
  repoBrowserVerificationActivation
);

const finalVerificationTask: BuildTask = {
  id: "T12",
  title: "Run final updated verification and browser acceptance",
  kind: "verify",
  completionMode: "evidence",
  verificationPolicy: "tool",
  instructions:
    "Run final deterministic checks, browser acceptance, repo status, and report evidence only.",
  contextFiles: ["src/game.js", "src/renderer.js", "src/main.js", "index.html"],
  outputPaths: [],
  expectedOutputs: "Final verification evidence and browser acceptance.",
  status: "planned",
};

const finalVerificationActivation = selectSkills({
  phase: "worker",
  actor: "worker",
  userRequest: "Verify the completed paintball arena implementation.",
  task: finalVerificationTask,
  touchedPaths: finalVerificationTask.contextFiles,
  riskFlags: ["runner"],
  runnerAvailable: true,
  repoAvailable: true,
  skillMode: "strict",
  mcpServers: ["playwright"],
});

check(
  "strict verification-only tasks require acceptance evidence without TDD",
  finalVerificationActivation.overlays.includes("aiboard:browser-acceptance") &&
    !finalVerificationActivation.overlays.includes(
      "superpowers:strict-test-driven-development"
    ) &&
    !finalVerificationActivation.overlays.includes("agent:test-driven-development") &&
    !finalVerificationActivation.evidenceRequired.some((item) =>
      /test-driven-development|RED test|GREEN test/i.test(item)
    ),
  finalVerificationActivation
);

const staticBrowserAuditTask: BuildTask = {
  id: "T1",
  title: "Prepare safe branch and audit current script/API shape",
  kind: "audit",
  completionMode: "evidence",
  verificationPolicy: "architect",
  instructions:
    "Inspect the current static-browser loading model and public API usage. Do not edit files. Report script load order and browser module compatibility.",
  contextFiles: ["index.html", "src/game.js", "src/main.js", "src/renderer.js"],
  outputPaths: [],
  expectedOutputs: "Evidence-only API and module-shape audit; no file changes.",
  status: "fixing",
};

const staticBrowserAuditActivation = selectSkills({
  phase: "worker",
  actor: "worker",
  userRequest: "Preserve the static browser game while changing engagement behavior.",
  task: staticBrowserAuditTask,
  touchedPaths: staticBrowserAuditTask.contextFiles,
  riskFlags: ["repo"],
  runnerAvailable: true,
  repoAvailable: true,
  skillMode: "strict",
  mcpServers: ["playwright"],
});

check(
  "static browser architecture audit does not require end-to-end browser acceptance",
  !staticBrowserAuditActivation.overlays.includes("aiboard:browser-acceptance") &&
    !staticBrowserAuditActivation.evidenceRequired.some((item) =>
      /browser_navigate|browser-acceptance|console evidence/i.test(item)
    ),
  staticBrowserAuditActivation
);

const explicitBrowserAuditActivation = selectSkills({
  phase: "worker",
  actor: "worker",
  userRequest: "Audit the running game in Chrome.",
  task: {
    ...staticBrowserAuditTask,
    id: "T-browser-audit",
    title: "Audit the live browser acceptance workflow",
    instructions:
      "Use Playwright browser_navigate on localhost, inspect the settled visible UI, and check browser console errors.",
  },
  touchedPaths: staticBrowserAuditTask.contextFiles,
  riskFlags: [],
  runnerAvailable: true,
  repoAvailable: true,
  skillMode: "strict",
  mcpServers: ["playwright"],
});

check(
  "explicit live-browser audit still requires browser acceptance evidence",
  explicitBrowserAuditActivation.overlays.includes("aiboard:browser-acceptance"),
  explicitBrowserAuditActivation
);

process.exit(failed === 0 ? 0 : 1);
