/** Build worker guidance checks (run: npx tsx scripts/test-build-guidance.mts) */
import { createRequire } from "node:module";
import {
  type ClientStore,
  type getDiscussionById,
  type insertDiscussion,
  type __resetClientStoreForTests,
} from "../lib/client/store";
import type { Discussion } from "../lib/db/schema";
import type { OrchestratorEvent } from "../lib/orchestrator/engine";
import type { ChatMessage, SelectedModel } from "../lib/providers/base";

const require = createRequire(import.meta.url);
const storeApi = require("../lib/client/store") as {
  __resetClientStoreForTests: typeof __resetClientStoreForTests;
  insertDiscussion: typeof insertDiscussion;
  getDiscussionById: typeof getDiscussionById;
  exportStore: () => ClientStore;
};

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
}

type ModelOverrideCall = {
  label: string;
  messages: ChatMessage[];
  maxTokens: number;
};

function buildSpecResponse(objective: string): string {
  return [
    "Spec.",
    "```json",
    JSON.stringify({
      action: "spec",
      spec: {
        id: "S1",
        objective,
        requirements: [objective],
        nonGoals: [],
        acceptanceCriteria: ["The requested file output is produced."],
        qualityCriteria: ["The output remains scoped to the assigned task."],
        verification: [],
        constraints: ["Use test fixtures only."],
        implementationDecisions: [],
        risks: [],
      },
      notes: "Test fixture spec.",
      verifyCommand: "",
    }),
    "```",
  ].join("\n");
}

function isPlanningLabel(label: string): boolean {
  return (
    label === "Architect is planning the project" ||
    label === "Architect is planning the implementation from the spec"
  );
}

