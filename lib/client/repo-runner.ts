/**
 * Browser-side client for the local runner's repo (Git) endpoints
 * (`GET /repo/status`, `POST /repo/diff`; runner NRW-001+). Pure fetch code,
 * no `node:*` imports — mirrors lib/client/runner.ts.
 *
 * The runner wraps its payloads as `{ ok: true, ...fields }`; we parse the
 * typed fields out defensively so a malformed or older response degrades
 * gracefully instead of throwing.
 */
import { isValidGitRefName } from "@/lib/orchestrator/build";
import { headers, type RunnerConfig } from "./runner";

/**
 * Max length of the slug portion of a generated `codex/<slug>` branch name.
 * Keeps auto-derived branch names short enough to stay readable in `git` UIs
 * and well under Git's ref-name limits even after the `codex/` prefix.
 */
const MAX_BRANCH_SLUG_LEN = 40;

/**
 * Derive a safe feature-branch name `codex/<slug>` from the user's request
 * (NRW-005). Lowercases, maps non-alphanumerics to `-`, collapses repeats,
 * trims, and caps the slug length. Falls back to `codex/build` when the request
 * yields no usable slug OR when the generated name somehow fails
 * `isValidGitRefName` — so the result is GUARANTEED valid at runtime, not only
 * by construction. Pure (no runner deps) so the test can import it directly.
 */
export function branchNameForTopic(topic: string, issueNumber?: number | null): string {
  const lowered = (topic || "").toLowerCase();
  const featureSlug =
    /\bgames?\b/.test(lowered) && /\bchess\b/.test(lowered)
      ? "games-chess"
      : "";
  const rawSlug = featureSlug || lowered;
  const slug = rawSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BRANCH_SLUG_LEN)
    .replace(/-+$/g, "");
  const prefix =
    typeof issueNumber === "number" && Number.isInteger(issueNumber) && issueNumber > 0
      ? `issue-${issueNumber}-`
      : "";
  const finalSlug = `${prefix}${slug || "build"}`.slice(0, MAX_BRANCH_SLUG_LEN).replace(/-+$/g, "");
  const name = `codex/${finalSlug || "build"}`;
  // Defensive: enforce the invariant rather than merely asserting it. If the
  // generated name unexpectedly fails validation, fall back to a known-good one.
  return isValidGitRefName(name) ? name : "codex/build";
}

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
  githubCli: {
    available: boolean;
    authenticated: boolean;
    user: string | null;
    error?: string;
  };
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

