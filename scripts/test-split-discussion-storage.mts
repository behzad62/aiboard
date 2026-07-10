/*
 * Split discussion storage checks
 * (run: npx tsx scripts/test-split-discussion-storage.mts)
 */
import {
  deleteDiscussion,
  exportStore,
  flush,
  __clearClientStoreForTests,
  __loadClientStoreFromAdapterForTests,
  __resetClientStoreForTests,
  __setAdapterForTests,
  __switchClientStoreAdapterForTests,
} from "../lib/client/store";
import type { StorageAdapter } from "../lib/client/storage-adapter";
import type {
  BuildCheckpoint,
  BuildFileRecord,
  Discussion,
  FinalResult,
  Message,
} from "../lib/db/schema";
import type { AttachmentRecord } from "../lib/attachments/types";
import type { ContextBlob } from "../lib/build-context/context-store";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

class MemorySplitAdapter implements StorageAdapter {
  readonly kind = "filesystem" as const;
  main: string | null = null;
  saveCalls = 0;
  discussionFiles = new Map<string, string>();

  private key(discussionId: string, relativePath: string): string {
    return `${discussionId}/${relativePath}`;
  }

  async load(): Promise<string | null> {
    return this.main;
  }

  async save(blob: string): Promise<void> {
    this.saveCalls += 1;
    this.main = blob;
  }

  async listDiscussionIds(): Promise<string[]> {
    return Array.from(
      new Set(Array.from(this.discussionFiles.keys()).map((key) => key.split("/")[0]))
    ).sort();
  }

  async loadDiscussionFile(
    discussionId: string,
    relativePath: string
  ): Promise<string | null> {
    return this.discussionFiles.get(this.key(discussionId, relativePath)) ?? null;
  }

  async saveDiscussionFile(
    discussionId: string,
    relativePath: string,
    blob: string
  ): Promise<void> {
    this.discussionFiles.set(this.key(discussionId, relativePath), blob);
  }

  async deleteDiscussionFile(
    discussionId: string,
    relativePath: string
  ): Promise<void> {
    this.discussionFiles.delete(this.key(discussionId, relativePath));
  }

  async deleteDiscussion(discussionId: string): Promise<void> {
    for (const key of Array.from(this.discussionFiles.keys())) {
      if (key.startsWith(`${discussionId}/`)) this.discussionFiles.delete(key);
    }
  }

  async listBenchmarkRunIds(): Promise<string[]> {
    return [];
  }

  async loadBenchmarkRun(): Promise<string | null> {
    return null;
  }

  async saveBenchmarkRun(): Promise<void> {}

  async deleteBenchmarkRun(): Promise<void> {}

  label(): string {
    return "memory-split-adapter";
  }
}

const discussion: Discussion = {
  id: "disc-split",
  topic: "Split storage",
  mode: "build",
  effort: "medium",
  status: "completed",
  modelIds: JSON.stringify(["openai:gpt-test"]),
  judgeModelId: "openai:gpt-test",
  attachmentIds: JSON.stringify(["att-split"]),
  currentRound: 2,
  maxRounds: 3,
  convergenceScore: 0.8,
  createdAt: "2026-07-07T00:00:00.000Z",
  updatedAt: "2026-07-07T00:01:00.000Z",
};

const message: Message = {
  id: "msg-split",
  discussionId: discussion.id,
  round: 1,
  modelId: "openai:gpt-test",
  role: "assistant",
  content: "Large answer",
  createdAt: "2026-07-07T00:00:10.000Z",
};

const finalResult: FinalResult = {
  discussionId: discussion.id,
  answer: "Final answer",
  confidence: 0.9,
  dissent: JSON.stringify([]),
  createdAt: "2026-07-07T00:01:00.000Z",
};

const attachment: AttachmentRecord = {
  id: "att-split",
  filename: "diagram.png",
  mimeType: "image/png",
  category: "image",
  size: 3,
  base64Data: "abc",
  createdAt: "2026-07-07T00:00:01.000Z",
};

const buildFile: BuildFileRecord = {
  discussionId: discussion.id,
  path: "src/app.ts",
  content: "export const value = 1;",
  updatedAt: "2026-07-07T00:00:30.000Z",
};

const checkpoint = {
  discussionId: discussion.id,
  status: "completed",
  updatedAt: "2026-07-07T00:00:45.000Z",
  runPolicy: "finish",
  wave: 1,
  tasks: [],
  architectNotes: "done",
  verifyCommand: "npm test",
  branch: null,
  prUrl: null,
  milestone: null,
  issueNumbers: [],
  failureFingerprints: {},
  recoveryLog: [],
  usageWindow: {
    startedAt: "2026-07-07T00:00:00.000Z",
    elapsedMs: 1,
    estimatedUsd: 0,
    unknownPricedModelIds: [],
    models: [],
  },
} satisfies BuildCheckpoint;

