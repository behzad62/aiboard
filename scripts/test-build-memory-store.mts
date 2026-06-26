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
  migrateBuildMemoriesProjectKey,
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
  "project key falls back to runner root then discussion id without exposing raw absolute paths",
  deriveBuildMemoryProjectKey({ runnerProjectRoot: "C:/work/My Project", discussionId: "disc" }).startsWith(
    "folder:my-project-"
  ) &&
    !deriveBuildMemoryProjectKey({ runnerProjectRoot: "C:/work/My Project", discussionId: "disc" }).includes(
      "C:/work"
    ) &&
    deriveBuildMemoryProjectKey({ discussionId: "disc" }) === "discussion:disc"
);
const sameFolderNameA = deriveBuildMemoryProjectKey({
  runnerProjectRoot: "C:/work/alpha/ai-discussion-board",
  discussionId: "disc-a",
});
const sameFolderNameB = deriveBuildMemoryProjectKey({
  runnerProjectRoot: "D:/other/beta/ai-discussion-board",
  discussionId: "disc-b",
});
check(
  "folder fallback keys distinguish different paths with the same basename",
  sameFolderNameA !== sameFolderNameB &&
    sameFolderNameA.startsWith("folder:ai-discussion-board-") &&
    sameFolderNameB.startsWith("folder:ai-discussion-board-") &&
    !sameFolderNameA.includes("alpha") &&
    !sameFolderNameB.includes("beta"),
  { sameFolderNameA, sameFolderNameB }
);
const displayOnlyA = deriveBuildMemoryProjectKey({
  projectFolderName: "app",
  discussionId: "disc-display-a",
});
const displayOnlyB = deriveBuildMemoryProjectKey({
  projectFolderName: "app",
  discussionId: "disc-display-b",
});
check(
  "projectFolderName-only fallback does not create a shared folder key",
  displayOnlyA === "discussion:disc-display-a" &&
    displayOnlyB === "discussion:disc-display-b" &&
    displayOnlyA !== displayOnlyB &&
    !displayOnlyA.includes("app"),
  { displayOnlyA, displayOnlyB }
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
  createdAt: now,
});
check(
  "review fixes create memory but raw Architect notes do not create decisions",
  reviewMemories.some((m) => m.kind === "failed_approach" && m.taskIds?.includes("T4")) &&
    !reviewMemories.some((m) => m.kind === "decision"),
  reviewMemories
);
const genericReviewNoteMemories = extractReviewMemories({
  projectKey,
  discussionId: "disc-34",
  results: [],
  notes: "Use the current structure, prefer smaller helpers, and avoid rewrites.",
  createdAt: now,
});
check(
  "generic Architect notes with use/prefer/avoid do not create decision memory",
  genericReviewNoteMemories.length === 0,
  genericReviewNoteMemories
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

const oldKey = "discussion:disc-34";
const newKey = "repo:github.com/example/aiboard";
const migrating = buildMemoryRecord({
  projectKey: oldKey,
  discussionId: "disc-34",
  kind: "user_correction",
  summary: "Keep PowerShell-compatible commands.",
  evidence: [{ kind: "user_note", ref: "disc-34#note-migrate" }],
  createdAt: now,
});
upsertBuildMemory(migrating);
migrateBuildMemoriesProjectKey(oldKey, newKey);
check(
  "memories stored under an old key are listed under a refreshed key",
  listBuildMemories(oldKey).length === 0 &&
    listBuildMemories(newKey).some((memory) => memory.summary.includes("PowerShell")),
  { old: listBuildMemories(oldKey), next: listBuildMemories(newKey) }
);

console.log(failed === 0 ? "\nAll build memory store checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
