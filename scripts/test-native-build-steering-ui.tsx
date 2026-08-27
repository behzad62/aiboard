import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import {
  architectQuestionAnswerIdempotencyKey,
  RunnerQuestionAnswerError,
  RunnerV2SteeringPanel,
  runnerSteeringLedgerView,
  submitRunnerArchitectQuestionAnswer,
} from "../components/RunnerV2ObservabilityPanel";
import {
  classifyBuildNoteDelivery,
  nativeBuildAttachmentNotice,
  resolveBuildGuidanceIdentity,
} from "../lib/client/build-notes";
import type { NativeBuildProjection } from "../lib/client/runner-v2";
import type { Discussion } from "../lib/db/schema";

const require = createRequire(import.meta.url);
const store =
  require("../lib/client/store") as typeof import("../lib/client/store");
const api = require("../lib/client/api") as typeof import("../lib/client/api");

const now = "2026-08-27T00:00:00.000Z";
const discussion: Discussion = {
  id: "discussion-native-steering",
  topic: "Build a durable application.",
  mode: "build",
  effort: "medium",
  status: "running",
  modelIds: JSON.stringify(["worker"]),
  judgeModelId: "architect",
  attachmentIds: JSON.stringify([]),
  currentRound: 0,
  maxRounds: 4,
  convergenceScore: null,
  buildStopReason: null,
  buildStoppedAt: null,
  nativeBuildRunId: "run-native-steering",
  nativeBuildRequestedAt: now,
  runnerUrl: "http://127.0.0.1:8787",
  runnerToken: "runner-secret",
  createdAt: now,
  updatedAt: now,
};

const projection: NativeBuildProjection = {
  runId: "run-native-steering",
  status: "running",
  planRevision: 1,
  tasks: {},
  guidance: {},
  userGuidanceVersion: 2,
  userGuidance: {
    "guidance-1": {
      guidanceId: "guidance-1",
      text: "Keep the public API stable.",
      version: 1,
      status: "submitted",
    },
    "guidance-2": {
      guidanceId: "guidance-2",
      text: "Retain the existing database.",
      version: 2,
      status: "acknowledged",
      resolution: {
        type: "no_plan_change",
        rationale: "The current plan already preserves it.",
        evidenceIds: ["plan:1"],
      },
    },
  },
  architectQuestionVersion: 2,
  blockingArchitectQuestionId: "question-open",
  architectQuestions: {
    "question-answered": {
      questionId: "question-answered",
      question: "Old question?",
      version: 1,
      status: "answered",
      answer: "Old answer.",
    },
    "question-open": {
      questionId: "question-open",
      question: "Which contract is authoritative?",
      version: 2,
      decisionKind: "authority_decision",
      status: "open",
    },
  },
  reviews: {},
  runtime: { providerHealth: {}, workerAssignments: {}, architect: {} },
  lastSequence: 8,
};

assert.equal(classifyBuildNoteDelivery(discussion, null), "native_unknown");
assert.equal(
  classifyBuildNoteDelivery(discussion, projection),
  "native_active",
);
assert.equal(
  classifyBuildNoteDelivery(discussion, { ...projection, status: "paused" }),
  "native_active",
);
assert.equal(
  classifyBuildNoteDelivery(discussion, { ...projection, status: "completed" }),
  "follow_up",
);
assert.equal(
  classifyBuildNoteDelivery({ ...discussion, nativeBuildRunId: null }, null),
  "memory_queue",
);
assert.match(
  nativeBuildAttachmentNotice("native_active") ?? "",
  /Only text guidance is sent/i,
);
assert.match(
  nativeBuildAttachmentNotice("native_unknown") ?? "",
  /files require a new follow-up Build/i,
);
assert.equal(nativeBuildAttachmentNotice("follow_up"), null);
let generatedIdentity = 0;
const firstIdentity = resolveBuildGuidanceIdentity(
  null,
  " Retry this guidance. ",
  () => {
    generatedIdentity += 1;
    return `identity-${generatedIdentity}`;
  },
);
const retriedIdentity = resolveBuildGuidanceIdentity(
  firstIdentity,
  "Retry this guidance.",
  () => {
    generatedIdentity += 1;
    return `identity-${generatedIdentity}`;
  },
);
const editedIdentity = resolveBuildGuidanceIdentity(
  retriedIdentity,
  "Changed guidance.",
  () => {
    generatedIdentity += 1;
    return `identity-${generatedIdentity}`;
  },
);
assert.equal(retriedIdentity, firstIdentity);
assert.equal(retriedIdentity.guidanceId, "guidance-identity-1");
assert.equal(retriedIdentity.idempotencyKey, "guidance-identity-1");
assert.equal(editedIdentity.guidanceId, "guidance-identity-2");

