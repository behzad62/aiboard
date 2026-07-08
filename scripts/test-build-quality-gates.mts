/** Build quality gate checks (run: npx tsx scripts/test-build-quality-gates.mts) */
import {
  evaluateBuildQualityGate,
  formatBuildQualityGateSummary,
  shouldRequireBrowserAcceptance,
  shouldRequireRequestFulfillment,
} from "../lib/orchestrator/build-quality-gates";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const cleanStatus = {
  isRepo: true,
  currentBranch: "codex/example",
  upstream: "origin/codex/example",
  ahead: 0,
  behind: 0,
  staged: [] as string[],
  unstaged: [] as string[],
  untracked: [] as string[],
  conflicted: [] as string[],
  clean: true,
};

const cleanReady = evaluateBuildQualityGate({
  githubWorkflow: true,
  expectedPr: true,
  repoStatus: cleanStatus,
  repoPrUrl: "https://github.com/example/repo/pull/1",
  repoPushedBranch: "codex/example",
  requiredChecks: [
    { name: "TypeScript", command: "npx tsc --noEmit", status: "passed" },
    { name: "Lint", command: "npm run lint", status: "passed" },
    { name: "Build", command: "npm run build", status: "passed" },
  ],
  issueNumbers: [18, 19, 20],
});

check("clean ready gate passes", cleanReady.status === "ready", cleanReady);
check("ready gate has issue warning", cleanReady.warnings.some((w) => /close on merge/i.test(w.message)), cleanReady);

const dirty = evaluateBuildQualityGate({
  githubWorkflow: true,
  expectedPr: true,
  repoStatus: {
    ...cleanStatus,
    clean: false,
    unstaged: ["app/games/games-client.tsx"],
  },
  repoPrUrl: "https://github.com/example/repo/pull/1",
  repoPushedBranch: "codex/example",
  requiredChecks: [
    { name: "TypeScript", command: "npx tsc --noEmit", status: "passed" },
  ],
});

check("dirty tree blocks completion", dirty.status === "blocked", dirty);
check("dirty tree names changed file", dirty.blockers.some((b) => b.message.includes("app/games/games-client.tsx")), dirty);

const aheadWithPr = evaluateBuildQualityGate({
  githubWorkflow: true,
  expectedPr: true,
  repoStatus: { ...cleanStatus, ahead: 1 },
  repoPrUrl: "https://github.com/example/repo/pull/1",
  repoPushedBranch: "codex/example",
  requiredChecks: [
    { name: "TypeScript", command: "npx tsc --noEmit", status: "passed" },
  ],
});

check("local branch ahead after PR blocks completion", aheadWithPr.status === "blocked", aheadWithPr);
check("local branch ahead explains stale PR", aheadWithPr.blockers.some((b) => /PR is stale/i.test(b.message)), aheadWithPr);

const missingChecks = evaluateBuildQualityGate({
  githubWorkflow: true,
  expectedPr: true,
  repoStatus: cleanStatus,
  repoPrUrl: "https://github.com/example/repo/pull/1",
  repoPushedBranch: "codex/example",
  requiredChecks: [
    { name: "TypeScript", command: "npx tsc --noEmit", status: "passed" },
    { name: "Lint", command: "npm run lint", status: "missing" },
    { name: "Build", command: "npm run build", status: "failed", outputPreview: "prefer-const" },
  ],
});

check("missing and failed checks block completion", missingChecks.blockers.length === 2, missingChecks);
check("failed check includes output preview", missingChecks.blockers.some((b) => b.details?.includes("prefer-const")), missingChecks);

const missingSkillEvidence = evaluateBuildQualityGate({
  githubWorkflow: true,
  expectedPr: true,
  repoStatus: cleanStatus,
  repoPrUrl: "https://github.com/example/repo/pull/1",
  repoPushedBranch: "codex/example",
  requiredChecks: [
    { name: "TypeScript", command: "npx tsc --noEmit", status: "passed" },
  ],
  skillEvidence: [
    {
      taskId: "T1",
      skillId: "agent:test-driven-development",
      actor: "worker",
      required: [
        "RED test/check failure before implementation",
        "GREEN test/check pass after implementation",
      ],
      reportedEvidence: [],
      missingEvidence: ["RED test/check failure before implementation"],
      violations: [
        "Missing required evidence for agent:test-driven-development: RED test/check failure before implementation",
      ],
    },
  ],
});

