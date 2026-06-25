/** Build memory store/extractor checks (run: npx tsx scripts/test-build-memory-store.mts) */
import {
  buildMemoryRecord,
  deriveBuildMemoryProjectKey,
} from "../lib/build-context/memory-store";
import {
  extractCommandMemories,
  extractProblemMemories,
  extractReviewMemories,
  extractSkillViolationMemories,
  extractUserNoteMemories,
} from "../lib/build-context/memory-extractors";
import {
  __resetClientStoreForTests,
  getBuildMemory,
  listBuildMemories,
  listActiveBuildMemories,
  updateBuildMemoryStatus,
  upsertBuildMemory,
} from "../lib/client/store";
import type { BuildProblem } from "../lib/db/schema";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const now = "2026-06-26T00:00:00.000Z";
const projectKey = deriveBuildMemoryProjectKey({
  repoRemoteUrl: "git@github.com:Example/AIBoard.git",
  runnerProjectRoot: "C:/Users/b_a_s/source/repos/ai-discussion-board",
  projectFolderName: "ai-discussion-board",
  discussionId: "disc-34",
});

check(
  "project key prefers normalized repo remote",
  projectKey === "repo:github.com/example/aiboard",
  projectKey
);
check(
  "https and ssh GitHub remotes normalize to same project key",
  deriveBuildMemoryProjectKey({ repoRemoteUrl: "https://github.com/example/aiboard.git", discussionId: "x" }) ===
    projectKey,
  deriveBuildMemoryProjectKey({ repoRemoteUrl: "https://github.com/example/aiboard.git", discussionId: "x" })
);
check(
  "project key falls back to runner root name then discussion id",
  deriveBuildMemoryProjectKey({ runnerProjectRoot: "C:/work/My Project", discussionId: "disc" }) ===
    "folder:my-project" &&
    deriveBuildMemoryProjectKey({ discussionId: "disc" }) === "discussion:disc"
);

const noteMemories = extractUserNoteMemories({
  projectKey,
  discussionId: "disc-34",
  notes: ["Use PowerShell commands; do not suggest bash-only syntax."],
  createdAt: now,
});
check(
  "user note creates evidence-backed user_correction memory",
  noteMemories.length === 1 &&
    noteMemories[0].kind === "user_correction" &&
    noteMemories[0].evidence.some((e) => e.kind === "user_note") &&
    noteMemories[0].summary.includes("PowerShell"),
  noteMemories
);

const patchProblem: BuildProblem = {
  id: "prob-patch",
  createdAt: now,
  code: "patch_failed",
  severity: "error",
  source: "file_writer",
  taskId: "T2",
  path: "src/App.tsx",
  message:
    '2 patch op(s) to src/App.tsx did NOT match the current file content. Missing SEARCH block(s): #1 "old markup".',
};
const conflictProblem: BuildProblem = {
  id: "prob-conflict",
  createdAt: now,
  code: "write_conflict",
  severity: "error",
  source: "file_writer",
  taskId: "T3",
  path: "src/App.tsx",
  message: "CONFLICT: T3 attempted to write src/App.tsx, which T2 already wrote in this wave.",
};
const problemMemories = extractProblemMemories({
  projectKey,
  discussionId: "disc-34",
  problems: [patchProblem, conflictProblem],
});
check(
  "patch/write problems create failed approach and fragile file memories",
  problemMemories.some((m) => m.kind === "failed_approach" && m.paths?.includes("src/App.tsx")) &&
    problemMemories.some((m) => m.kind === "fragile_file" && m.paths?.includes("src/App.tsx")) &&
    problemMemories.every((m) => m.evidence.length > 0),
  problemMemories
);

const reviewMemories = extractReviewMemories({
  projectKey,
  discussionId: "disc-34",
  results: [
    {
      taskId: "T4",
      verdict: "fix",
      fixInstructions: "The previous implementation forgot stale filtering; add active-only queries.",
      paths: ["lib/build-context/memory-brief.ts"],
    },
    { taskId: "T5", verdict: "approve", paths: ["lib/build-context/memory-store.ts"] },
  ],
  notes: "Decision: keep Build memory native to AIBoard instead of adding BuildContextManager.",
  createdAt: now,
});
check(
  "review fixes and accepted notes create evidence-backed memories",
  reviewMemories.some((m) => m.kind === "failed_approach" && m.taskIds?.includes("T4")) &&
    reviewMemories.some((m) => m.kind === "decision" && /native to AIBoard/.test(m.summary)),
  reviewMemories
);

const commandMemories = extractCommandMemories({
  projectKey,
  discussionId: "disc-34",
  commandResults: [
    { command: "npx tsc --noEmit", exitCode: 0, outputPreview: "ok", createdAt: now },
    { command: "npx tsc --noEmit", exitCode: 0, outputPreview: "ok again", createdAt: now },
    { command: "npm run lint", exitCode: 1, outputPreview: "lint failed", createdAt: now },
  ],
});
check(
  "repeated command pass creates reliable_command memory and command failure creates failed_approach",
  commandMemories.some((m) => m.kind === "reliable_command" && m.command === "npx tsc --noEmit") &&
    commandMemories.some((m) => m.kind === "failed_approach" && m.command === "npm run lint"),
  commandMemories
);

const skillMemories = extractSkillViolationMemories({
  projectKey,
  discussionId: "disc-34",
  violations: [
    {
      taskId: "T6",
      skillId: "superpowers:test-driven-development",
      violation: "Worker changed production code without RED test evidence.",
    },
  ],
  createdAt: now,
});
check(
  "skill violations create skill_violation memory",
  skillMemories.length === 1 &&
    skillMemories[0].kind === "skill_violation" &&
    skillMemories[0].summary.includes("RED test evidence"),
  skillMemories
);

__resetClientStoreForTests();
const first = buildMemoryRecord({
  projectKey,
  discussionId: "disc-34",
  kind: "user_correction",
  summary: "Use PowerShell commands; do not suggest bash-only syntax.",
  evidence: [{ kind: "user_note", ref: "disc-34#note-1", excerpt: "Use PowerShell commands" }],
  createdAt: now,
});
upsertBuildMemory(first);
upsertBuildMemory({ ...first, lastSeenAt: "2026-06-26T00:01:00.000Z" });
check(
  "client store dedupes build memory upserts by deterministic id",
  listBuildMemories(projectKey).length === 1 &&
    getBuildMemory(first.id)?.hitCount === 2 &&
    getBuildMemory(first.id)?.lastSeenAt === "2026-06-26T00:01:00.000Z",
  listBuildMemories(projectKey)
);

const stale = buildMemoryRecord({
  projectKey,
  kind: "decision",
  summary: "Old decision",
  evidence: [{ kind: "review", ref: "review-old" }],
  createdAt: now,
});
upsertBuildMemory(stale);
updateBuildMemoryStatus(stale.id, "stale");
check(
  "memory statuses can be stale/superseded/dismissed and active listing filters them",
  getBuildMemory(stale.id)?.status === "stale" &&
    listBuildMemories(projectKey).length === 2 &&
    listActiveBuildMemories(projectKey).length === 1,
  listBuildMemories(projectKey)
);

console.log(failed === 0 ? "\nAll build memory store checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