const ledger = runnerSteeringLedgerView(projection);
assert.deepEqual(
  ledger.guidance.map((item) => ({
    id: item.guidanceId,
    state: item.state,
    receipt: item.receipt.map((step) => step.status),
  })),
  [
    {
      id: "guidance-1",
      state: "submitted",
      receipt: ["complete", "current", "pending"],
    },
    {
      id: "guidance-2",
      state: "acknowledged",
      receipt: ["complete", "complete", "complete"],
    },
  ],
);
assert.equal(
  ledger.guidance[1]?.acknowledgementRationale,
  "The current plan already preserves it.",
);
assert.equal(ledger.activeQuestion?.questionId, "question-open");
assert.equal(ledger.activeQuestion?.decisionLabel, "Authority decision");
assert.equal(ledger.activeQuestion?.version, 2);
assert.equal(
  architectQuestionAnswerIdempotencyKey("question-open", 2),
  "architect-question:question-open:version:2:answer",
);
assert.equal(
  runnerSteeringLedgerView({
    ...projection,
    blockingArchitectQuestionId: undefined,
  }).activeQuestion,
  undefined,
);
assert.equal(
  runnerSteeringLedgerView({
    ...projection,
    architectQuestions: {
      ...projection.architectQuestions,
      "question-open": {
        ...projection.architectQuestions!["question-open"]!,
        resumeStatus: "superseded",
      },
    },
  }).activeQuestion,
  undefined,
);
const steeringMarkup = renderToStaticMarkup(
  <RunnerV2SteeringPanel
    projection={projection}
    onAnswerQuestion={async () => undefined}
  />,
);
assert.match(steeringMarkup, /Sent to Runner/);
assert.match(steeringMarkup, /Waiting for Architect/);
assert.match(steeringMarkup, /Acknowledged/);
assert.match(steeringMarkup, /The current plan already preserves it/);
assert.match(steeringMarkup, /Which contract is authoritative/);
assert.match(steeringMarkup, /Authority decision/);
assert.doesNotMatch(steeringMarkup, /Old question/);
assert.match(steeringMarkup, /Answer decision/);

const discussionSource = readFileSync(
  "app/discussion/discussion-client.tsx",
  "utf8",
);
assert.match(discussionSource, /submitNativeBuildNote\(/);
assert.match(discussionSource, /answerNativeArchitectQuestion\(/);
assert.match(
  discussionSource,
  /\{ expectedVersion: version, answer, idempotencyKey \}/,
);
assert.match(discussionSource, /nativeBuildAttachmentNotice/);
assert.match(
  discussionSource,
  /if \(noteFiles\.length > 0\)[\s\S]*Only text guidance is sent/,
);
assert.match(
  discussionSource,
  /nativeAttachmentControllerRef\.current\?\.wake\(\)/,
);

async function main(): Promise<void> {
  const answerCalls: unknown[][] = [];
  const accepted = await submitRunnerArchitectQuestionAnswer(
    ledger.activeQuestion!,
    "  Follow the published contract.  ",
    async (...args) => {
      answerCalls.push(args);
    },
  );
  assert.deepEqual(accepted, { ok: true });
  assert.deepEqual(answerCalls, [[
    "question-open",
    2,
    "Follow the published contract.",
    "architect-question:question-open:version:2:answer",
  ]]);
  const rejected = await submitRunnerArchitectQuestionAnswer(
    ledger.activeQuestion!,
    "Follow the published contract.",
    async () => {
      throw new Error("Question question-open version is stale.");
    },
  );
  assert.deepEqual(rejected, {
    ok: false,
    error: "Question question-open version is stale.",
  });
  const rejectedMarkup = renderToStaticMarkup(
    <RunnerQuestionAnswerError message={rejected.ok ? null : rejected.error} />,
  );
  assert.match(rejectedMarkup, /role="alert"/);
  assert.match(rejectedMarkup, /Question question-open version is stale/);

  store.__resetClientStoreForTests();
  store.insertDiscussion(discussion);
  const requestBodies: string[] = [];
  const requestUrls: string[] = [];
  const successFetch: typeof fetch = async (input, init) => {
    requestUrls.push(String(input));
    requestBodies.push(String(init?.body));
    return new Response(JSON.stringify(projection), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const deliveryIdentity = {
    guidanceId: "guidance-ui-stable",
    idempotencyKey: "guidance-ui-stable",
  };
  await api.submitNativeBuildNote(
    discussion.id,
    "  Preserve the retry contract.  ",
    deliveryIdentity,
    successFetch,
  );
  await api.submitNativeBuildNote(
    discussion.id,
    "Preserve the retry contract.",
    deliveryIdentity,
    successFetch,
  );
  assert.equal(requestBodies.length, 2);
  assert.ok(
    requestUrls.every((url) =>
      url.endsWith("/v2/runs/run-native-steering/build/user-guidance"),
    ),
  );
  assert.equal(requestBodies[0], requestBodies[1]);
  assert.deepEqual(JSON.parse(requestBodies[0]!), {
    guidanceId: "guidance-ui-stable",
    text: "Preserve the retry contract.",
    idempotencyKey: "guidance-ui-stable",
  });
  assert.equal(store.getMessagesForDiscussion(discussion.id).length, 1);
  assert.deepEqual(
    store
      .getMessagesForDiscussion(discussion.id)
      .map((message) => message.content),
    ["Preserve the retry contract."],
  );
  assert.deepEqual(
    require("../lib/client/build-notes").drainBuildNotes(discussion.id),
    [],
  );

  store.__resetClientStoreForTests();
  store.insertDiscussion(discussion);
  await assert.rejects(
    api.submitNativeBuildNote(
      discussion.id,
      "This must not appear as delivered.",
      { guidanceId: "guidance-failed", idempotencyKey: "guidance-failed" },
      async () =>
        new Response(
          JSON.stringify({
            code: "runner_offline",
            message: "Runner offline.",
          }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          },
        ),
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "runner_offline",
  );
  assert.equal(store.getMessagesForDiscussion(discussion.id).length, 0);
  assert.deepEqual(
    require("../lib/client/build-notes").drainBuildNotes(discussion.id),
    [],
  );

  store.__resetClientStoreForTests();
  store.insertDiscussion({
    ...discussion,
    nativeBuildRunId: null,
    runnerUrl: null,
    runnerToken: null,
  });
  api.addBuildNote(discussion.id, "Keep legacy queue compatibility.");
  assert.deepEqual(
    require("../lib/client/build-notes").drainBuildNotes(discussion.id),
    ["Keep legacy queue compatibility."],
  );

  console.log("PASS native Build steering UI contracts");
}

void main();
