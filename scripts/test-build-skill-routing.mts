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

process.exit(failed === 0 ? 0 : 1);
