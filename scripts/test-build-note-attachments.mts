/** Build follow-up note attachment checks (run: npx tsx scripts/test-build-note-attachments.mts) */
import { createRequire } from "node:module";
import {
  type addAttachment,
  type getBuildCheckpoint,
  type getDiscussionById,
  type getMessagesForDiscussion,
  type insertDiscussion,
  type updateDiscussion,
  type upsertBuildCheckpoint,
  type __resetClientStoreForTests,
} from "../lib/client/store";
import type { AttachmentRecord } from "../lib/attachments/types";
import type { BuildCheckpoint, Discussion } from "../lib/db/schema";

const require = createRequire(import.meta.url);
const storeApi = require("../lib/client/store") as {
  __resetClientStoreForTests: typeof __resetClientStoreForTests;
  addAttachment: typeof addAttachment;
  getBuildCheckpoint: typeof getBuildCheckpoint;
  insertDiscussion: typeof insertDiscussion;
  getDiscussionById: typeof getDiscussionById;
  getMessagesForDiscussion: typeof getMessagesForDiscussion;
  updateDiscussion: typeof updateDiscussion;
  upsertBuildCheckpoint: typeof upsertBuildCheckpoint;
};
const clientApi = require("../lib/client/api") as typeof import("../lib/client/api");

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
}

const now = "2026-06-29T00:00:00.000Z";
const existingAttachment: AttachmentRecord = {
  id: "existing-requirements",
  filename: "requirements.md",
  mimeType: "text/markdown",
  category: "text_inline",
  size: 32,
  textContent: "Original requirements",
  createdAt: now,
};
const newAttachment: AttachmentRecord = {
  id: "follow-up-diagram",
  filename: "diagram.png",
  mimeType: "image/png",
  category: "image",
  size: 256,
  base64Data: Buffer.from("png fixture").toString("base64"),
  createdAt: now,
};
const discussion: Discussion = {
  id: "disc-build-note-attachments",
  topic: "Build from initial and follow-up files.",
  mode: "build",
  effort: "medium",
  status: "completed",
  modelIds: JSON.stringify(["test:worker"]),
  judgeModelId: "test:architect",
  attachmentIds: JSON.stringify([existingAttachment.id]),
  currentRound: 2,
  maxRounds: 4,
  convergenceScore: null,
  buildStopReason: null,
  buildStoppedAt: null,
  nativeBuildRunId: "native-old-run",
  createdAt: now,
  updatedAt: now,
};

storeApi.__resetClientStoreForTests();
storeApi.addAttachment(existingAttachment);
storeApi.addAttachment(newAttachment);
storeApi.insertDiscussion(discussion);

const added = clientApi.addDiscussionAttachments(discussion.id, [
  newAttachment.id,
  existingAttachment.id,
]);
const updatedDiscussion = storeApi.getDiscussionById(discussion.id);
const updatedIds: string[] = updatedDiscussion?.attachmentIds
  ? JSON.parse(updatedDiscussion.attachmentIds)
  : [];

check(
  "follow-up attachments append to the discussion without duplicating existing files",
  updatedIds.length === 2 &&
    updatedIds[0] === existingAttachment.id &&
    updatedIds[1] === newAttachment.id,
  updatedIds
);
check(
  "append helper returns summaries for newly attached files",
  added.length === 1 &&
    added[0].id === newAttachment.id &&
    added[0].filename === newAttachment.filename &&
    added[0].category === newAttachment.category,
  added
);

const savedNote = clientApi.addBuildNote(
  discussion.id,
  `Please use the newly attached file: ${newAttachment.filename}.`
);
const continuedDiscussion = clientApi.continueDiscussion(discussion.id);
const resumed = clientApi.getDiscussionData(discussion.id);
const message = storeApi
  .getMessagesForDiscussion(discussion.id)
  .find((entry) => entry.id === savedNote.id);

check(
  "sending the note resumes the build with the expanded attachment set",
  resumed?.discussion.status === "pending" &&
    resumed.attachments.map((entry) => entry.id).join(",") ===
      `${existingAttachment.id},${newAttachment.id}`,
  resumed
    ? {
        status: resumed.discussion.status,
        attachments: resumed.attachments.map((entry) => entry.id),
      }
    : null
);
check(
  "continue returns the authoritative replacement native run identity",
  Boolean(
    continuedDiscussion?.nativeBuildRunId &&
    continuedDiscussion.nativeBuildRunId !== "native-old-run"
  ),
  continuedDiscussion?.nativeBuildRunId
);
check(
  "the Architect timeline note records the follow-up file name",
  message?.content.includes(newAttachment.filename) === true,
  message
);

const blockedCheckpoint: BuildCheckpoint = {
  discussionId: discussion.id,
  status: "blocked",
  stopReason: "blocked",
  updatedAt: now,
  wave: 7,
  tasks: [
    {
      id: "T1",
      title: "Failed implementation",
      instructions: "Continue the implementation.",
      contextFiles: [],
      outputPaths: ["src/game.js"],
      status: "failed",
      failCount: 6,
      workerIndex: 0,
      assignTo: "broken-worker",
      retryAfterMs: 9999999999999,
    },
  ],
  architectNotes: "Resume from failed task.",
};
storeApi.upsertBuildCheckpoint(blockedCheckpoint);
clientApi.continueDiscussion(discussion.id);
const resumedCheckpoint = storeApi.getBuildCheckpoint(discussion.id);
const resumedTask = resumedCheckpoint?.tasks[0];

check(
  "resume normalizes failed checkpoint tasks before the engine starts",
  resumedTask?.status === "fixing" &&
    resumedTask.failCount === undefined &&
    resumedTask.workerIndex === undefined &&
    resumedTask.assignTo === undefined &&
    resumedTask.retryAfterMs === undefined,
  resumedTask
);

storeApi.updateDiscussion(discussion.id, {
  status: "stopped",
  buildStopReason: "user",
  buildStoppedAt: now,
  updatedAt: now,
});
storeApi.upsertBuildCheckpoint({
  ...blockedCheckpoint,
  status: "running",
  stopReason: null,
  wave: 9,
  tasks: [
    {
      id: "T2",
      title: "Interrupted implementation",
      instructions: "Continue after stop.",
      contextFiles: ["src/game.js"],
      outputPaths: ["src/game.js"],
      status: "in_progress",
    },
  ],
});
clientApi.continueDiscussion(discussion.id);
const normalizedStoppedCheckpoint = storeApi.getBuildCheckpoint(discussion.id);

check(
  "resume normalizes stale running checkpoint when discussion was stopped",
  normalizedStoppedCheckpoint?.status === "stopped" &&
    normalizedStoppedCheckpoint.stopReason === "user" &&
    normalizedStoppedCheckpoint.tasks[0]?.status === "planned",
  normalizedStoppedCheckpoint
);

const nativeRunBeforeRestart = storeApi.getDiscussionById(discussion.id)?.nativeBuildRunId;
storeApi.updateDiscussion(discussion.id, {
  status: "stopped",
  updatedAt: now,
});
const restartedDiscussion = clientApi.restartDiscussion(discussion.id);
check(
  "restart returns the authoritative replacement native run identity",
  Boolean(
    restartedDiscussion?.nativeBuildRunId &&
    restartedDiscussion.nativeBuildRunId !== nativeRunBeforeRestart
  ),
  restartedDiscussion?.nativeBuildRunId
);

if (failed === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failed} check(s) failed`);
  process.exitCode = 1;
}