check("missing skill evidence blocks final completion", missingSkillEvidence.status === "blocked", missingSkillEvidence);
check(
  "skill evidence blocker names the task",
  missingSkillEvidence.blockers.some((b) => b.code === "skill_evidence_missing" && b.message.includes("T1")),
  missingSkillEvidence
);

const architectPolicySkillEvidence = evaluateBuildQualityGate({
  githubWorkflow: true,
  expectedPr: true,
  repoStatus: cleanStatus,
  repoPrUrl: "https://github.com/example/repo/pull/1",
  repoPushedBranch: "codex/example",
  requiredChecks: [
    { name: "TypeScript", command: "npx tsc --noEmit", status: "passed" },
  ],
  tasks: [
    {
      id: "T2",
      title: "Audit posture behavior",
      instructions: "Inspect current posture behavior and report evidence.",
      contextFiles: ["src/game.js"],
      outputPaths: ["src/game.js"],
      status: "done",
      kind: "audit",
      completionMode: "either",
      verificationPolicy: "architect",
    },
  ],
  skillEvidence: [
    {
      taskId: "T2",
      skillId: "superpowers:strict-test-driven-development",
      actor: "worker",
      required: ["RED test/check failure before implementation"],
      reportedEvidence: ["Architect review evidence is enough for this audit task."],
      missingEvidence: ["RED test/check failure before implementation"],
      violations: [
        "Missing required evidence for superpowers:strict-test-driven-development: RED test/check failure before implementation",
      ],
    },
  ],
});

check(
  "architect-policy skill evidence gaps do not block final quality gate",
  architectPolicySkillEvidence.status === "ready" &&
    architectPolicySkillEvidence.blockers.every((b) => b.code !== "skill_evidence_missing"),
  architectPolicySkillEvidence
);
check(
  "architect-policy skill evidence gaps remain visible as warnings",
  architectPolicySkillEvidence.warnings.some((b) => b.code === "skill_evidence_missing" && b.message.includes("T2")),
  architectPolicySkillEvidence
);

const missingBrowserAcceptance = evaluateBuildQualityGate({
  githubWorkflow: false,
  expectedPr: false,
  repoStatus: null,
  repoPrUrl: null,
  repoPushedBranch: null,
  requiredChecks: [
    { name: "Tests", command: "npm test", status: "passed" },
  ],
  browserAcceptance: {
    required: true,
    observed: false,
    reason: "web app request with local server",
  },
});

check(
  "missing browser acceptance blocks web app completion",
  missingBrowserAcceptance.status === "blocked" &&
    missingBrowserAcceptance.blockers.some((b) => b.code === "browser_acceptance_missing"),
  missingBrowserAcceptance
);

const presentBrowserAcceptance = evaluateBuildQualityGate({
  githubWorkflow: false,
  expectedPr: false,
  repoStatus: null,
  repoPrUrl: null,
  repoPushedBranch: null,
  requiredChecks: [
    { name: "Tests", command: "npm test", status: "passed" },
  ],
  browserAcceptance: {
    required: true,
    observed: true,
    reason: "browser snapshot after main flow",
  },
});

check("observed browser acceptance allows web app completion", presentBrowserAcceptance.status === "ready", presentBrowserAcceptance);

const missingRequestFulfillment = evaluateBuildQualityGate({
  githubWorkflow: false,
  expectedPr: false,
  repoStatus: null,
  repoPrUrl: null,
  repoPushedBranch: null,
  requiredChecks: [
    { name: "Tests", command: "npm test", status: "passed" },
  ],
  browserAcceptance: {
    required: true,
    observed: true,
    reason: "browser snapshot after main flow",
  },
  requestFulfillment: {
    required: true,
    observed: false,
    reason: "review did not explicitly compare the landed output against the original user request",
  },
});

check(
  "missing request fulfillment blocks completion even when browser acceptance ran",
  missingRequestFulfillment.status === "blocked" &&
    missingRequestFulfillment.blockers.some((b) => b.code === "request_fulfillment_missing"),
  missingRequestFulfillment
);