function installIndexedDbStub(): void {
  const values = new Map<string, unknown>();
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const tx = {
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        error: null,
        objectStore: () => ({
          get: (key: string) => {
            const req = {
              result: values.get(key),
              onsuccess: null as (() => void) | null,
              onerror: null as (() => void) | null,
              error: null,
            };
            queueMicrotask(() => req.onsuccess?.());
            return req;
          },
          put: (value: unknown, key: string) => {
            values.set(key, value);
            queueMicrotask(() => tx.oncomplete?.());
          },
        }),
      };
      return tx;
    },
    close: () => {},
  };
  const indexedDb = {
    open: () => {
      const req = {
        result: db,
        error: null,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  };
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB =
    indexedDb as unknown as IDBFactory;
}

const now = "2026-07-06T00:00:00.000Z";
const discussion: Discussion = {
  id: "disc-build-guidance",
  topic: "Build a small client store note.",
  mode: "build",
  effort: "medium",
  status: "running",
  modelIds: JSON.stringify(["test:worker"]),
  judgeModelId: "test:architect",
  attachmentIds: JSON.stringify([]),
  currentRound: 0,
  maxRounds: 1,
  convergenceScore: null,
  createdAt: now,
  updatedAt: now,
};
const architect: SelectedModel = {
  modelId: "test:architect",
  providerId: "test",
  displayName: "Test Architect",
  contextProfile: {
    providerId: "test",
    modelId: "architect",
    fullModelId: "test:architect",
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_768,
    buildOutputReserveTokens: 32_768,
    effectiveBuildInputCeilingTokens: 167_232,
    longContextQuality: "good",
    promptCaching: false,
    recommendedBuildRoles: ["architect", "reviewer", "summary"],
    source: "override",
  },
};
const worker: SelectedModel = {
  modelId: "test:worker",
  providerId: "test",
  displayName: "Test Worker",
  contextProfile: {
    providerId: "test",
    modelId: "worker",
    fullModelId: "test:worker",
    contextWindowTokens: 200_000,
    maxOutputTokens: 24_576,
    buildOutputReserveTokens: 24_576,
    effectiveBuildInputCeilingTokens: 175_424,
    longContextQuality: "good",
    promptCaching: false,
    recommendedBuildRoles: ["worker"],
    source: "override",
  },
};

installIndexedDbStub();
storeApi.__resetClientStoreForTests();
storeApi.insertDiscussion(discussion);

const { runBuildDiscussion } = await import("../lib/client/build-engine");

const calls: ModelOverrideCall[] = [];
const hooks: NonNullable<Parameters<typeof runBuildDiscussion>[3]> = {
  modelCallOverride: async (input) => {
    calls.push({
      label: input.label,
      messages: input.messages.map((message) => ({ ...message })),
      maxTokens: input.maxTokens,
    });
    if (input.label === "Architect is writing the build spec") {
      return buildSpecResponse(discussion.topic);
    }
    if (isPlanningLabel(input.label)) {
      return [
        "Plan.",
        "```json",
        JSON.stringify({
          action: "plan",
          tasks: [
            {
              id: "T1",
              title: "Create client store note",
              instructions:
                "Create src/store-note.txt describing the chosen store pattern.",
              contextFiles: [],
              outputPaths: ["src/store-note.txt"],
              expectedOutputs: "A note explaining the selected client store pattern.",
              dependsOn: [],
              difficulty: 1,
            },
          ],
          notes: "Use existing client-side storage conventions.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Test Worker working on T1: Create client store note") {
      return [
        "```json",
        JSON.stringify({
          action: "guidance_request",
          mode: "blocking",
          question: "Should I use the existing client store or create a separate cache?",
          reason: "The task mentions store pattern.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Architect answering guidance G-T1-1 for T1") {
      return [
        "```json",
        JSON.stringify({
          action: "guidance_answer",
          guidanceId: "G-T1-1",
          taskId: "T1",
          answer: "Use the existing client store. Do not create a separate cache.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Test Worker continuing T1: Create client store note") {
      return [
        "Implemented.",
        "```txt path=src/store-note.txt",
        "Use the existing client store. Do not create a separate cache.",
        "```",
      ].join("\n");
    }
    if (
      input.label === "Architect is reviewing wave 1" ||
      input.label === "Test Architect is reviewing wave 1"
    ) {
      return [
        "Review.",
        "```json",
        JSON.stringify({
          action: "review",
          results: [{ taskId: "T1", verdict: "approve", fixInstructions: "" }],
          newTasks: [],
          done: true,
          notes: "Approved.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Architect is writing the build summary") {
      return "Build completed with Architect guidance.";
    }
    throw new Error(`Unexpected model call label: ${input.label}`);
  },
};

const events: OrchestratorEvent[] = [];
await runBuildDiscussion(discussion, [architect, worker], (event) => {
  events.push(event);
}, hooks);

const guidanceCall = calls.find(
  (call) => call.label === "Architect answering guidance G-T1-1 for T1"
);
const continuationCall = calls.find(
  (call) => call.label === "Test Worker continuing T1: Create client store note"
);
const continuationPrompt =
  continuationCall?.messages.map((message) => message.content).join("\n\n") ?? "";
const completed = storeApi.getDiscussionById(discussion.id)?.status;
const workerCalls = calls.filter(
  (call) =>
    call.label === "Test Worker working on T1: Create client store note" ||
    call.label === "Test Worker continuing T1: Create client store note"
);

check("Architect guidance call happened", !!guidanceCall, calls.map((call) => call.label));
check(
  "worker continuation prompt contains question and answer",
  continuationPrompt.includes("ARCHITECT GUIDANCE FOR THIS TASK") &&
    continuationPrompt.includes("Guidance G-T1-1") &&
    continuationPrompt.includes("Should I use the existing client store or create a separate cache?") &&
    continuationPrompt.includes("Use the existing client store. Do not create a separate cache."),
  continuationPrompt
);
check(
  "discussion completed after guided worker output",
  completed === "completed" && events.some((event) => event.type === "final_answer"),
  { completed, labels: calls.map((call) => call.label) }
);
check(
  "worker was called once for the request and once for the continuation",
  workerCalls.length === 2,
  workerCalls.map((call) => call.label)
);

const mixedDiscussion: Discussion = {
  ...discussion,
  id: "disc-build-guidance-mixed-split",
  topic: "Build two notes without splitting after mixed guidance.",
  status: "running",
  currentRound: 0,
  createdAt: now,
  updatedAt: now,
};
storeApi.insertDiscussion(mixedDiscussion);

const mixedCalls: ModelOverrideCall[] = [];
const mixedEvents: OrchestratorEvent[] = [];
const mixedHooks: NonNullable<Parameters<typeof runBuildDiscussion>[3]> = {
  modelCallOverride: async (input) => {
    mixedCalls.push({
      label: input.label,
      messages: input.messages.map((message) => ({ ...message })),
      maxTokens: input.maxTokens,
    });
    if (input.label === "Architect is writing the build spec") {
      return buildSpecResponse(mixedDiscussion.topic);
    }
    if (isPlanningLabel(input.label)) {
      return [
        "Plan.",
        "```json",
        JSON.stringify({
          action: "plan",
          tasks: [
            {
              id: "T1",
              title: "Create two store notes",
              instructions:
                "Create src/note-a.txt and src/note-b.txt using the existing store pattern.",
              contextFiles: [],
              outputPaths: ["src/note-a.txt", "src/note-b.txt"],
              expectedOutputs: "Two notes explaining the existing store pattern.",
              dependsOn: [],
              difficulty: 2,
            },
          ],
          notes: "Do not split after a mixed guidance request.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Test Worker working on T1: Create two store notes") {
      return [
        "```json",
        JSON.stringify({
          action: "guidance_request",
          mode: "blocking",
          question: "Should I split this before choosing the store pattern?",
          reason: "The task owns two files.",
        }),
        "```",
        "```json",
        JSON.stringify({
          action: "split_task",
          reason: "Split the two files into separate notes.",
          subtasks: [
            {
              title: "Create first note",
              instructions: "Create src/note-a.txt.",
              outputPaths: ["src/note-a.txt"],
              difficulty: 1,
            },
            {
              title: "Create second note",
              instructions: "Create src/note-b.txt.",
              outputPaths: ["src/note-b.txt"],
              difficulty: 1,
            },
          ],
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Test Worker continuing T1: Create two store notes") {
      const prompt = input.messages.map((message) => message.content).join("\n\n");
      if (!prompt.includes("GUIDANCE REQUEST REJECTED")) {
        throw new Error("Mixed guidance/split response was not rejected before continuation.");
      }
      return [
        "Implemented after rejection.",
        "```txt path=src/note-a.txt",
        "Use the existing client store.",
        "```",
        "```txt path=src/note-b.txt",
        "Do not create a separate cache.",
        "```",
      ].join("\n");
    }
    if (
      input.label === "Architect is reviewing wave 1" ||
      input.label === "Test Architect is reviewing wave 1"
    ) {
      return [
        "Review.",
        "```json",
        JSON.stringify({
          action: "review",
          results: [{ taskId: "T1", verdict: "approve", fixInstructions: "" }],
          newTasks: [],
          done: true,
          notes: "Approved.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Architect is writing the build summary") {
      return "Build completed after rejecting mixed guidance.";
    }
    throw new Error(`Unexpected mixed model call label: ${input.label}`);
  },
};

await runBuildDiscussion(
  mixedDiscussion,
  [architect, worker],
  (event) => {
    mixedEvents.push(event);
  },
  mixedHooks
);

const mixedGuidanceCalls = mixedCalls.filter((call) =>
  call.label.startsWith("Architect answering guidance")
);
const mixedSplitEvents = mixedEvents.filter(
  (event) =>
    event.type === "task_status" &&
    (event.taskId === "T1.1" || event.taskId === "T1.2")
);
const mixedContinuationCall = mixedCalls.find(
  (call) => call.label === "Test Worker continuing T1: Create two store notes"
);
const mixedContinuationPrompt =
  mixedContinuationCall?.messages.map((message) => message.content).join("\n\n") ??
  "";

check(
  "mixed guidance_request and split_task is rejected without Architect guidance",
  mixedGuidanceCalls.length === 0 &&
    mixedContinuationPrompt.includes("GUIDANCE REQUEST REJECTED"),
  {
    labels: mixedCalls.map((call) => call.label),
    continuationPrompt: mixedContinuationPrompt,
  }
);
check(
  "mixed guidance_request and split_task does not apply split children",
  mixedSplitEvents.length === 0,
  mixedSplitEvents
);

const asyncDiscussion: Discussion = {
  ...discussion,
  id: "disc-build-guidance-async-fix",
  topic: "Build an async guidance note and fix it after review.",
  status: "running",
  currentRound: 0,
  createdAt: now,
  updatedAt: now,
};
storeApi.insertDiscussion(asyncDiscussion);

const asyncCalls: ModelOverrideCall[] = [];
const asyncEvents: OrchestratorEvent[] = [];
const asyncWorkerLabel = "Test Worker working on T2: Create async note";
let asyncWorkerInvocations = 0;
const asyncHooks: NonNullable<Parameters<typeof runBuildDiscussion>[3]> = {
  modelCallOverride: async (input) => {
    asyncCalls.push({
      label: input.label,
      messages: input.messages.map((message) => ({ ...message })),
      maxTokens: input.maxTokens,
    });
    if (input.label === "Architect is writing the build spec") {
      return buildSpecResponse(asyncDiscussion.topic);
    }
    if (isPlanningLabel(input.label)) {
      return [
        "Plan.",
        "```json",
        JSON.stringify({
          action: "plan",
          tasks: [
            {
              id: "T2",
              title: "Create async note",
              instructions:
                "Create src/async-note.txt with the guidance-sensitive note.",
              contextFiles: [],
              outputPaths: ["src/async-note.txt"],
              expectedOutputs: "A note that follows the Architect's later guidance.",
              dependsOn: [],
              difficulty: 1,
            },
          ],
          notes: "Use async guidance only after the task needs a later fix.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === asyncWorkerLabel) {
      asyncWorkerInvocations += 1;
      if (asyncWorkerInvocations === 1) {
        return [
          "```json",
          JSON.stringify({
            action: "guidance_request",
            mode: "async",
            question: "Should I preserve the existing file name?",
            reason:
              "I can continue with the likely path but want confirmation if this returns.",
          }),
          "```",
        ].join("\n");
      }
      return [
        "```txt path=src/async-note.txt",
        "Preserve src/async-note.txt and update only its content.",
        "```",
      ].join("\n");
    }
    if (input.label === "Test Worker continuing T2: Create async note") {
      return [
        "Implemented with likely path.",
        "```txt path=src/async-note.txt",
        "draft async guidance path",
        "```",
      ].join("\n");
    }
    if (input.label === "Architect answering guidance G-T2-1 for T2") {
      return [
        "```json",
        JSON.stringify({
          action: "guidance_answer",
          guidanceId: "G-T2-1",
          taskId: "T2",
          answer: "Preserve src/async-note.txt and update only its content.",
        }),
        "```",
      ].join("\n");
    }
    if (
      input.label === "Architect is reviewing wave 1" ||
      input.label === "Test Architect is reviewing wave 1"
    ) {
      return [
        "Review.",
        "```json",
        JSON.stringify({
          action: "review",
          results: [
            {
              taskId: "T2",
              verdict: "fix",
              specVerdict: "fix",
              qualityVerdict: "approve",
              specIssues: "Needs confirmed filename guidance.",
              fixInstructions:
                "Apply the Architect guidance answer and update the file content.",
            },
          ],
          newTasks: [],
          done: false,
          notes: "Fix T2.",
        }),
        "```",
      ].join("\n");
    }
    if (
      input.label === "Architect is reviewing wave 2" ||
      input.label === "Test Architect is reviewing wave 2"
    ) {
      return [
        "Review.",
        "```json",
        JSON.stringify({
          action: "review",
          results: [
            {
              taskId: "T2",
              verdict: "approve",
              specVerdict: "approve",
              qualityVerdict: "approve",
              fixInstructions: "",
            },
          ],
          newTasks: [],
          done: true,
          notes: "Approved after async guidance.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Architect is writing the build summary") {
      return "Build completed after async guidance was applied.";
    }
    throw new Error(`Unexpected async model call label: ${input.label}`);
  },
};

await runBuildDiscussion(
  asyncDiscussion,
  [architect, worker],
  (event) => {
    asyncEvents.push(event);
  },
  asyncHooks
);

const asyncLabels = asyncCalls.map((call) => call.label);
const asyncContinuationIndex = asyncLabels.indexOf(
  "Test Worker continuing T2: Create async note"
);
const asyncReviewFixIndex = asyncLabels.findIndex(
  (label) =>
    label === "Architect is reviewing wave 1" ||
    label === "Test Architect is reviewing wave 1"
);
const asyncGuidanceAnswerIndex = asyncLabels.indexOf(
  "Architect answering guidance G-T2-1 for T2"
);
const asyncFixingWorkerIndex = asyncLabels.findIndex(
  (label, index) => label === asyncWorkerLabel && index > asyncGuidanceAnswerIndex
);
const asyncFixingPrompt =
  asyncFixingWorkerIndex >= 0
    ? asyncCalls[asyncFixingWorkerIndex].messages
        .map((message) => message.content)
        .join("\n\n")
    : "";
const asyncFile = storeApi
  .exportStore()
  .buildFiles.find(
    (file) =>
      file.discussionId === asyncDiscussion.id &&
      file.path === "src/async-note.txt"
  );
const asyncCompleted = storeApi.getDiscussionById(asyncDiscussion.id)?.status;

check(
  "async guidance is answered only after same-task continuation and review fix",
  asyncContinuationIndex >= 0 &&
    asyncReviewFixIndex > asyncContinuationIndex &&
    asyncGuidanceAnswerIndex > asyncReviewFixIndex,
  asyncLabels
);
check(
  "async guidance answer is injected into the later same-task fix prompt",
  asyncFixingPrompt.includes("ARCHITECT GUIDANCE FOR THIS TASK") &&
    asyncFixingPrompt.includes("Guidance G-T2-1") &&
    asyncFixingPrompt.includes("Should I preserve the existing file name?") &&
    asyncFixingPrompt.includes(
      "Preserve src/async-note.txt and update only its content."
    ),
  asyncFixingPrompt
);
check(
  "async guidance fix writes updated content and completes",
  asyncFile?.content ===
    "Preserve src/async-note.txt and update only its content." &&
    asyncCompleted === "completed" &&
    asyncEvents.some((event) => event.type === "final_answer"),
  { asyncFile, asyncCompleted, labels: asyncLabels }
);

const promotedDiscussion: Discussion = {
  ...discussion,
  id: "disc-build-guidance-promoted-memory",
  topic: "Build dependent notes that reuse a shared store convention.",
  status: "running",
  currentRound: 0,
  createdAt: now,
  updatedAt: now,
};
storeApi.insertDiscussion(promotedDiscussion);

const promotedCalls: ModelOverrideCall[] = [];
const promotedConvention =
  "Across this build, reuse the existing client store for store/cache decisions.";
const promotedHooks: NonNullable<Parameters<typeof runBuildDiscussion>[3]> = {
  modelCallOverride: async (input) => {
    promotedCalls.push({
      label: input.label,
      messages: input.messages.map((message) => ({ ...message })),
      maxTokens: input.maxTokens,
    });
    if (input.label === "Architect is writing the build spec") {
      return buildSpecResponse(promotedDiscussion.topic);
    }
    if (isPlanningLabel(input.label)) {
      return [
        "Plan.",
        "```json",
        JSON.stringify({
          action: "plan",
          tasks: [
            {
              id: "T1",
              title: "Create source convention note",
              instructions:
                "Create src/source-convention.txt after asking for store guidance.",
              contextFiles: [],
              outputPaths: ["src/source-convention.txt"],
              expectedOutputs: "A note with the selected store convention.",
              dependsOn: [],
              difficulty: 1,
            },
            {
              id: "T2",
              title: "Create dependent convention note",
              instructions:
                "Create src/dependent-convention.txt using any shared Architect convention.",
              contextFiles: [],
              outputPaths: ["src/dependent-convention.txt"],
              expectedOutputs: "A dependent note applying the shared convention.",
              dependsOn: ["T1"],
              difficulty: 1,
            },
          ],
          notes: "Use existing client-side storage conventions.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Test Worker working on T1: Create source convention note") {
      return [
        "```json",
        JSON.stringify({
          action: "guidance_request",
          mode: "blocking",
          question: "Should later store tasks use the existing client store?",
          reason: "This affects the rest of the build.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Architect answering guidance G-T1-1 for T1") {
      return [
        "```json",
        JSON.stringify({
          action: "guidance_answer",
          guidanceId: "G-T1-1",
          taskId: "T1",
          answer: "Use the existing client store for this task.",
          memory: promotedConvention,
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Test Worker continuing T1: Create source convention note") {
      return [
        "Implemented.",
        "```txt path=src/source-convention.txt",
        "Use the existing client store for this task.",
        "```",
      ].join("\n");
    }
    if (
      input.label === "Architect is reviewing wave 1" ||
      input.label === "Test Architect is reviewing wave 1"
    ) {
      return [
        "Review.",
        "```json",
        JSON.stringify({
          action: "review",
          results: [{ taskId: "T1", verdict: "approve", fixInstructions: "" }],
          newTasks: [],
          done: false,
          notes: "T1 approved; T2 remains.",
        }),
        "```",
      ].join("\n");
    }
    if (
      input.label === "Test Worker working on T2: Create dependent convention note"
    ) {
      return [
        "Implemented.",
        "```txt path=src/dependent-convention.txt",
        promotedConvention,
        "```",
      ].join("\n");
    }
    if (
      input.label === "Architect is reviewing wave 2" ||
      input.label === "Test Architect is reviewing wave 2"
    ) {
      return [
        "Review.",
        "```json",
        JSON.stringify({
          action: "review",
          results: [{ taskId: "T2", verdict: "approve", fixInstructions: "" }],
          newTasks: [],
          done: true,
          notes: "Approved after shared convention.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Architect is writing the build summary") {
      return "Build completed with promoted guidance memory.";
    }
    throw new Error(`Unexpected promoted model call label: ${input.label}`);
  },
};

await runBuildDiscussion(
  promotedDiscussion,
  [architect, worker],
  () => {},
  promotedHooks
);

const promotedT2Call = promotedCalls.find(
  (call) => call.label === "Test Worker working on T2: Create dependent convention note"
);
const promotedT2Prompt =
  promotedT2Call?.messages.map((message) => message.content).join("\n\n") ?? "";
const promotedMemory = storeApi
  .exportStore()
  .buildMemories.find(
    (memory) =>
      memory.discussionId === promotedDiscussion.id &&
      memory.kind === "decision" &&
      memory.summary.includes(promotedConvention)
  );
check(
  "promoted guidance memory is injected into later worker prompt",
  promotedT2Prompt.includes(promotedConvention),
  promotedT2Prompt
);
check(
  "promoted guidance memory is persisted as a build decision",
  !!promotedMemory,
  storeApi.exportStore().buildMemories.filter(
    (memory) => memory.discussionId === promotedDiscussion.id
  )
);

const badAsyncDiscussion: Discussion = {
  ...discussion,
  id: "disc-build-guidance-async-bad-answer",
  topic: "Build an async guidance note despite one malformed Architect answer.",
  status: "running",
  currentRound: 0,
  createdAt: now,
  updatedAt: now,
};
storeApi.insertDiscussion(badAsyncDiscussion);

const badAsyncCalls: ModelOverrideCall[] = [];
let badAsyncGuidanceAttempts = 0;
let badAsyncWorkerAttempts = 0;
let badAsyncError: unknown = null;
const badAsyncWorkerLabel =
  "Test Worker working on T3: Create resilient async note";
const badAsyncHooks: NonNullable<Parameters<typeof runBuildDiscussion>[3]> = {
  modelCallOverride: async (input) => {
    badAsyncCalls.push({
      label: input.label,
      messages: input.messages.map((message) => ({ ...message })),
      maxTokens: input.maxTokens,
    });
    if (input.label === "Architect is writing the build spec") {
      return buildSpecResponse(badAsyncDiscussion.topic);
    }
    if (isPlanningLabel(input.label)) {
      return [
        "Plan.",
        "```json",
        JSON.stringify({
          action: "plan",
          tasks: [
            {
              id: "T3",
              title: "Create resilient async note",
              instructions:
                "Create src/resilient-async-note.txt after async guidance if it arrives.",
              contextFiles: [],
              outputPaths: ["src/resilient-async-note.txt"],
              expectedOutputs:
                "A note that completes after a retried guidance answer.",
              dependsOn: [],
              difficulty: 1,
            },
          ],
          notes: "Retry malformed async guidance answers without aborting the build.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === badAsyncWorkerLabel) {
      badAsyncWorkerAttempts += 1;
      if (badAsyncWorkerAttempts === 1) {
        return [
          "```json",
          JSON.stringify({
            action: "guidance_request",
            mode: "async",
            question: "Should I use the resilient async note path?",
            reason: "I can draft now but want confirmation for the fix pass.",
          }),
          "```",
        ].join("\n");
      }
      return [
        "Implemented after retried guidance.",
        "```txt path=src/resilient-async-note.txt",
        "Use src/resilient-async-note.txt after the retried guidance answer.",
        "```",
      ].join("\n");
    }
    if (input.label === "Test Worker continuing T3: Create resilient async note") {
      return [
        "Implemented draft.",
        "```txt path=src/resilient-async-note.txt",
        "draft before async answer",
        "```",
      ].join("\n");
    }
    if (input.label === "Architect answering guidance G-T3-1 for T3") {
      badAsyncGuidanceAttempts += 1;
      if (badAsyncGuidanceAttempts === 1) {
        return "I cannot answer this as JSON yet.";
      }
      return [
        "```json",
        JSON.stringify({
          action: "guidance_answer",
          guidanceId: "G-T3-1",
          taskId: "T3",
          answer:
            "Use src/resilient-async-note.txt after the retried guidance answer.",
        }),
        "```",
      ].join("\n");
    }
    if (
      input.label === "Architect is reviewing wave 1" ||
      input.label === "Test Architect is reviewing wave 1"
    ) {
      return [
        "Review.",
        "```json",
        JSON.stringify({
          action: "review",
          results: [
            {
              taskId: "T3",
              verdict: "fix",
              specVerdict: "fix",
              qualityVerdict: "approve",
              specIssues: "Needs async guidance answer.",
              fixInstructions: "Apply the async guidance answer.",
            },
          ],
          newTasks: [],
          done: false,
          notes: "Fix T3.",
        }),
        "```",
      ].join("\n");
    }
    if (
      input.label === "Architect is reviewing wave 2" ||
      input.label === "Test Architect is reviewing wave 2"
    ) {
      return [
        "Review.",
        "```json",
        JSON.stringify({
          action: "review",
          results: [
            {
              taskId: "T3",
              verdict: "approve",
              specVerdict: "approve",
              qualityVerdict: "approve",
              fixInstructions: "",
            },
          ],
          newTasks: [],
          done: true,
          notes: "Approved after guidance answer retry.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Architect is writing the build summary") {
      return "Build completed after retrying malformed guidance answer.";
    }
    throw new Error(`Unexpected bad async model call label: ${input.label}`);
  },
};

try {
  await runBuildDiscussion(
    badAsyncDiscussion,
    [architect, worker],
    () => {},
    badAsyncHooks
  );
} catch (err) {
  badAsyncError = err;
}

const badAsyncCompleted = storeApi.getDiscussionById(badAsyncDiscussion.id)?.status;
check(
  "malformed async guidance answer requeues task instead of aborting build",
  badAsyncError == null &&
    badAsyncGuidanceAttempts === 2 &&
    badAsyncWorkerAttempts === 2 &&
    badAsyncCompleted === "completed",
  {
    error: badAsyncError instanceof Error ? badAsyncError.message : badAsyncError,
    labels: badAsyncCalls.map((call) => call.label),
    badAsyncGuidanceAttempts,
    badAsyncWorkerAttempts,
    badAsyncCompleted,
  }
);

const budgetGuidanceDiscussion: Discussion = {
  ...discussion,
  id: "disc-build-guidance-budget-blocked",
  topic: "Build a note even when command tools are unavailable.",
  status: "running",
  currentRound: 0,
  createdAt: now,
  updatedAt: now,
};
storeApi.insertDiscussion(budgetGuidanceDiscussion);

const budgetGuidanceCalls: ModelOverrideCall[] = [];
let budgetGuidanceArchitectAnswers = 0;
let budgetGuidanceWorkerContinuations = 0;
let budgetGuidanceError: unknown = null;
const budgetGuidanceHooks: NonNullable<Parameters<typeof runBuildDiscussion>[3]> = {
  modelCallOverride: async (input) => {
    budgetGuidanceCalls.push({
      label: input.label,
      messages: input.messages.map((message) => ({ ...message })),
      maxTokens: input.maxTokens,
    });
    if (input.label === "Architect is writing the build spec") {
      return buildSpecResponse(budgetGuidanceDiscussion.topic);
    }
    if (isPlanningLabel(input.label)) {
      return [
        "Plan.",
        "```json",
        JSON.stringify({
          action: "plan",
          tasks: [
            {
              id: "T4",
              title: "Create no-run recovery note",
              instructions:
                "Create src/no-run-recovery.txt. If command tools are unavailable, ask the Architect how to proceed.",
              contextFiles: [],
              outputPaths: ["src/no-run-recovery.txt"],
              expectedOutputs:
                "A note created after budget-blocked command recovery.",
              dependsOn: [],
              difficulty: 1,
            },
          ],
          notes: "Recover from unavailable command tools through Architect guidance.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Test Worker working on T4: Create no-run recovery note") {
      return [
        "```json",
        JSON.stringify({
          action: "run",
          command: "node --version",
          reason: "check command availability before writing the note",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Architect answering guidance G-T4-1 for T4") {
      budgetGuidanceArchitectAnswers += 1;
      return [
        "```json",
        JSON.stringify({
          action: "guidance_answer",
          guidanceId: "G-T4-1",
          taskId: "T4",
          answer:
            "Proceed without command verification. Create the requested note and explicitly mention that command tools were unavailable.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Test Worker continuing T4: Create no-run recovery note") {
      budgetGuidanceWorkerContinuations += 1;
      return [
        "Implemented after budget-blocked guidance.",
        "```txt path=src/no-run-recovery.txt",
        "Command tools were unavailable, so this note was created from Architect recovery guidance.",
        "```",
      ].join("\n");
    }
    if (
      input.label === "Architect is reviewing wave 1" ||
      input.label === "Test Architect is reviewing wave 1"
    ) {
      return [
        "Review.",
        "```json",
        JSON.stringify({
          action: "review",
          results: [
            {
              taskId: "T4",
              verdict: "approve",
              specVerdict: "approve",
              qualityVerdict: "approve",
              fixInstructions: "",
            },
          ],
          newTasks: [],
          done: true,
          notes: "Approved after budget recovery guidance.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Architect is writing the build summary") {
      return "Build completed after budget-blocked command recovery.";
    }
    throw new Error(`Unexpected budget guidance model call label: ${input.label}`);
  },
};

try {
  await runBuildDiscussion(
    budgetGuidanceDiscussion,
    [architect, worker],
    () => {},
    budgetGuidanceHooks
  );
} catch (err) {
  budgetGuidanceError = err;
}

const budgetGuidanceCompleted = storeApi.getDiscussionById(
  budgetGuidanceDiscussion.id
)?.status;
const budgetGuidanceAnswerPrompt =
  budgetGuidanceCalls
    .find((call) => call.label === "Architect answering guidance G-T4-1 for T4")
    ?.messages.map((message) => message.content)
    .join("\n\n") ?? "";
check(
  "command-tool budget block escalates to blocking Architect guidance before worker retry",
  budgetGuidanceError == null &&
    budgetGuidanceArchitectAnswers === 1 &&
    budgetGuidanceWorkerContinuations === 1 &&
    budgetGuidanceCompleted === "completed" &&
    /node --version/.test(budgetGuidanceAnswerPrompt) &&
    /unavailable|budget|runner/i.test(budgetGuidanceAnswerPrompt),
  {
    error:
      budgetGuidanceError instanceof Error
        ? budgetGuidanceError.message
        : budgetGuidanceError,
    labels: budgetGuidanceCalls.map((call) => call.label),
    budgetGuidanceArchitectAnswers,
    budgetGuidanceWorkerContinuations,
    budgetGuidanceCompleted,
    budgetGuidanceAnswerPrompt,
  }
);

const gapReportDiscussion: Discussion = {
  ...discussion,
  id: "disc-build-guidance-gap-report",
  topic: "Verify a static app and report any verification gaps.",
  status: "running",
  currentRound: 0,
  createdAt: now,
  updatedAt: now,
};
storeApi.insertDiscussion(gapReportDiscussion);

const gapReportCalls: ModelOverrideCall[] = [];
let gapReportReviewCalls = 0;
let gapReportError: unknown = null;
const gapReportHooks: NonNullable<Parameters<typeof runBuildDiscussion>[3]> = {
  modelCallOverride: async (input) => {
    gapReportCalls.push({
      label: input.label,
      messages: input.messages.map((message) => ({ ...message })),
      maxTokens: input.maxTokens,
    });
    if (input.label === "Architect is writing the build spec") {
      return buildSpecResponse(gapReportDiscussion.topic);
    }
    if (isPlanningLabel(input.label)) {
      return [
        "Plan.",
        "```json",
        JSON.stringify({
          action: "plan",
          tasks: [
            {
              id: "T6",
              title: "Verify static app",
              instructions:
                "Run syntax, smoke, and browser acceptance checks. If runner tools are unavailable, return a precise verification-gap report for Architect review.",
              contextFiles: ["src/game.js"],
              outputPaths: [],
              expectedOutputs:
                "A verification report listing completed evidence and remaining checks.",
              dependsOn: [],
              difficulty: 3,
            },
          ],
          notes: "Verification-only task; no files should be written.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Test Worker working on T6: Verify static app") {
      return [
        "```json",
        JSON.stringify({
          action: "run",
          command: "node --check src/game.js",
          reason: "verify game.js syntax",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Architect answering guidance G-T6-1 for T6") {
      return [
        "```json",
        JSON.stringify({
          action: "guidance_answer",
          guidanceId: "G-T6-1",
          taskId: "T6",
          answer:
            "Do not request more tools. Submit a scoped verification-gap report with evidence already obtained and checks still required.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Test Worker continuing T6: Verify static app") {
      return [
        "Final Verification Gap Report for T6",
        "",
        "Verification Status: INCOMPLETE / BLOCKED",
        "",
        "Evidence Already Obtained",
        "- The runner was unavailable, so no fresh syntax result was obtained.",
        "",
        "Commands That Could Not Run (Budget Exhausted)",
        "- node --check src/game.js",
        "",
        "Final Acceptance Still Required",
        "- Syntax checks for JS files",
        "- Runtime smoke test",
        "- Browser acceptance with browser_navigate, browser_snapshot, and browser_console_messages",
        "",
        "Recommendation",
        "Review/planning should create follow-up verification work with fresh runner budget.",
      ].join("\n");
    }
    if (input.label === "Test Worker finalizing T6: Verify static app") {
      throw new Error("Gap report should have stopped the worker tool loop before finalizing.");
    }
    if (
      input.label === "Architect is reviewing wave 1" ||
      input.label === "Test Architect is reviewing wave 1"
    ) {
      gapReportReviewCalls += 1;
      const reviewPrompt = input.messages.map((message) => message.content).join("\n\n");
      if (!reviewPrompt.includes("Final Verification Gap Report for T6")) {
        throw new Error("Review prompt did not include the verification-gap report.");
      }
      return [
        "Review.",
        "```json",
        JSON.stringify({
          action: "review",
          results: [
            {
              taskId: "T6",
              verdict: "approve",
              specVerdict: "approve",
              qualityVerdict: "approve",
              fixInstructions: "",
            },
          ],
          newTasks: [],
          done: true,
          notes: "Gap report reviewed.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label === "Architect is writing the build summary") {
      return "Build completed after reviewing the verification-gap report.";
    }
    throw new Error(`Unexpected gap-report model call label: ${input.label}`);
  },
};

try {
  await runBuildDiscussion(
    gapReportDiscussion,
    [architect, worker],
    () => {},
    gapReportHooks
  );
} catch (err) {
  gapReportError = err;
}

const gapReportCompleted = storeApi.getDiscussionById(gapReportDiscussion.id)?.status;
check(
  "scoped verification-gap report goes to Architect review without another worker tool turn",
  gapReportError == null &&
    gapReportReviewCalls === 1 &&
    gapReportCompleted === "completed" &&
    !gapReportCalls.some((call) => call.label === "Test Worker finalizing T6: Verify static app"),
  {
    error:
      gapReportError instanceof Error ? gapReportError.message : gapReportError,
    labels: gapReportCalls.map((call) => call.label),
    gapReportReviewCalls,
    gapReportCompleted,
  }
);

if (failed === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failed} check(s) failed`);
  process.exitCode = 1;
}
