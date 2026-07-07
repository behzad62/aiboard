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

process.exit(failed === 0 ? 0 : 1);