const presentRequestFulfillment = evaluateBuildQualityGate({
  githubWorkflow: false,
  expectedPr: false,
  repoStatus: null,
  repoPrUrl: null,
  repoPushedBranch: null,
  requiredChecks: [
    { name: "Tests", command: "npm test", status: "passed" },
  ],
  browserAcceptance: {
    required: true,
    observed: true,
    reason: "browser snapshot after main flow",
  },
  requestFulfillment: {
    required: true,
    observed: true,
    reason: "reviewer compared the delivered files and behavior against the user request",
  },
});

check("observed request fulfillment allows completion", presentRequestFulfillment.status === "ready", presentRequestFulfillment);

const noRunner = evaluateBuildQualityGate({
  githubWorkflow: true,
  expectedPr: true,
  repoStatus: null,
  repoPrUrl: null,
  repoPushedBranch: null,
  requiredChecks: [],
});

check("missing repo status blocks GitHub workflow", noRunner.status === "blocked", noRunner);
check("missing repo status explains runner requirement", noRunner.blockers.some((b) => /runner/i.test(b.message)), noRunner);

check(
  "web app requests require browser acceptance",
  shouldRequireBrowserAcceptance({
    request: "Create a web app that visualizes local git repos.",
    treeText: "server/server.js\npublic/index.html\npublic/app.js",
  }),
);
check(
  "non-UI libraries do not require browser acceptance",
  !shouldRequireBrowserAcceptance({
    request: "Build a strict TypeScript CSV library and CLI.",
    treeText: "src/index.ts\ntests/run-tests.ts",
  }),
);
check(
  "test-only verification fixes in web repos do not require browser acceptance",
  !shouldRequireBrowserAcceptance({
    request:
      "Fix the current CodeSketch verification failure only. Do not implement unrelated features.",
    treeText: "server/server.js\npublic/index.html\npublic/app.js\ntests/frontend-contract.test.js",
    changedFiles: ["tests/frontend-contract.test.js"],
  }),
);
check(
  "test-only web-app verification fixes do not require browser acceptance",
  !shouldRequireBrowserAcceptance({
    request:
      "Fix the web app verification failure only. Reproduce npm run check && npm test and do not implement unrelated features.",
    treeText: "server/server.js\npublic/index.html\npublic/app.js\ntests/frontend-contract.test.js",
    changedFiles: ["tests/frontend-contract.test.js"],
  }),
);
check(
  "ui file changes in web repos require browser acceptance",
  shouldRequireBrowserAcceptance({
    request: "Fix the current CodeSketch verification failure only.",
    treeText: "server/server.js\npublic/index.html\npublic/app.js",
    changedFiles: ["public/app.js"],
  }),
);
check(
  "any concrete build request requires request-fulfillment review",
  shouldRequireRequestFulfillment({
    request: "Change the web game to 3D voxel graphics with an isometric camera.",
    treeText: "index.html\nsrc/main.js\nsrc/renderer.js\nsrc/game.js",
    changedFiles: ["src/renderer.js", "src/styles.css"],
  }),
);
check(
  "non-visual CLI requests still require request-fulfillment review",
  shouldRequireRequestFulfillment({
    request: "Build a strict TypeScript CSV library and CLI.",
    treeText: "src/index.ts\ntests/run-tests.ts",
    changedFiles: ["src/index.ts"],
  }),
);
check(
  "test-only verification fixes still require request-fulfillment review",
  shouldRequireRequestFulfillment({
    request:
      "Fix the current web app verification failure only. Do not implement unrelated graphics features.",
    treeText: "index.html\nsrc/main.js\nsrc/renderer.js\ntests/frontend-contract.test.js",
    changedFiles: ["tests/frontend-contract.test.js"],
  }),
);

const summary = formatBuildQualityGateSummary(missingChecks);
check("summary has quality gate heading", summary.includes("Build quality gate"), summary);
check("summary names failed build command", summary.includes("npm run build"), summary);
check("summary includes output preview", summary.includes("prefer-const"), summary);

process.exit(failed === 0 ? 0 : 1);
