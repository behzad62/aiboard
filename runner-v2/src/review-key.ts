import { createHash } from "node:crypto";

import type { ExecutionTaskContract } from "./planning-contracts.js";

/**
 * W1 (AR-R27, S2 section 7.2 items 1-3, S3 L7): review economics.
 *
 * ReviewKey = hash(semantic task contract digest, actual base Git tree,
 * actual head Git tree OR real diff digest, verified evidence-content
 * digest, claim-binding digest, test-integrity digest, tier, reviewer
 * policy version).
 *
 * The same exact key returns the PRIOR actual durable verdict: no new
 * review opens, no model or depth workspace work runs, and no new repair
 * cycle is charged. Every dimension is verdict-affecting, so a mismatch on
 * any dimension is a conservative reuse miss (a fresh review), never a
 * cache invention. Unknown reviewer/worker/model identity is likewise a
 * miss, never a hit.
 *
 * Repair oscillation (S3 L7): a repair diff identical to, or the exact
 * reverse of, a FAILED attempt's real diff is a blocking runner finding.
 * Comparison is over actual meaningful Git/diff content with durable
 * lineage (the failed attempt number), not fresh labels and not bare
 * evidence ids. An unrelated substantive repair has a different
 * fingerprint and is never flagged.
 */

/** Reviewer policy version bound into every ReviewKey. Bump only when reviewer semantics change. */
export const REVIEWER_POLICY_VERSION = 1;

/** Durable lineage for one failed attempt's real repair diff. */
export interface FailedRepairDiff {
  readonly attempt: number;
  readonly forward: string;
  readonly reverse: string;
}

/** Audit inputs recorded beside a ReviewKey so a reuse can be re-derived. */
export interface ReviewKeyInputs {
  readonly semanticContractDigest: string;
  readonly baseTree: string;
  readonly headTree: string;
  readonly diffDigest: string;
  readonly diffArtifactHash: string;
  readonly evidenceContentDigest: string;
  readonly claimBindingDigest: string;
  readonly testIntegrityDigest: string;
  readonly tier: string;
  readonly reviewerPolicyVersion: number;
  readonly authorModelIdentity: string;
  readonly policyVersions: string;
}

