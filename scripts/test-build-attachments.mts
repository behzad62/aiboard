/** Build attachment handoff checks (run: npx tsx scripts/test-build-attachments.mts) */
import { createRequire } from "node:module";
import {
  type ClientStore,
  type addAttachment,
  type getDiscussionById,
  type insertDiscussion,
  type __resetClientStoreForTests,
} from "../lib/client/store";
import type { AttachmentPayload, AttachmentRecord } from "../lib/attachments/types";
import type { Discussion } from "../lib/db/schema";
import type { OrchestratorEvent } from "../lib/orchestrator/engine";
import type { ChatMessage, SelectedModel } from "../lib/providers/base";

const require = createRequire(import.meta.url);
const storeApi = require("../lib/client/store") as {
  __resetClientStoreForTests: typeof __resetClientStoreForTests;
  addAttachment: typeof addAttachment;
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
  attachments?: AttachmentPayload[];
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

const now = "2026-06-29T00:00:00.000Z";
const attachment: AttachmentRecord = {
  id: "build-attachment-requirements",
  filename: "requirements.pdf",
  mimeType: "application/pdf",
  category: "document",
  size: 128,
  textContent: "The generated project must include a visible imported requirement.",
  base64Data: Buffer.from("%PDF test fixture").toString("base64"),
  createdAt: now,
};
const discussion: Discussion = {
  id: "disc-build-attachments",
  topic: "Create a small project from the attached requirements.",
  mode: "build",
  effort: "medium",
  status: "running",
  modelIds: JSON.stringify(["test:worker"]),
  judgeModelId: "test:architect",
  attachmentIds: JSON.stringify([attachment.id]),
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
storeApi.addAttachment(attachment);
storeApi.insertDiscussion(discussion);

const { runBuildDiscussion } = await import("../lib/client/build-engine");

const calls: ModelOverrideCall[] = [];
const hooks: NonNullable<Parameters<typeof runBuildDiscussion>[3]> = {
  modelCallOverride: async (input) => {
    calls.push({
      label: input.label,
      messages: input.messages,
      maxTokens: input.maxTokens,
      attachments: (input as { attachments?: AttachmentPayload[] }).attachments,
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
              title: "Create imported requirement file",
              instructions: "Create src/requirement.txt from the attached requirements.",
              contextFiles: [],
              outputPaths: ["src/requirement.txt"],
              expectedOutputs: "A text file containing the imported requirement.",
              dependsOn: [],
              difficulty: 1,
            },
          ],
          notes: "Use the provided attachment only during planning.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label.startsWith("Test Worker working on T1")) {
      return [
        "Implemented.",
        "```txt path=src/requirement.txt",
        "visible imported requirement",
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
      return "Build completed from the attachment.";
    }
    throw new Error(`Unexpected model call label: ${input.label}`);
  },
};

const events: OrchestratorEvent[] = [];
await runBuildDiscussion(discussion, [architect, worker], (event) => {
  events.push(event);
}, hooks);

const planningCall = calls.find((call) => call.label === "Architect is planning the project");
const nonPlanningCalls = calls.filter((call) => call.label !== "Architect is planning the project");
const workerCall = calls.find((call) => call.label.startsWith("Test Worker working on T1"));
const reviewCall = calls.find(
  (call) =>
    call.label === "Architect is reviewing wave 1" ||
    call.label === "Test Architect is reviewing wave 1"
);
const summaryCall = calls.find((call) => call.label === "Architect is writing the build summary");
const planPrompt = planningCall?.messages.map((message) => message.content).join("\n\n") ?? "";
const completed = storeApi.getDiscussionById(discussion.id)?.status;

check(
  "Build run completes through the normal Architect/worker/review path",
  completed === "completed" &&
    calls.some((call) => call.label.startsWith("Test Worker working on T1")) &&
    events.some((event) => event.type === "final_answer"),
  { completed, labels: calls.map((call) => call.label) }
);
check(
  "initial Architect planning call receives the raw build attachment",
  planningCall?.attachments?.length === 1 &&
    planningCall.attachments[0].id === attachment.id &&
    planningCall.attachments[0].base64Data === attachment.base64Data,
  planningCall?.attachments
);
check(
  "plan prompt includes an attachment manifest for planning context",
  planPrompt.includes("requirements.pdf") &&
    planPrompt.includes("initial Architect planning call") &&
    !planPrompt.includes(attachment.base64Data ?? ""),
  planPrompt
);
check(
  "worker, review, and summary calls do not repeatedly receive raw attachments",
  nonPlanningCalls.length >= 3 &&
    nonPlanningCalls.every((call) => (call.attachments?.length ?? 0) === 0),
  nonPlanningCalls.map((call) => ({
    label: call.label,
    attachmentCount: call.attachments?.length ?? 0,
  }))
);
check(
  "Build model calls use each model's output ceiling as the response budget",
  planningCall?.maxTokens === 32_768 &&
    workerCall?.maxTokens === 24_576 &&
    reviewCall?.maxTokens === 32_768 &&
    summaryCall?.maxTokens === 32_768,
  calls.map((call) => ({ label: call.label, maxTokens: call.maxTokens }))
);

const fallbackDiscussion: Discussion = {
  ...discussion,
  id: "disc-build-default-budget",
  modelIds: JSON.stringify(["test:fallback-worker"]),
  judgeModelId: "test:fallback-architect",
  attachmentIds: JSON.stringify([]),
  status: "running",
  currentRound: 0,
  createdAt: now,
  updatedAt: now,
};
const fallbackArchitect: SelectedModel = {
  modelId: "test:fallback-architect",
  providerId: "test",
  displayName: "Fallback Architect",
};
const fallbackWorker: SelectedModel = {
  modelId: "test:fallback-worker",
  providerId: "test",
  displayName: "Fallback Worker",
};
storeApi.insertDiscussion(fallbackDiscussion);
const fallbackCalls: ModelOverrideCall[] = [];
const fallbackHooks: NonNullable<Parameters<typeof runBuildDiscussion>[3]> = {
  modelCallOverride: async (input) => {
    fallbackCalls.push({
      label: input.label,
      messages: input.messages,
      maxTokens: input.maxTokens,
      attachments: (input as { attachments?: AttachmentPayload[] }).attachments,
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
              title: "Create fallback file",
              instructions: "Create src/fallback.txt.",
              contextFiles: [],
              outputPaths: ["src/fallback.txt"],
              expectedOutputs: "A fallback file.",
              dependsOn: [],
              difficulty: 1,
            },
          ],
          notes: "Use default budgets.",
        }),
        "```",
      ].join("\n");
    }
    if (input.label.startsWith("Fallback Worker working on T1")) {
      return [
        "Implemented.",
        "```txt path=src/fallback.txt",
        "fallback",
        "```",
      ].join("\n");
    }
    if (
      input.label === "Architect is reviewing wave 1" ||
      input.label === "Fallback Architect is reviewing wave 1"
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
      return "Build completed with fallback budgets.";
    }
    throw new Error(`Unexpected fallback model call label: ${input.label}`);
  },
};
await runBuildDiscussion(
  fallbackDiscussion,
  [fallbackArchitect, fallbackWorker],
  () => undefined,
  fallbackHooks
);
check(
  "Build model calls without explicit profiles keep Build minimum budgets",
  fallbackCalls.some(
    (call) =>
      call.label === "Architect is planning the project" &&
      call.maxTokens === 16_384
  ) &&
    fallbackCalls.some(
      (call) =>
        call.label.startsWith("Fallback Worker working on T1") &&
        call.maxTokens === 8_192
    ),
  fallbackCalls.map((call) => ({ label: call.label, maxTokens: call.maxTokens }))
);

if (failed === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failed} check(s) failed`);
  process.exitCode = 1;
}
