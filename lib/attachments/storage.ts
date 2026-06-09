import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { classifyMimeType } from "./classify";
import type { AttachmentPayload, AttachmentRecord, AttachmentSummary } from "./types";
import { MAX_ATTACHMENT_BYTES } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const ATTACHMENTS_DIR = path.join(DATA_DIR, "attachments");
const STORE_PATH = path.join(DATA_DIR, "store.json");

interface Store {
  attachments: AttachmentRecord[];
  [key: string]: unknown;
}

function ensureDirs() {
  if (!fs.existsSync(ATTACHMENTS_DIR)) {
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  }
}

function readStore(): Store {
  ensureDirs();
  if (!fs.existsSync(STORE_PATH)) {
    return { attachments: [] };
  }
  const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as Store;
  if (!raw.attachments) raw.attachments = [];
  return raw;
}

function writeAttachments(attachments: AttachmentRecord[]) {
  ensureDirs();
  let store: Store = { attachments: [] };
  if (fs.existsSync(STORE_PATH)) {
    store = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as Store;
  }
  store.attachments = attachments;
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

function attachmentDir(id: string) {
  return path.join(ATTACHMENTS_DIR, id);
}

export async function saveAttachment(
  file: File
): Promise<AttachmentSummary> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`File too large (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB)`);
  }

  const id = uuidv4();
  const category = classifyMimeType(file.type || "application/octet-stream", file.name);
  const dir = attachmentDir(id);
  fs.mkdirSync(dir, { recursive: true });

  const buffer = Buffer.from(await file.arrayBuffer());
  const storagePath = path.join(dir, file.name);
  fs.writeFileSync(storagePath, buffer);

  let textContent: string | undefined;
  if (category === "text_inline") {
    textContent = buffer.toString("utf8").slice(0, 500_000);
  }

  const record: AttachmentRecord = {
    id,
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    category,
    size: file.size,
    textContent,
    storagePath,
    createdAt: new Date().toISOString(),
  };

  const store = readStore();
  store.attachments.push(record);
  writeAttachments(store.attachments);

  return {
    id: record.id,
    filename: record.filename,
    mimeType: record.mimeType,
    category: record.category,
    size: record.size,
  };
}

export function getAttachment(id: string): AttachmentRecord | undefined {
  return readStore().attachments.find((a) => a.id === id);
}

export function getAttachments(ids: string[]): AttachmentRecord[] {
  const store = readStore();
  return ids
    .map((id) => store.attachments.find((a) => a.id === id))
    .filter((a): a is AttachmentRecord => !!a);
}

export function loadAttachmentPayloads(ids: string[]): AttachmentPayload[] {
  return getAttachments(ids).map((record) => {
    const payload: AttachmentPayload = {
      id: record.id,
      filename: record.filename,
      mimeType: record.mimeType,
      category: record.category,
      textContent: record.textContent,
    };

    if (record.category !== "text_inline" && fs.existsSync(record.storagePath)) {
      payload.base64Data = fs.readFileSync(record.storagePath).toString("base64");
    }

    return payload;
  });
}

export function deleteAttachment(id: string) {
  const store = readStore();
  const record = store.attachments.find((a) => a.id === id);
  if (record) {
    const dir = attachmentDir(id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  writeAttachments(store.attachments.filter((a) => a.id !== id));
}
