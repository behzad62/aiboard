import { estimateTokens } from "./token-estimator";

export const CONTEXT_REF_PREFIX = "ctx_";
export const CONTEXT_RETRIEVE_DEFAULT_TOKENS = 4_000;
export const CONTEXT_RETRIEVE_MAX_TOKENS = 12_000;
export const CONTEXT_DIGEST_PREVIEW_CHARS = 1_200;

export type ContextBlobKind =
  | "command_output"
  | "json"
  | "repo_diff"
  | "fetch"
  | "tool_exchange"
  | "text";

export type ContextBlobMetadataValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | number[]
  | boolean[];

export type ContextBlobMetadata = Record<string, ContextBlobMetadataValue>;

export interface ContextBlob {
  id: string;
  discussionId: string;
  kind: ContextBlobKind;
  label: string;
  digest: string;
  text: string;
  contentHash: string;
  charCount: number;
  tokenEstimate: number;
  createdAt: string;
  metadata?: ContextBlobMetadata;
}

export interface CreateContextBlobInput {
  discussionId: string;
  kind: ContextBlobKind;
  label: string;
  text: string;
  createdAt?: string;
  metadata?: ContextBlobMetadata;
}

export interface ContextRetrievalOptions {
  maxTokens?: number;
  maxChars?: number;
}

export interface ContextRetrievalResult {
  ref: string;
  label: string;
  kind: ContextBlobKind;
  text: string;
  truncated: boolean;
  returnedChars: number;
  totalChars: number;
  returnedTokens: number;
  totalTokens: number;
}

export function isContextBlobRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^ctx_[A-Za-z0-9_-]{3,120}$/.test(value.trim())
  );
}

export function clampContextRetrieveMaxTokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return CONTEXT_RETRIEVE_DEFAULT_TOKENS;
  }
  return Math.max(
    1,
    Math.min(CONTEXT_RETRIEVE_MAX_TOKENS, Math.round(value))
  );
}

function safeIdPart(value: string): string {
  const safe = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return safe || "text";
}

/**
 * Browser-safe deterministic 53-bit hash. This is not a security primitive; it
 * is only used to create compact stable ids and dedupe repeated context blobs.
 */
export function stableContextHash(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const high = (h2 >>> 0).toString(36).padStart(7, "0");
  const low = (h1 >>> 0).toString(36).padStart(7, "0");
  return `${high}${low}`.slice(0, 16);
}

function buildContextId(input: {
  discussionId: string;
  kind: ContextBlobKind;
  label: string;
  contentHash: string;
}): string {
  const idHash = stableContextHash(
    [input.discussionId, input.kind, input.label.trim(), input.contentHash].join(
      "\0"
    )
  );
  return `${CONTEXT_REF_PREFIX}${safeIdPart(input.kind)}_${idHash}`;
}

export function createContextBlob(input: CreateContextBlobInput): ContextBlob {
  const label = input.label.trim() || input.kind;
  const text = input.text;
  const contentHash = stableContextHash(text);
  const base: ContextBlob = {
    id: buildContextId({
      discussionId: input.discussionId,
      kind: input.kind,
      label,
      contentHash,
    }),
    discussionId: input.discussionId,
    kind: input.kind,
    label,
    digest: "",
    text,
    contentHash,
    charCount: text.length,
    tokenEstimate: estimateTokens(text),
    createdAt: input.createdAt ?? new Date().toISOString(),
    metadata: input.metadata,
  };
  return { ...base, digest: buildContextDigest(base) };
}

function previewText(text: string, maxChars = CONTEXT_DIGEST_PREVIEW_CHARS): string {
  if (text.length <= maxChars) return text || "(empty)";
  return `${text.slice(0, maxChars)}\n[preview truncated; retrieve the ref for exact bounded text]`;
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function compactOneLine(text: string, maxChars: number): string {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return "";
  return line.length <= maxChars ? line : `${line.slice(0, maxChars)}...`;
}

function jsonSummary(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return `JSON array with ${parsed.length} item(s).`;
    if (parsed && typeof parsed === "object") {
      const keys = Object.keys(parsed as Record<string, unknown>).slice(0, 12);
      return `JSON object keys: ${keys.join(", ") || "(none)"}.`;
    }
    return `JSON ${typeof parsed}.`;
  } catch {
    return "JSON text (not parseable by the digest helper).";
  }
}

