/**
 * Browser-side client for the local runner's repo (Git) endpoints
 * (`GET /repo/status`, `POST /repo/diff`; runner NRW-001+). Pure fetch code,
 * no `node:*` imports — mirrors lib/client/runner.ts.
 *
 * The runner wraps its payloads as `{ ok: true, ...fields }`; we parse the
 * typed fields out defensively so a malformed or older response degrades
 * gracefully instead of throwing.
 */
import { headers, type RunnerConfig } from "./runner";

export interface RepoStatus {
  isRepo: boolean;
  root: string | null;
  currentBranch: string | null;
  defaultBranch: string | null;
  remotes: Array<{ name: string; url: string }>;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicted: string[];
  clean: boolean;
  recentCommits: Array<{ hash: string; subject: string }>;
  gitAvailable: boolean;
  error?: string;
}

export interface RepoDiffResult {
  diff: string;
  truncated: boolean;
  bytes: number;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function asRemotes(value: unknown): Array<{ name: string; url: string }> {
  return Array.isArray(value)
    ? value
        .filter(
          (r): r is { name: string; url: string } =>
            !!r &&
            typeof (r as { name?: unknown }).name === "string" &&
            typeof (r as { url?: unknown }).url === "string"
        )
        .map((r) => ({ name: r.name, url: r.url }))
    : [];
}

function asCommits(value: unknown): Array<{ hash: string; subject: string }> {
  return Array.isArray(value)
    ? value
        .filter(
          (c): c is { hash: string; subject: string } =>
            !!c &&
            typeof (c as { hash?: unknown }).hash === "string" &&
            typeof (c as { subject?: unknown }).subject === "string"
        )
        .map((c) => ({ hash: c.hash, subject: c.subject }))
    : [];
}

/**
 * Fetch repository status via the runner. "Soft" wrapper: returns `null` when
 * the runner is too old to support `/repo/status` (HTTP 404), on any other
 * non-OK response, or on a network failure — callers treat that as "no repo
 * info available".
 */
export async function getRepoStatusViaRunner(
  config: RunnerConfig
): Promise<RepoStatus | null> {
  try {
    const res = await fetch(`${config.url.replace(/\/$/, "")}/repo/status`, {
      headers: headers(config.token),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      isRepo: !!data.isRepo,
      root: asString(data.root),
      currentBranch: asString(data.currentBranch),
      defaultBranch: asString(data.defaultBranch),
      remotes: asRemotes(data.remotes),
      upstream: asString(data.upstream),
      ahead: asNumber(data.ahead),
      behind: asNumber(data.behind),
      staged: asStringArray(data.staged),
      unstaged: asStringArray(data.unstaged),
      untracked: asStringArray(data.untracked),
      conflicted: asStringArray(data.conflicted),
      clean: !!data.clean,
      recentCommits: asCommits(data.recentCommits),
      gitAvailable: !!data.gitAvailable,
      error: asString(data.error) ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch a Git diff via the runner. Mixed wrapper:
 * - HTTP 404 (old runner) or network failure → `null` (no repo info available);
 * - HTTP 400 validation error (e.g. an unsafe path) → throw with the runner's
 *   message so the caller can surface it.
 */
export async function getRepoDiffViaRunner(
  config: RunnerConfig,
  input?: { paths?: string[]; staged?: boolean; stat?: boolean }
): Promise<RepoDiffResult | null> {
  let res: Response;
  try {
    res = await fetch(`${config.url.replace(/\/$/, "")}/repo/diff`, {
      method: "POST",
      headers: headers(config.token),
      body: JSON.stringify({
        paths: input?.paths,
        staged: !!input?.staged,
        stat: !!input?.stat,
      }),
    });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? `Runner repo diff failed (HTTP ${res.status})`);
  }
  return {
    diff: typeof data.diff === "string" ? data.diff : "",
    truncated: !!data.truncated,
    bytes: asNumber(data.bytes),
  };
}

export interface RepoBranchCreateResult {
  branch: string;
  previousBranch: string | null;
  checkedOut: boolean;
}

/**
 * Create (and optionally check out) a Git branch via the runner. Mixed wrapper,
 * same shape as `getRepoDiffViaRunner`:
 * - HTTP 404 (old runner) or network failure → `null` (workflow unavailable);
 * - HTTP 400 validation error (bad name, conflicts) → throw with the runner's
 *   message so the caller can surface it to the model / user.
 */
export async function createBranchViaRunner(
  config: RunnerConfig,
  input: { name: string; base?: string; checkout?: boolean }
): Promise<RepoBranchCreateResult | null> {
  let res: Response;
  try {
    res = await fetch(`${config.url.replace(/\/$/, "")}/repo/branch-create`, {
      method: "POST",
      headers: headers(config.token),
      body: JSON.stringify({
        name: input.name,
        base: input.base,
        checkout: input.checkout,
      }),
    });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data.error ?? `Runner branch create failed (HTTP ${res.status})`
    );
  }
  return {
    branch: typeof data.branch === "string" ? data.branch : input.name,
    previousBranch: asString(data.previousBranch),
    checkedOut: !!data.checkedOut,
  };
}
