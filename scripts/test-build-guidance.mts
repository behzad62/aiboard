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
      messages: input.messages,
      maxTokens: input.maxTokens,
    });
    if (input.label === "Architect is planning the project") {
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
      messages: input.messages,
      maxTokens: input.maxTokens,
    });
    if (input.label === "Architect is planning the project") {
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

if (failed === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failed} check(s) failed`);
  process.exitCode = 1;
}