function sha256Hex(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

/** Canonical JSON with sorted object keys; undefined fields are dropped by JSON. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/**
 * Canonical semantic task identity derived from the CURRENT accepted
 * contract content — never the plan digest alone (full plan identity is
 * not task identity). Lineage/history fields are excluded: they describe
 * where the contract came from, not what the task means. Optional fields
 * that are absent on historical shapes are simply absent from the digest
 * input, so old shapes hash deterministically instead of throwing.
 */
export function semanticContractDigest(contract: ExecutionTaskContract): string {
  const candidate = contract as Partial<ExecutionTaskContract>;
  return sha256Hex(canonicalJson({
    id: candidate.id,
    accountablePhaseId: candidate.accountablePhaseId,
    requirementIds: candidate.requirementIds,
    outcome: candidate.outcome,
    scope: candidate.scope,
    writableSurfaces: candidate.writableSurfaces,
    forbiddenSurfaces: candidate.forbiddenSurfaces,
    ...(candidate.sharedResourceClaims !== undefined ? { sharedResourceClaims: candidate.sharedResourceClaims } : {}),
    dependencies: candidate.dependencies,
    requiredBase: candidate.requiredBase,
    inputs: candidate.inputs,
    outputs: candidate.outputs,
    steps: candidate.steps,
    acceptance: candidate.acceptance,
    validation: candidate.validation,
    negativeProofApplicability: (candidate as Record<string, unknown>).negativeProofApplicability,
    reviewCriteria: candidate.reviewCriteria,
    integrationChecks: candidate.integrationChecks,
    cleanup: candidate.cleanup,
    ...(candidate.investigation !== undefined ? { investigation: candidate.investigation } : {}),
    requirementCriteriaMap: candidate.requirementCriteriaMap,
  }));
}

/** One claim's semantics with its evidence bound by verified content, never by bookkeeping id. */
export interface ClaimBindingClaim {
  readonly id: string;
  readonly text: string;
  readonly evidenceContent: readonly string[];
}

/**
 * W1 (F7): material claim semantics bound into the ReviewKey. Claim
 * ids and texts, the worker summary, unresolved concerns, the current
 * criterion texts and the repair-task objective are all
 * verdict-affecting: copied prior claimVerdicts cannot verify
 * materially new current claims. Evidence associations are bound by
 * verified content digests (sorted), so swapped links with the same
 * union still invalidate while bookkeeping id renames do not.
 */
export interface ClaimBindingInputs {
  readonly objective: string;
  readonly criteria: ReadonlyArray<{ readonly id: string; readonly text: string }>;
  readonly claims: readonly ClaimBindingClaim[];
  readonly workerSummary: string;
  readonly unresolvedConcerns: readonly string[];
  readonly repairTaskKind?: string;
}

export function claimBindingDigest(input: ClaimBindingInputs): string {
  const byId = (left: { readonly id: string }, right: { readonly id: string }): number =>
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return sha256Hex(canonicalJson({
    objective: input.objective,
    criteria: [...input.criteria].sort(byId).map((criterion) => ({ id: criterion.id, text: criterion.text })),
    claims: [...input.claims].sort(byId).map((claim) => ({
      id: claim.id,
      text: claim.text,
      // W1 (F4): within each claim only the UNIQUE verified content
      // associations bind, as the aggregate already does. A repeated
      // bookkeeping evidence id with identical verified content must
      // not look like new claim evidence.
      evidenceContent: [...new Set(claim.evidenceContent)].sort(),
    })),
    workerSummary: input.workerSummary,
    unresolvedConcerns: [...input.unresolvedConcerns].sort(),
    ...(input.repairTaskKind !== undefined ? { repairTaskKind: input.repairTaskKind } : {}),
  }));
}

/**
 * W1 (F5): baseline/candidate test-integrity identity bound into the
 * ReviewKey. Derived from durable state (no workspace): the accepted
 * plan pin, the durable baseline pin and the candidate revision. A
 * relevant baseline/candidate/reference drift invalidates reuse even on
 * the cheap path; an absent baseline hashes as a stable sentinel.
 */
export interface TestIntegrityInputs {
  readonly planRevisionId: string;
  readonly planDigest: string;
  readonly baselinePinDigest?: string;
  readonly baselineKind?: string;
  readonly baselineRevision?: string;
  readonly baselineExecuted?: number;
  readonly candidateRevision: string;
}

export function testIntegrityDigest(input: TestIntegrityInputs): string {
  return sha256Hex(canonicalJson({
    planRevisionId: input.planRevisionId,
    planDigest: input.planDigest,
    baselinePinDigest: input.baselinePinDigest ?? "none",
    baselineKind: input.baselineKind ?? "none",
    baselineRevision: input.baselineRevision ?? "none",
    ...(input.baselineExecuted !== undefined ? { baselineExecuted: input.baselineExecuted } : {}),
    candidateRevision: input.candidateRevision,
  }));
}

/**
 * Combines verified per-evidence content digests (see evidence-content.ts:
 * bookkeeping labels, timestamps and proof nonces are already excluded
 * there, so re-running the same check is not novel evidence) into the
 * single evidence dimension of a ReviewKey. Combined over the sorted
 * set of content digests only — evidence ids are bookkeeping, and a
 * repeated check with a fresh id but identical content (even alongside
 * the original id) must not look like new evidence.
 */
export function combineEvidenceContentDigests(digests: Record<string, string>): string {
  return sha256Hex(canonicalJson([...new Set(Object.values(digests))].sort()));
}

/** All ReviewKey dimensions must be exact non-empty values; anything else is a miss. */
export function computeReviewKey(input: ReviewKeyInputs): string {
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`ReviewKey input ${key} is not a concrete value.`);
    }
    if (typeof value === "string" && value.length === 0) {
      throw new Error(`ReviewKey input ${key} is empty; unknown inputs never hit.`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(input.semanticContractDigest)) throw new Error("ReviewKey requires a semantic contract digest.");
  if (!/^[a-f0-9]{64}$/.test(input.diffDigest)) throw new Error("ReviewKey requires a real diff digest.");
  if (!/^[a-f0-9]{64}$/.test(input.diffArtifactHash)) throw new Error("ReviewKey requires the submitted diff artifact hash.");
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(input.baseTree)) throw new Error("ReviewKey requires the actual base Git tree; unknown trees never hit.");
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(input.headTree)) throw new Error("ReviewKey requires the actual head Git tree; unknown trees never hit.");
  if (!/^[a-f0-9]{64}$/.test(input.claimBindingDigest)) throw new Error("ReviewKey requires a claim-binding digest.");
  if (!/^[a-f0-9]{64}$/.test(input.testIntegrityDigest)) throw new Error("ReviewKey requires a test-integrity digest.");
  if (!/^[a-f0-9]{64}$/.test(input.evidenceContentDigest)) throw new Error("ReviewKey requires a verified evidence-content digest.");
  return sha256Hex(canonicalJson([
    input.semanticContractDigest,
    input.baseTree,
    input.headTree,
    input.diffDigest,
    input.diffArtifactHash,
    input.evidenceContentDigest,
    input.claimBindingDigest,
    input.testIntegrityDigest,
    input.tier,
    input.reviewerPolicyVersion,
    input.authorModelIdentity,
    input.policyVersions,
  ]));
}