const contextBlob: ContextBlob = {
  id: "ctx_split",
  discussionId: discussion.id,
  kind: "tool_exchange",
  label: "tool output",
  digest: "digest",
  text: "full tool output",
  contentHash: "hash",
  charCount: 16,
  tokenEstimate: 4,
  createdAt: "2026-07-07T00:00:20.000Z",
};

const adapter = new MemorySplitAdapter();

__resetClientStoreForTests({
  discussions: [discussion],
  messages: [message],
  finalResults: [finalResult],
  attachments: [attachment],
  buildFiles: [buildFile],
  buildCheckpoints: [checkpoint],
  contextBlobs: [contextBlob],
});
__setAdapterForTests(adapter);
await flush();

const envelope = JSON.parse(adapter.main ?? "{}") as {
  encrypted?: boolean;
  data?: string;
};
const main = JSON.parse(envelope.data ?? "{}") as Record<string, unknown>;

check("main store uses split schema", main.storageSchemaVersion === 2, main);
check(
  "main store no longer persists discussion messages",
  Array.isArray(main.messages) && main.messages.length === 0,
  main.messages
);
check(
  "main store no longer persists referenced attachment bytes",
  Array.isArray(main.attachments) && main.attachments.length === 0,
  main.attachments
);
check(
  "discussion messages file persisted",
  JSON.parse(adapter.discussionFiles.get("disc-split/messages.json") ?? "[]")[0]
    ?.id === message.id
);
check(
  "discussion context file persisted",
  JSON.parse(
    adapter.discussionFiles.get("disc-split/build/context-blobs.json") ?? "[]"
  )[0]?.id === contextBlob.id
);

__clearClientStoreForTests();
await __loadClientStoreFromAdapterForTests(adapter);
const reloaded = exportStore();
check("split reload restores discussion", reloaded.discussions[0]?.id === discussion.id);
check("split reload restores message", reloaded.messages[0]?.id === message.id);
check("split reload restores attachment", reloaded.attachments[0]?.id === attachment.id);
check(
  "split reload restores build checkpoint",
  reloaded.buildCheckpoints[0]?.discussionId === discussion.id
);
check("split reload restores context blob", reloaded.contextBlobs[0]?.id === contextBlob.id);

deleteDiscussion(discussion.id);
await flush();
const afterDeleteEnvelope = JSON.parse(adapter.main ?? "{}") as { data?: string };
const afterDeleteMain = JSON.parse(afterDeleteEnvelope.data ?? "{}") as {
  discussions?: Discussion[];
  attachments?: AttachmentRecord[];
};
check(
  "delete removes discussion from main index",
  (afterDeleteMain.discussions ?? []).length === 0,
  afterDeleteMain.discussions
);
check(
  "delete removes discussion-only attachments from main store",
  (afterDeleteMain.attachments ?? []).length === 0,
  afterDeleteMain.attachments
);
check(
  "delete removes discussion files",
  Array.from(adapter.discussionFiles.keys()).every(
    (key) => !key.startsWith(`${discussion.id}/`)
  ),
  Array.from(adapter.discussionFiles.keys())
);

__clearClientStoreForTests();

const existingDestination = new MemorySplitAdapter();
existingDestination.main = JSON.stringify({
  v: 1,
  encrypted: false,
  data: JSON.stringify({
    providerKeys: [
      {
        providerId: "openai",
        apiKey: "saved-destination-key",
        enabled: true,
        updatedAt: "2026-07-10T00:00:00.000Z",
      },
    ],
  }),
});
__resetClientStoreForTests({ providerKeys: [] });
await __switchClientStoreAdapterForTests(existingDestination);
const switchedToExisting = exportStore();
check(
  "switching storage loads an existing destination instead of overwriting it",
  switchedToExisting.providerKeys[0]?.providerId === "openai" &&
    existingDestination.saveCalls === 0,
  {
    providerIds: switchedToExisting.providerKeys.map((key) => key.providerId),
    saveCalls: existingDestination.saveCalls,
  }
);

__clearClientStoreForTests();

const emptyDestination = new MemorySplitAdapter();
__resetClientStoreForTests({
  providerKeys: [
    {
      providerId: "anthropic",
      apiKey: "source-key",
      enabled: true,
      updatedAt: "2026-07-10T00:00:00.000Z",
    },
  ],
});
const emptySwitch = await __switchClientStoreAdapterForTests(emptyDestination);
const migratedEnvelope = JSON.parse(emptyDestination.main ?? "{}") as {
  data?: string;
};
const migratedMain = JSON.parse(migratedEnvelope.data ?? "{}") as {
  providerKeys?: Array<{ providerId?: string }>;
};
check(
  "switching storage migrates current data only when the destination is empty",
  emptySwitch.loadedExisting === false &&
    emptyDestination.saveCalls === 1 &&
    migratedMain.providerKeys?.[0]?.providerId === "anthropic",
  {
    result: emptySwitch,
    saveCalls: emptyDestination.saveCalls,
    providerIds: migratedMain.providerKeys?.map((key) => key.providerId),
  }
);

__clearClientStoreForTests();

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}
process.exit(failures === 0 ? 0 : 1);
