import fs from "fs";
import path from "path";
import type {
  Discussion,
  DiscussionMode,
  DiscussionStatus,
  EffortLevel,
  FinalResult,
  Message,
  ProviderKey,
  UserSettings,
} from "./schema";

export * from "./schema";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");

interface Store {
  userSettings: UserSettings;
  providerKeys: ProviderKey[];
  discussions: Discussion[];
  messages: Message[];
  finalResults: FinalResult[];
  attachments?: import("../attachments/types").AttachmentRecord[];
}

const DEFAULT_STORE: Store = {
  userSettings: {
    id: "default",
    defaultEffort: "medium",
    defaultMode: "panel",
    judgeModelId: null,
  },
  providerKeys: [],
  discussions: [],
  messages: [],
  finalResults: [],
  attachments: [],
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readStore(): Store {
  ensureDataDir();
  if (!fs.existsSync(STORE_PATH)) {
    writeStore(DEFAULT_STORE);
    return structuredClone(DEFAULT_STORE);
  }
  const raw = fs.readFileSync(STORE_PATH, "utf8");
  return JSON.parse(raw) as Store;
}

function writeStore(store: Store) {
  ensureDataDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

function mutate(mutator: (store: Store) => void) {
  const store = readStore();
  mutator(store);
  writeStore(store);
  return store;
}

export function getDb() {
  return {
    insertDiscussion: (discussion: Discussion) => {
      mutate((s) => {
        s.discussions.unshift(discussion);
      });
    },
    updateDiscussion: (id: string, patch: Partial<Discussion>) => {
      mutate((s) => {
        const idx = s.discussions.findIndex((d) => d.id === id);
        if (idx >= 0) {
          s.discussions[idx] = { ...s.discussions[idx], ...patch };
        }
      });
    },
    insertMessage: (message: Message) => {
      mutate((s) => {
        s.messages.push(message);
      });
    },
    insertFinalResult: (result: FinalResult) => {
      mutate((s) => {
        const idx = s.finalResults.findIndex(
          (r) => r.discussionId === result.discussionId
        );
        if (idx >= 0) s.finalResults[idx] = result;
        else s.finalResults.push(result);
      });
    },
    upsertProviderKey: (key: ProviderKey) => {
      mutate((s) => {
        const idx = s.providerKeys.findIndex(
          (k) => k.providerId === key.providerId
        );
        if (idx >= 0) s.providerKeys[idx] = key;
        else s.providerKeys.push(key);
      });
    },
    updateProviderKey: (
      providerId: string,
      patch: Partial<ProviderKey>
    ) => {
      mutate((s) => {
        const idx = s.providerKeys.findIndex((k) => k.providerId === providerId);
        if (idx >= 0) {
          s.providerKeys[idx] = { ...s.providerKeys[idx], ...patch };
        }
      });
    },
    updateUserSettings: (patch: Partial<UserSettings>) => {
      mutate((s) => {
        s.userSettings = { ...s.userSettings, ...patch };
      });
    },
  };
}

export function getDiscussionById(id: string): Discussion | undefined {
  return readStore().discussions.find((d) => d.id === id);
}

export function listDiscussions(limit = 50): Discussion[] {
  return readStore().discussions.slice(0, limit);
}

export function getMessagesForDiscussion(discussionId: string): Message[] {
  return readStore()
    .messages.filter((m) => m.discussionId === discussionId)
    .sort((a, b) => a.round - b.round || a.createdAt.localeCompare(b.createdAt));
}

export function getFinalResult(discussionId: string): FinalResult | undefined {
  return readStore().finalResults.find((r) => r.discussionId === discussionId);
}

export function getUserSettings(): UserSettings {
  return readStore().userSettings;
}

export function getProviderKeys(): ProviderKey[] {
  return readStore().providerKeys;
}

export function getProviderKey(providerId: string): ProviderKey | undefined {
  return readStore().providerKeys.find((k) => k.providerId === providerId);
}

// Re-export schema helpers for typed inserts
export type {
  Discussion,
  DiscussionMode,
  DiscussionStatus,
  EffortLevel,
  FinalResult,
  Message,
  ProviderKey,
  UserSettings,
};