interface CanonicalRepairFile {
  readonly identity: string;
  readonly reverseIdentity: string;
  readonly status: "modify" | "add" | "delete" | "rename";
  readonly oldMode?: string;
  readonly newMode?: string;
  readonly binary?: boolean;
  /** Sorted content blob pair from the index line; content identity, stable under B->A. */
  readonly indexBlobs?: string;
  readonly removed: readonly string[];
  readonly added: readonly string[];
}

/** Keep Git's quoted representation intact rather than lossy partial unescaping. */
function unquoteDiffPath(raw: string): string {
  return raw;
}

/** Strips one a/ or b/ source prefix from ---/+++/diff --git/Binary paths (rename from/to are already bare). */
function stripPrefixedDiffPath(path: string): string {
  const trimmed = unquoteDiffPath(path);
  if (trimmed === "/dev/null") return "/dev/null";
  if (/^"[ab]\//.test(trimmed)) return `"${trimmed.slice(3)}`;
  return trimmed.replace(/^[ab]\//, "");
}

/** Bare paths (rename from/to): unquoted, never prefix-stripped. */
function bareDiffPath(path: string): string {
  return unquoteDiffPath(path);
}

const TWO_QUOTED_OR_BARE_PATHS = /^("(?:[^"\\]|\\.)*"|\S+)\s+("(?:[^"\\]|\\.)*"|\S+)\s*$/;

function splitTwoPaths(text: string): [string, string] | undefined {
  const match = TWO_QUOTED_OR_BARE_PATHS.exec(text.trim());
  if (match) return [match[1]!, match[2]!];
  // Git leaves spaces unquoted. A mode-only change has no ---/+++
  // headers, so recover only an unambiguous identical path pair.
  // Different/ambiguous paths retain the complete raw section below.
  const candidates: [string, string][] = [];
  for (let offset = text.indexOf(" b/"); offset >= 0; offset = text.indexOf(" b/", offset + 1)) {
    const left = text.slice(0, offset);
    const right = text.slice(offset + 1);
    if (left.startsWith("a/") && left.slice(2) === right.slice(2)) candidates.push([left, right]);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Parses a unified diff into per-file meaningful change sets. File
 * identity (directional paths, add/delete/rename status, modes) and
 * the substantive removed/added line runs are preserved IN ORDER:
 * reordered statements are a different repair. Only position/index
 * metadata is stripped (only binary changes need index blob identity;
 * text content is represented by the ordered edit itself). Hunk offsets/counts, context
 * lines and similarity figures carry no meaning). Sections in an
 * unsupported representation keep a raw-content entry so different
 * unknown bytes never fabricate equality.
 */
function parseRepairFiles(diffText: string): { files: CanonicalRepairFile[]; unparsed: string[] } {
  interface MutableFile {
    gitOld: string; gitNew: string;
    oldPath: string; newPath: string;
    renameFrom: string; renameTo: string;
    binaryOld: string; binaryNew: string;
    binary: boolean; renamed: boolean; newFile: boolean; deletedFile: boolean;
    oldMode?: string; newMode?: string;
    indexBlobs?: string;
    /** True once a hunk header opened the content zone; ---/+++ there are changed lines, not headers. */
    contentZone: boolean;
    removed: string[]; added: string[];
    raw: string[];
    unsupported: boolean;
  }
  const sections: MutableFile[] = [];
  const unparsedSections: string[][] = [];
  let current: MutableFile | undefined;
  let currentRaw: string[] | undefined;
  for (const line of diffText.split(/\r\n?|\n/)) {
    if (line.startsWith("diff --git ")) {
      const paths = splitTwoPaths(line.slice("diff --git ".length));
      current = {
        gitOld: paths ? stripPrefixedDiffPath(paths[0]) : "",
        gitNew: paths ? stripPrefixedDiffPath(paths[1]) : "",
        oldPath: "", newPath: "", renameFrom: "", renameTo: "",
        binaryOld: "", binaryNew: "",
        binary: false, renamed: false, newFile: false, deletedFile: false,
        oldMode: undefined, newMode: undefined, indexBlobs: undefined,
        contentZone: false, removed: [], added: [], raw: [line], unsupported: false,
      };
      sections.push(current);
      currentRaw = undefined;
      continue;
    }
    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      // Combined/merge representation: unsupported, kept raw below.
      current = undefined;
      currentRaw = [];
      unparsedSections.push(currentRaw);
      currentRaw.push(line);
      continue;
    }
    if (currentRaw && !current) {
      currentRaw.push(line);
      continue;
    }
    if (!current) {
      if (line.trim()) unparsedSections.push([line]);
      continue;
    }
    current.raw.push(line);
    if (line.startsWith("copy from ") || line.startsWith("copy to ")) {
      current.unsupported = true;
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.renamed = true;
      current.renameFrom = bareDiffPath(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.renamed = true;
      current.renameTo = bareDiffPath(line.slice("rename to ".length));
      continue;
    }
    if (line.startsWith("old mode ")) {
      current.oldMode = line.slice("old mode ".length).trim();
      continue;
    }
    if (line.startsWith("new mode ")) {
      current.newMode = line.slice("new mode ".length).trim();
      continue;
    }
    if (line.startsWith("new file mode ")) {
      current.newFile = true;
      const mode = line.slice("new file mode ".length).trim();
      if (mode) current.newMode = mode;
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      current.deletedFile = true;
      const mode = line.slice("deleted file mode ".length).trim();
      if (mode) current.oldMode = mode;
      continue;
    }
    if (line.startsWith("similarity index ") || line.startsWith("dissimilarity index ")) continue;
    if (line.startsWith("index ")) {
      // Retained only for binary changes. Text blob IDs also include
      // unchanged context, which must not change a repair fingerprint.
      const match = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: [0-7]+)?\s*$/.exec(line);
      if (match) {
        const pair = [match[1]!, match[2]!].sort();
        current.indexBlobs = `${pair[0]}..${pair[1]}`;
      }
      continue;
    }
    if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      current.binary = true;
      const paths = splitTwoPaths(line.slice("Binary files ".length, -" differ".length));
      if (paths) {
        current.binary = true;
        current.binaryOld = stripPrefixedDiffPath(paths[0]);
        current.binaryNew = stripPrefixedDiffPath(paths[1]);
      }
      continue;
    }
    // GIT binary-patch bodies encode direction-sensitive deltas and can
    // never match their own reversal byte-for-byte; the sorted index
    // blob pair above already binds binary content identity.
    if (line === "GIT binary patch") current.binary = true;
    if (current.binary) continue;
    // File headers precede the first hunk header; inside the content
    // zone a ---/+++ marker is a changed line whose own content begins
    // with --/++, never a second file header.
    if (!current.contentZone && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      if (line.startsWith("--- ") && !current.oldPath) {
        current.oldPath = stripPrefixedDiffPath(line.slice(4));
      } else if (line.startsWith("+++ ") && !current.newPath) {
        current.newPath = stripPrefixedDiffPath(line.slice(4));
      }
      continue;
    }
    if (line.startsWith("@@ ") || line.startsWith("@@@ ") || line.startsWith("\\")) {
      if (line.startsWith("@@")) current.contentZone = true;
      continue;
    }
    if (line.startsWith("+")) {
      current.added.push(line.slice(1));
      continue;
    }
    if (line.startsWith("-")) {
      current.removed.push(line.slice(1));
      continue;
    }
  }
  const files: CanonicalRepairFile[] = [];
  const unparsed: string[] = [];
  for (const section of sections) {
    const oldRef = section.oldPath || section.renameFrom || section.binaryOld || section.gitOld;
    const newRef = section.newPath || section.renameTo || section.binaryNew || section.gitNew;
    if (!oldRef || !newRef || section.unsupported || (section.binary && !section.indexBlobs)) {
      unparsed.push(`unparsed:${sha256Hex(section.raw.join("\n").trimEnd())}`);
      continue;
    }
    const status = section.renamed ? "rename"
      : oldRef === "/dev/null" || section.newFile ? "add"
      : newRef === "/dev/null" || section.deletedFile ? "delete"
      : "modify";
    const identity = status === "delete" ? oldRef : newRef;
    const reverseIdentity = status === "rename" ? oldRef : identity;
    if (!identity || identity === "/dev/null" || !reverseIdentity || reverseIdentity === "/dev/null") continue;
    const substantive = section.removed.length > 0 || section.added.length > 0 ||
      section.binary || section.oldMode !== undefined || section.newMode !== undefined ||
      section.renamed || section.newFile || section.deletedFile;
    if (!substantive) continue;
    files.push({
      identity,
      reverseIdentity,
      status,
      ...(section.oldMode !== undefined ? { oldMode: section.oldMode } : {}),
      ...(section.newMode !== undefined ? { newMode: section.newMode } : {}),
      ...(section.binary ? { binary: true as const } : {}),
      ...(section.binary && section.indexBlobs !== undefined ? { indexBlobs: section.indexBlobs } : {}),
      // Ordered meaningful runs: never sorted, so reordered statements stay distinct.
      removed: [...section.removed],
      added: [...section.added],
    });
  }
  for (const raw of unparsedSections) {
    const text = raw.join("\n").trim();
    if (text) unparsed.push(`unparsed:${sha256Hex(text)}`);
  }
  unparsed.sort();
  files.sort((left, right) => (left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0));
  return { files, unparsed };
}

function renderRepairStatus(status: CanonicalRepairFile["status"], direction: "forward" | "reverse"): string {
  if (direction === "forward") return status;
  if (status === "add") return "delete";
  if (status === "delete") return "add";
  return status;
}

function renderRepairFiles(
  files: readonly CanonicalRepairFile[],
  unparsed: readonly string[],
  direction: "forward" | "reverse",
): string {
  const rendered = files.map((file) => {
    const identity = direction === "forward" ? file.identity : file.reverseIdentity;
    const removed = direction === "forward" ? file.removed : file.added;
    const added = direction === "forward" ? file.added : file.removed;
    const oldMode = direction === "forward" ? file.oldMode : file.newMode;
    const newMode = direction === "forward" ? file.newMode : file.oldMode;
    const header = [`file ${JSON.stringify(identity)} ${renderRepairStatus(file.status, direction)}`];
    if (file.status === "rename") {
      const source = direction === "forward" ? file.reverseIdentity : file.identity;
      header.push(`rename ${JSON.stringify(source)}->${JSON.stringify(identity)}`);
    }
    if (file.binary) header.push("binary");
    if (oldMode !== undefined || newMode !== undefined) header.push(`modes ${oldMode ?? "-"}->${newMode ?? "-"}`);
    if (file.indexBlobs !== undefined) header.push(`index ${file.indexBlobs}`);
    return [...header, ...removed.map((entry) => `-${entry}`), ...added.map((entry) => `+${entry}`)].join("\n");
  });
  // Sorting in the selected direction also makes a multi-file rename's
  // synthetic reverse match the independently ordered actual Git reverse.
  rendered.sort();
  return [...rendered, ...unparsed].join("\n===\n");
}

/** Canonical meaningful repair content: real change plus file identity and direction, without Git positions. */
function canonicalRepairContent(diffText: string, direction: "forward" | "reverse"): string {
  const parsed = parseRepairFiles(diffText);
  return renderRepairFiles(parsed.files, parsed.unparsed, direction);
}

/**
 * Canonical meaningful repair content (forward): CRLF becomes LF,
 * directional file identity/status/modes and ordered substantive runs
 * are preserved, and only position/index metadata and context are
 * excluded. Unrelated repairs never match.
 */
export function normalizeRepairDiff(diffText: string): string {
  return canonicalRepairContent(diffText, "forward");
}

/** Fingerprint of the actual meaningful repair content (forward direction). */
export function repairDiffFingerprint(diffText: string): string {
  return sha256Hex(normalizeRepairDiff(diffText));
}

/**
 * Fingerprint of the exact reverse of a repair diff: removed and added
 * content swap sides (with add/delete direction flipped), so a real
 * `git diff B A` output matches — not a naive line swap that keeps
 * index/blob order and hunk offsets. Only a true content reversal
 * matches, never a fresh label or a partial revert.
 */
export function repairDiffReverseFingerprint(diffText: string): string {
  return sha256Hex(canonicalRepairContent(diffText, "reverse"));
}

/**
 * Returns the failed attempt whose real diff the current repair repeats
 * (exact or reversed), or undefined for an unrelated substantive repair.
 * Matching is by content fingerprint with durable attempt lineage.
 */
export function findOscillatingRepairAttempt(
  forward: string,
  reverse: string,
  failed: readonly FailedRepairDiff[],
): number | undefined {
  if (!forward || !reverse) return undefined;
  for (const entry of failed) {
    if (!entry.forward || !entry.reverse) continue;
    if (entry.forward === forward || entry.reverse === reverse || entry.forward === reverse || entry.reverse === forward) {
      return entry.attempt;
    }
  }
  return undefined;
}

/**
 * A current review record produced by ReviewKey reuse (delivery
 * review_reused) charges no new repair cycle: generation or resubmission
 * alone is not a cycle, and a duplicate failed review reuse consumes no
 * further cycle even across attempts while the exact semantic review
 * identity is unchanged.
 */
export function isDuplicateReviewReuse(review: { readonly reusedFrom?: string } | undefined): boolean {
  return review?.reusedFrom !== undefined;
}
