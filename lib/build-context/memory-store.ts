export type BuildMemoryStatus = "active" | "stale" | "superseded" | "dismissed";

export type BuildMemoryKind =
  | "user_correction"
  | "decision"
  | "failed_approach"
  | "fragile_file"
  | "skill_violation"
  | "reliable_command";

export type BuildMemoryEvidenceKind =
  | "context_blob"
  | "problem"
  | "task"
  | "command"
  | "review"
  | "user_note"
  | "skill";

export interface BuildMemoryEvidenceRef {
  kind: BuildMemoryEvidenceKind;
  ref: string;
  excerpt?: string;
}

export interface BuildMemoryRecord {
  id: string;
  projectKey: string;
  discussionId?: string;
  kind: BuildMemoryKind;
  status: BuildMemoryStatus;
  summary: string;
  detail?: string;
  paths?: string[];
  taskIds?: string[];
  command?: string;
  evidence: BuildMemoryEvidenceRef[];
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  hitCount: number;
}

export interface BuildMemoryProjectKeyInput {
  repoRemoteUrl?: string | null;
  runnerProjectRoot?: string | null;
  projectFolderName?: string | null;
  discussionId: string;
}

const MAX_SUMMARY_CHARS = 280;
const MAX_DETAIL_CHARS = 1_200;

export function compactOneLine(text: string, maxChars = MAX_SUMMARY_CHARS): string {
  const compacted = text.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function stableHash(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return value.toString(36);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop()
    ?.replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "";
}

function normalizeProjectPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function normalizeMemoryPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+/g, "/").trim();
}

export function normalizeRepoRemoteUrl(url: string | null | undefined): string | null {
  const raw = url?.trim();
  if (!raw) return null;
  let normalized = raw.replace(/\\/g, "/");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    normalized = normalized
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
      .replace(/^[^@/\s]+@/, "");
  } else {
    const scp = /^([^@/\s]+@)?([^:/\s]+):(.+)$/i.exec(normalized);
    if (scp) {
      normalized = `${scp[2]}/${scp[3]}`;
    } else {
      normalized = normalized.replace(/^[^@/\s]+@/, "");
    }
  }
  normalized = normalized
    .replace(/^[^@/\s]+@/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  if (!normalized || !normalized.includes("/")) return null;
  return normalized;
}

