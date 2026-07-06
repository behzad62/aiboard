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

if (failed === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failed} check(s) failed`);
  process.exitCode = 1;
}