function asGithubCli(value: unknown): RepoStatus["githubCli"] {
  const v = (value ?? {}) as {
    available?: unknown;
    authenticated?: unknown;
    user?: unknown;
    error?: unknown;
  };
  return {
    available: !!v.available,
    authenticated: !!v.authenticated,
    user: asString(v.user),
    error: asString(v.error) ?? undefined,
  };
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
      githubCli: asGithubCli(data.githubCli),
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

/**
 * PURE branch-safety classifier (no fetch / no engine deps) so the test, the
 * panel, and the engine can all import it. Decides whether native repo workflow
 * (commit / PR — added in later issues) is SAFE to engage and whether a feature
 * branch must be created first.
 *
 * Rules (NRW-005):
 * - Non-repo folders are SAFE for ordinary file writing; repo workflow simply
 *   doesn't apply (`needsBranch: false`).
 * - Any conflicted files make repo workflow UNSAFE.
 * - On the default branch — or on `main`/`master` even when the default is
 *   unknown — repo workflow requires a feature branch (`needsBranch: true`).
 * - Dirty state does NOT block branch creation; it only colours the reason text.
 * - Otherwise (feature branch, no conflicts) repo workflow is SAFE.
 */
export function classifyRepoBranchSafety(input: {
  isRepo: boolean;
  currentBranch: string | null;
  defaultBranch: string | null;
  clean: boolean;
  conflicted: string[];
}): { safe: boolean; needsBranch: boolean; reason: string } {
  if (!input.isRepo) {
    return { safe: true, needsBranch: false, reason: "not a git repo" };
  }
  if (input.conflicted.length > 0) {
    return {
      safe: false,
      needsBranch: false,
      reason: `repo has ${input.conflicted.length} conflicted file(s) — resolve conflicts before repo workflow`,
    };
  }
  const current = input.currentBranch;
  const onDefault = current != null && current === input.defaultBranch;
  const onMainOrMaster = current === "main" || current === "master";
  const dirtyNote = input.clean ? "" : " (working tree is dirty)";
  if (onDefault || onMainOrMaster) {
    const which = onDefault ? `default branch "${current}"` : `"${current}"`;
    return {
      safe: false,
      needsBranch: true,
      reason: `on ${which} — create a feature branch before commit/PR workflow${dirtyNote}`,
    };
  }
  if (current == null) {
    // Detached HEAD: no feature branch to commit onto. Treat as needing a branch.
    return {
      safe: false,
      needsBranch: true,
      reason: `detached HEAD — create a feature branch before commit/PR workflow${dirtyNote}`,
    };
  }
  return {
    safe: true,
    needsBranch: false,
    reason: `on feature branch "${current}"${dirtyNote}`,
  };
}

export function repoCommitWorkflowEnabledFromStatus(input: {
  isRepo: boolean;
  currentBranch: string | null;
  defaultBranch: string | null;
  clean: boolean;
  conflicted: string[];
}): boolean {
  const decision = classifyRepoBranchSafety(input);
  return input.isRepo && decision.safe && !decision.needsBranch;
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

export interface RepoCommitResult {
  hash: string;
  subject: string;
  committedFiles: string[];
}

/**
 * Stage and commit changes via the runner (NRW-006). Mixed wrapper, same shape
 * as `createBranchViaRunner`:
 * - HTTP 404 (old runner) or network failure → `null` (workflow unavailable);
 * - HTTP 400 validation error (empty commit, bad message, unsafe path) → throw
 *   with the runner's message so the caller can surface it to the model / user.
 */
export async function commitViaRunner(
  config: RunnerConfig,
  input: { message: string; paths?: string[] }
): Promise<RepoCommitResult | null> {
  let res: Response;
  try {
    res = await fetch(`${config.url.replace(/\/$/, "")}/repo/commit`, {
      method: "POST",
      headers: headers(config.token),
      body: JSON.stringify({
        message: input.message,
        paths: input.paths,
      }),
    });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? `Runner commit failed (HTTP ${res.status})`);
  }
  return {
    hash: typeof data.hash === "string" ? data.hash : "",
    subject: typeof data.subject === "string" ? data.subject : input.message,
    committedFiles: asStringArray(data.committedFiles),
  };
}

export interface RepoIssue {
  repo: string;
  issue: number;
  title: string;
  body: string;
  url: string;
  comments: Array<{ author: string; body: string; createdAt: string }>;
}

export interface RepoIssueListItem {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  updatedAt: string;
}

export interface RepoIssueListResult {
  repo: string;
  issues: RepoIssueListItem[];
}

function asIssueListItems(value: unknown): RepoIssueListItem[] {
  return Array.isArray(value)
    ? value.map((item) => {
        const v = (item ?? {}) as {
          number?: unknown;
          title?: unknown;
          body?: unknown;
          url?: unknown;
          labels?: unknown;
          updatedAt?: unknown;
        };
        return {
          number: asNumber(v.number),
          title: typeof v.title === "string" ? v.title : "",
          body: typeof v.body === "string" ? v.body : "",
          url: typeof v.url === "string" ? v.url : "",
          labels: asStringArray(v.labels),
          updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "",
        };
      })
    : [];
}

export async function listIssuesViaRunner(
  config: RunnerConfig,
  input: { repo: string; labels?: string[]; limit?: number }
): Promise<RepoIssueListResult | null> {
  let res: Response;
  try {
    res = await fetch(`${config.url.replace(/\/$/, "")}/repo/issue-list`, {
      method: "POST",
      headers: headers(config.token),
      body: JSON.stringify({
        repo: input.repo,
        labels: input.labels,
        limit: input.limit,
      }),
    });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? `Runner issue list failed (HTTP ${res.status})`);
  }
  return {
    repo: typeof data.repo === "string" ? data.repo : input.repo,
    issues: asIssueListItems(data.issues),
  };
}

export interface RepoMilestoneResult {
  repo: string;
  title: string;
  number: number;
  url: string;
  created: boolean;
}

export async function createMilestoneViaRunner(
  config: RunnerConfig,
  input: { repo: string; title: string; description?: string }
): Promise<RepoMilestoneResult | null> {
  let res: Response;
  try {
    res = await fetch(`${config.url.replace(/\/$/, "")}/repo/milestone-create`, {
      method: "POST",
      headers: headers(config.token),
      body: JSON.stringify({
        repo: input.repo,
        title: input.title,
        description: input.description,
      }),
    });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? `Runner milestone create failed (HTTP ${res.status})`);
  }
  return {
    repo: typeof data.repo === "string" ? data.repo : input.repo,
    title: typeof data.title === "string" ? data.title : input.title,
    number: asNumber(data.number),
    url: typeof data.url === "string" ? data.url : "",
    created: !!data.created,
  };
}

export interface RepoIssueCreateResult {
  repo: string;
  issue: number;
  title: string;
  url: string;
}