export function deriveBuildMemoryProjectKey(input: BuildMemoryProjectKeyInput): string {
  const remote = normalizeRepoRemoteUrl(input.repoRemoteUrl);
  if (remote) return `repo:${remote}`;
  const runnerRoot = input.runnerProjectRoot?.trim();
  if (runnerRoot) {
    const normalizedRoot = normalizeProjectPath(runnerRoot);
    const folder = slugify(normalizedRoot) || "project";
    return `folder:${folder}-${stableHash(normalizedRoot).slice(0, 10)}`;
  }
  const folder = slugify(input.projectFolderName ?? "");
  if (folder) return `folder:${folder}-${stableHash(folder).slice(0, 10)}`;
  return `discussion:${input.discussionId}`;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function uniqueEvidence(values: BuildMemoryEvidenceRef[]): BuildMemoryEvidenceRef[] {
  const seen = new Set<string>();
  const out: BuildMemoryEvidenceRef[] = [];
  for (const value of values) {
    if (!value.ref.trim()) continue;
    const key = `${value.kind}:${value.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: value.kind,
      ref: value.ref,
      excerpt: value.excerpt ? compactOneLine(value.excerpt, 220) : undefined,
    });
  }
  return out;
}

function identityFor(input: {
  projectKey: string;
  kind: BuildMemoryKind;
  summary: string;
  paths?: string[];
  taskIds?: string[];
  command?: string;
}): string {
  const paths = uniqueStrings((input.paths ?? []).map(normalizeMemoryPath))
    .map((p) => p.toLowerCase())
    .sort();
  const tasks = uniqueStrings(input.taskIds ?? [])
    .map((t) => t.toLowerCase())
    .sort();
  const command = input.command?.trim().toLowerCase() ?? "";
  const summary = compactOneLine(input.summary).toLowerCase();
  return [input.projectKey, input.kind, paths.join(","), tasks.join(","), command, summary].join("|");
}

export function buildMemoryRecord(input: {
  projectKey: string;
  discussionId?: string;
  kind: BuildMemoryKind;
  summary: string;
  detail?: string;
  paths?: string[];
  taskIds?: string[];
  command?: string;
  evidence: BuildMemoryEvidenceRef[];
  createdAt?: string;
  status?: BuildMemoryStatus;
}): BuildMemoryRecord {
  const evidence = uniqueEvidence(input.evidence);
  if (evidence.length === 0) {
    throw new Error("Build memory must include at least one evidence reference.");
  }
  const createdAt = input.createdAt ?? new Date().toISOString();
  const paths = uniqueStrings((input.paths ?? []).map(normalizeMemoryPath));
  const taskIds = uniqueStrings(input.taskIds ?? []);
  const summary = compactOneLine(input.summary);
  const command = input.command?.trim() || undefined;
  return {
    id: `mem_${stableHash(
      identityFor({
        projectKey: input.projectKey,
        kind: input.kind,
        summary,
        paths,
        taskIds,
        command,
      })
    )}`,
    projectKey: input.projectKey,
    discussionId: input.discussionId,
    kind: input.kind,
    status: input.status ?? "active",
    summary,
    detail: input.detail ? compactOneLine(input.detail, MAX_DETAIL_CHARS) : undefined,
    paths: paths.length > 0 ? paths : undefined,
    taskIds: taskIds.length > 0 ? taskIds : undefined,
    command,
    evidence,
    createdAt,
    updatedAt: createdAt,
    lastSeenAt: createdAt,
    hitCount: 1,
  };
}

export function mergeBuildMemoryRecord(
  existing: BuildMemoryRecord,
  incoming: BuildMemoryRecord
): BuildMemoryRecord {
  const updatedAt = incoming.updatedAt > existing.updatedAt ? incoming.updatedAt : existing.updatedAt;
  const lastSeenAt =
    incoming.lastSeenAt > existing.lastSeenAt ? incoming.lastSeenAt : existing.lastSeenAt;
  const status = existing.status === "active" ? incoming.status : existing.status;
  return {
    ...existing,
    discussionId: existing.discussionId ?? incoming.discussionId,
    status,
    summary: incoming.summary || existing.summary,
    detail: incoming.detail ?? existing.detail,
    paths: uniqueStrings([...(existing.paths ?? []), ...(incoming.paths ?? [])]),
    taskIds: uniqueStrings([...(existing.taskIds ?? []), ...(incoming.taskIds ?? [])]),
    command: existing.command ?? incoming.command,
    evidence: uniqueEvidence([...existing.evidence, ...incoming.evidence]),
    updatedAt,
    lastSeenAt,
    hitCount: existing.hitCount + Math.max(1, incoming.hitCount),
  };
}

export function isActiveBuildMemory(record: Pick<BuildMemoryRecord, "status">): boolean {
  return record.status === "active";
}

export function rekeyBuildMemoryRecord(
  record: BuildMemoryRecord,
  projectKey: string
): BuildMemoryRecord {
  const next = buildMemoryRecord({
    projectKey,
    discussionId: record.discussionId,
    kind: record.kind,
    summary: record.summary,
    detail: record.detail,
    paths: record.paths,
    taskIds: record.taskIds,
    command: record.command,
    evidence: record.evidence,
    createdAt: record.createdAt,
    status: record.status,
  });
  return {
    ...next,
    updatedAt: record.updatedAt,
    lastSeenAt: record.lastSeenAt,
    hitCount: record.hitCount,
  };
}