function summaryForKind(blob: ContextBlob): string {
  if (blob.kind === "command_output") {
    const first = compactOneLine(blob.text, 160);
    const exit = /\bexit\s+-?\d+\b[^\n]*/i.exec(blob.text)?.[0];
    return [first, exit].filter(Boolean).join(" | ") || "Command output.";
  }
  if (blob.kind === "json") return jsonSummary(blob.text);
  if (blob.kind === "repo_diff") {
    const files = countMatches(blob.text, /^diff --git /gm);
    const additions = countMatches(blob.text, /^\+(?!\+\+)/gm);
    const deletions = countMatches(blob.text, /^-(?!--)/gm);
    return `Repo diff with ${files} file section(s), +${additions}/-${deletions} changed line(s).`;
  }
  if (blob.kind === "fetch") {
    return compactOneLine(blob.text, 180) || "Fetched text.";
  }
  if (blob.kind === "tool_exchange") {
    const assistant = countMatches(blob.text, /^## .*assistant\b/gim);
    const user = countMatches(blob.text, /^## .*user\b/gim);
    return `Omitted tool exchange transcript (${assistant} assistant, ${user} user message marker(s)).`;
  }
  return compactOneLine(blob.text, 180) || "Stored context text.";
}

export function buildContextDigest(
  blob: ContextBlob,
  options: { previewChars?: number } = {}
): string {
  const retrieve = `{"action":"context_retrieve","ref":"${blob.id}","maxTokens":${CONTEXT_RETRIEVE_DEFAULT_TOKENS},"reason":"need exact stored context"}`;
  return [
    `CONTEXT DIGEST: ${blob.label}`,
    `Ref: ${blob.id}`,
    `Kind: ${blob.kind}`,
    `Size: ${blob.charCount} chars, approx ${blob.tokenEstimate} tokens`,
    `Summary: ${summaryForKind(blob)}`,
    `Retrieve exact bounded text with: ${retrieve}`,
    "Preview:",
    previewText(blob.text, options.previewChars),
  ].join("\n");
}

export function buildCommandOutputDigest(blob: ContextBlob): string {
  return buildContextDigest({ ...blob, kind: "command_output" });
}

export function buildJsonDigest(blob: ContextBlob): string {
  return buildContextDigest({ ...blob, kind: "json" });
}

export function buildRepoDiffDigest(blob: ContextBlob): string {
  return buildContextDigest({ ...blob, kind: "repo_diff" });
}

export function buildFetchDigest(blob: ContextBlob): string {
  return buildContextDigest({ ...blob, kind: "fetch" });
}

export function buildToolExchangeDigest(blob: ContextBlob): string {
  return buildContextDigest({ ...blob, kind: "tool_exchange" });
}

function exactPrefixWithinTokenBudget(text: string, budgetTokens: number): string {
  if (budgetTokens <= 0 || text.length === 0) return "";
  if (estimateTokens(text) <= budgetTokens) return text;

  let low = 0;
  let high = text.length;
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(0, mid);
    if (estimateTokens(candidate) <= budgetTokens) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

export function retrieveContextBlobText(
  blob: ContextBlob,
  options: ContextRetrievalOptions = {}
): ContextRetrievalResult {
  const maxTokens = clampContextRetrieveMaxTokens(options.maxTokens);
  const charBound =
    typeof options.maxChars === "number" && Number.isFinite(options.maxChars)
      ? Math.max(0, Math.floor(options.maxChars))
      : blob.text.length;
  const charLimited = blob.text.slice(0, charBound);
  const text = exactPrefixWithinTokenBudget(charLimited, maxTokens);
  const returnedTokens = estimateTokens(text);
  return {
    ref: blob.id,
    label: blob.label,
    kind: blob.kind,
    text,
    truncated: text.length < blob.text.length,
    returnedChars: text.length,
    totalChars: blob.text.length,
    returnedTokens,
    totalTokens: blob.tokenEstimate,
  };
}