export async function createIssueViaRunner(
  config: RunnerConfig,
  input: {
    repo: string;
    title: string;
    body: string;
    milestone?: string;
    labels?: string[];
  }
): Promise<RepoIssueCreateResult | null> {
  let res: Response;
  try {
    res = await fetch(`${config.url.replace(/\/$/, "")}/repo/issue-create`, {
      method: "POST",
      headers: headers(config.token),
      body: JSON.stringify({
        repo: input.repo,
        title: input.title,
        body: input.body,
        milestone: input.milestone,
        labels: input.labels,
      }),
    });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? `Runner issue create failed (HTTP ${res.status})`);
  }
  return {
    repo: typeof data.repo === "string" ? data.repo : input.repo,
    issue: asNumber(data.issue),
    title: typeof data.title === "string" ? data.title : input.title,
    url: typeof data.url === "string" ? data.url : "",
  };
}

function asIssueComments(
  value: unknown
): Array<{ author: string; body: string; createdAt: string }> {
  return Array.isArray(value)
    ? value.map((c) => {
        const v = (c ?? {}) as {
          author?: unknown;
          body?: unknown;
          createdAt?: unknown;
        };
        return {
          author: typeof v.author === "string" ? v.author : "",
          body: typeof v.body === "string" ? v.body : "",
          createdAt: typeof v.createdAt === "string" ? v.createdAt : "",
        };
      })
    : [];
}

/**
 * Import a GitHub issue via the runner (NRW-007, gh-backed). Mixed wrapper:
 * - HTTP 404 (old runner) or network failure → `null` (workflow unavailable);
 * - any other non-OK response (400 validation, 502 gh/network failure) → throw
 *   with the runner's message so the caller can surface it to the model / user.
 */
export async function readIssueViaRunner(
  config: RunnerConfig,
  input: { repo: string; issue: number }
): Promise<RepoIssue | null> {
  let res: Response;
  try {
    res = await fetch(`${config.url.replace(/\/$/, "")}/repo/issue-read`, {
      method: "POST",
      headers: headers(config.token),
      body: JSON.stringify({ repo: input.repo, issue: input.issue }),
    });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? `Runner issue read failed (HTTP ${res.status})`);
  }
  return {
    repo: typeof data.repo === "string" ? data.repo : input.repo,
    issue: asNumber(data.issue) || input.issue,
    title: typeof data.title === "string" ? data.title : "",
    body: typeof data.body === "string" ? data.body : "",
    url: typeof data.url === "string" ? data.url : "",
    comments: asIssueComments(data.comments),
  };
}

export interface RepoPushResult {
  remote: string;
  branch: string;
  setUpstream: boolean;
  output: string;
}

/**
 * Push a branch via the runner (NRW-007, explicit git argv — GIT, not gh).
 * Mixed wrapper, same shape as the other repo wrappers:
 * - HTTP 404 (old runner) or network failure → `null` (workflow unavailable);
 * - HTTP 400 validation / git push failure → throw with the runner's message.
 */
export async function pushViaRunner(
  config: RunnerConfig,
  input: { remote?: string; branch: string; setUpstream?: boolean }
): Promise<RepoPushResult | null> {
  let res: Response;
  try {
    res = await fetch(`${config.url.replace(/\/$/, "")}/repo/push`, {
      method: "POST",
      headers: headers(config.token),
      body: JSON.stringify({
        remote: input.remote,
        branch: input.branch,
        setUpstream: input.setUpstream,
      }),
    });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? `Runner push failed (HTTP ${res.status})`);
  }
  return {
    remote: typeof data.remote === "string" ? data.remote : input.remote ?? "origin",
    branch: typeof data.branch === "string" ? data.branch : input.branch,
    setUpstream: !!data.setUpstream,
    output: typeof data.output === "string" ? data.output : "",
  };
}

export interface RepoPrResult {
  url: string;
  title: string;
  base: string | null;
  head: string | null;
  draft: boolean;
}

/**
 * Create a (draft) pull request via the runner (NRW-007, gh-backed). Mixed
 * wrapper, same shape as `readIssueViaRunner`:
 * - HTTP 404 (old runner) or network failure → `null` (workflow unavailable);
 * - any other non-OK response (400 validation, 502 gh failure) → throw with the
 *   runner's message so the caller can surface it to the model / user.
 */
export async function createPrViaRunner(
  config: RunnerConfig,
  input: {
    repo?: string;
    title: string;
    body: string;
    base?: string;
    head?: string;
    draft?: boolean;
  }
): Promise<RepoPrResult | null> {
  let res: Response;
  try {
    res = await fetch(`${config.url.replace(/\/$/, "")}/repo/pr-create`, {
      method: "POST",
      headers: headers(config.token),
      body: JSON.stringify({
        repo: input.repo,
        title: input.title,
        body: input.body,
        base: input.base,
        head: input.head,
        draft: input.draft,
      }),
    });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? `Runner PR create failed (HTTP ${res.status})`);
  }
  return {
    url: typeof data.url === "string" ? data.url : "",
    title: typeof data.title === "string" ? data.title : input.title,
    base: asString(data.base),
    head: asString(data.head),
    draft: !!data.draft,
  };
}
