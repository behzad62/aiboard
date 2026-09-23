import { createHash } from "node:crypto";

/**
 * Run-scoped, immutable identity for an approved source document (or amendment)
 * consumed by evidence-gated planning (P6.6, T1). Original bytes are preserved
 * by digest — this module never rewrites or normalizes source content; it only
 * records identity and a complete, ordered, contiguous section inventory over
 * the bytes as supplied. "Complete" is provable: the manifest records the
 * total artifact byte length, and the section inventory must cover byte 0
 * through that recorded length with no gap, overlap, or uncovered tail.
 */

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function computeArtifactDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Deliberately typed `boolean`, not a `value is T` predicate — see the
 * matching helper and comment in planning-contracts.ts. Used as the first
 * `||` disjunct so a validator never throws on a malformed/`null`/`undefined`
 * input; it only ever returns an issue.
 */
function isObj(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SourceManifestSection {
  /** Stable, unique-within-manifest section identity (e.g. "s1", "section-4"). */
  readonly id: string;
  readonly title?: string;
  /** Inclusive start byte offset into the original artifact bytes. */
  readonly startByte: number;
  /** Exclusive end byte offset into the original artifact bytes. */
  readonly endByte: number;
  /** sha256 hex digest of bytes[startByte:endByte]. */
  readonly digest: string;
}

export interface SourceManifestAmendment {
  /**
   * Stable identity for this amendment itself (e.g. "amend-1"), distinct
   * from `priorManifestId`. Requirement/section dispositions cite this id
   * as their `amendmentRef`; planning-contracts.ts resolves that citation
   * against the manifest's actual amendment chain rather than accepting an
   * arbitrary string.
   */
  readonly id: string;
  /** manifestId of the manifest this amendment supersedes. */
  readonly priorManifestId: string;
  /** artifactDigest of the manifest this amendment supersedes, for drift detection. */
  readonly priorArtifactDigest: string;
  readonly authorizedBy: string;
  readonly rationale: string;
}

export interface ApprovedSourceManifest {
  /** Unique per manifest revision (base source or a specific amendment). */
  readonly manifestId: string;
  /** Stable, run-scoped identity shared across a source's amendment chain. */
  readonly sourceId: string;
  /** sha256 hex digest of the complete original artifact bytes. */
  readonly artifactDigest: string;
  /** Total byte length of the original artifact — proves section coverage is complete. */
  readonly byteLength: number;
  readonly mediaType: string;
  readonly encoding: string;
  /** Ordered, complete, contiguous section inventory covering byte 0..byteLength. */
  readonly sections: readonly SourceManifestSection[];
  /** Present only for a revision that amends a prior approved manifest. */
  readonly amendment?: SourceManifestAmendment;
  /** Who/what approved this manifest (e.g. "owner", "owner:2026-09-22"). */
  readonly authority: string;
  readonly createdAt: string;
}

export type SourceManifestIssueCode =
  | "invalid_manifest"
  | "missing_identity"
  | "invalid_digest"
  | "invalid_byte_length"
  | "invalid_media_type"
  | "invalid_encoding"
  | "no_sections"
  | "invalid_section"
  | "duplicate_section_id"
  | "section_not_contiguous_from_zero"
  | "section_gap"
  | "section_overlap"
  | "section_out_of_order"
  | "section_exceeds_byte_length"
  | "trailing_bytes_uncovered"
  | "invalid_amendment"
  | "invalid_authority"
  | "invalid_timestamp";

export interface SourceManifestIssue {
  readonly code: SourceManifestIssueCode;
  readonly sectionId?: string;
  readonly message: string;
}

export interface SourceManifestValidation {
  readonly valid: boolean;
  readonly issues: readonly SourceManifestIssue[];
}

/**
 * Strict structural + digest validation. Does not require the original bytes:
 * callers that hold the bytes should additionally call
 * `assertManifestMatchesBytes`. A manifest failing this validator can never be
 * treated as coverage-ready by downstream planning contracts. Never throws —
 * a malformed/`null`/`undefined` input yields an issue, not an exception.
 */
export function validateApprovedSourceManifest(
  manifest: ApprovedSourceManifest,
): SourceManifestValidation {
  if (!isObj(manifest)) {
    return { valid: false, issues: [{ code: "invalid_manifest", message: "Source manifest must be an object." }] };
  }

  const issues: SourceManifestIssue[] = [];

  if (!nonEmpty(manifest.manifestId) || !nonEmpty(manifest.sourceId)) {
    issues.push({ code: "missing_identity", message: "Source manifest requires manifestId and sourceId." });
  }
  if (!nonEmpty(manifest.artifactDigest) || !HASH_PATTERN.test(manifest.artifactDigest)) {
    issues.push({ code: "invalid_digest", message: "Source manifest artifactDigest must be a sha256 hex digest." });
  }
  if (!Number.isSafeInteger(manifest.byteLength) || manifest.byteLength < 0) {
    issues.push({ code: "invalid_byte_length", message: "Source manifest requires a non-negative integer byteLength." });
  }
  if (!nonEmpty(manifest.mediaType)) {
    issues.push({ code: "invalid_media_type", message: "Source manifest requires a non-empty mediaType." });
  }
  if (!nonEmpty(manifest.encoding)) {
    issues.push({ code: "invalid_encoding", message: "Source manifest requires a non-empty encoding." });
  }
  if (!nonEmpty(manifest.authority)) {
    issues.push({ code: "invalid_authority", message: "Source manifest requires a non-empty approving authority." });
  }
  if (Number.isNaN(Date.parse(manifest.createdAt))) {
    issues.push({ code: "invalid_timestamp", message: "Source manifest createdAt must be an ISO timestamp." });
  }

  const byteLength = Number.isSafeInteger(manifest.byteLength) && manifest.byteLength >= 0 ? manifest.byteLength : undefined;
  const sections = manifest.sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    issues.push({ code: "no_sections", message: "Source manifest requires a complete, non-empty section inventory." });
  } else {
    const seenIds = new Set<string>();
    const validSections = sections.filter(isObj) as SourceManifestSection[];
    const sorted = [...validSections].sort((a, b) => a.startByte - b.startByte);
    let expectedNext = 0;
    let lastEndByte = 0;
    for (const section of sections) {
      if (
        !isObj(section) ||
        !nonEmpty((section as SourceManifestSection).id) ||
        !Number.isSafeInteger((section as SourceManifestSection).startByte) ||
        !Number.isSafeInteger((section as SourceManifestSection).endByte) ||
        (section as SourceManifestSection).startByte < 0 ||
        (section as SourceManifestSection).endByte <= (section as SourceManifestSection).startByte ||
        !nonEmpty((section as SourceManifestSection).digest) ||
        !HASH_PATTERN.test((section as SourceManifestSection).digest) ||
        (byteLength !== undefined && (section as SourceManifestSection).endByte > byteLength)
      ) {
        const sectionId = isObj(section) && nonEmpty((section as SourceManifestSection).id)
          ? (section as SourceManifestSection).id
          : undefined;
        issues.push({
          code:
            byteLength !== undefined && isObj(section) && Number.isSafeInteger((section as SourceManifestSection).endByte) &&
            (section as SourceManifestSection).endByte > byteLength
              ? "section_exceeds_byte_length"
              : "invalid_section",
          sectionId,
          message: `Section ${sectionId ?? "?"} is malformed (id/byte span/digest), or its endByte exceeds the recorded byteLength.`,
        });
      }
    }
    for (const section of sorted) {
      if (seenIds.has(section.id)) {
        issues.push({
          code: "duplicate_section_id",
          sectionId: section.id,
          message: `Duplicate section id ${section.id}.`,
        });
      }
      seenIds.add(section.id);
      if (section.startByte > expectedNext) {
        issues.push({
          code: "section_gap",
          sectionId: section.id,
          message: `Gap before section ${section.id}: expected byte ${expectedNext}, got ${section.startByte}.`,
        });
      } else if (section.startByte < expectedNext) {
        issues.push({
          code: "section_overlap",
          sectionId: section.id,
          message: `Section ${section.id} overlaps the preceding section.`,
        });
      }
      expectedNext = Math.max(expectedNext, section.endByte);
      lastEndByte = Math.max(lastEndByte, section.endByte);
    }
    if (sorted.length > 0 && sorted[0]!.startByte !== 0) {
      issues.push({
        code: "section_not_contiguous_from_zero",
        sectionId: sorted[0]!.id,
        message: "The section inventory must start at byte 0 to be complete.",
      });
    }
    if (byteLength !== undefined && sorted.length > 0 && lastEndByte !== byteLength) {
      issues.push({
        code: "trailing_bytes_uncovered",
        sectionId: sorted[sorted.length - 1]!.id,
        message: `The section inventory covers only byte 0..${lastEndByte}, not the full recorded artifact length ${byteLength} — a dropped last section or uncovered trailing bytes.`,
      });
    }
    // Ordering in the array as authored must match the sorted (byte) order —
    // an out-of-order inventory is not an ordered inventory, even if the byte
    // spans themselves are contiguous.
    for (let i = 0; i < sections.length; i += 1) {
      if (sections[i] !== sorted[i]) {
        issues.push({
          code: "section_out_of_order",
          message: "Source manifest sections must be listed in byte order.",
        });
        break;
      }
    }
  }

  if (manifest.amendment !== undefined) {
    const amendment = manifest.amendment;
    if (
      !isObj(amendment) ||
      !nonEmpty(amendment.id) ||
      !nonEmpty(amendment.priorManifestId) ||
      !nonEmpty(amendment.priorArtifactDigest) ||
      !HASH_PATTERN.test(amendment.priorArtifactDigest) ||
      !nonEmpty(amendment.authorizedBy) ||
      !nonEmpty(amendment.rationale)
    ) {
      issues.push({
        code: "invalid_amendment",
        message: "Amendment requires id, priorManifestId, priorArtifactDigest, authorizedBy, and rationale.",
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

export function assertApprovedSourceManifest(manifest: ApprovedSourceManifest): void {
  const validation = validateApprovedSourceManifest(manifest);
  if (!validation.valid) {
    throw new Error(validation.issues.map((issue) => issue.message).join(" "));
  }
}

/**
 * Verifies the manifest's recorded identity matches the actual original
 * bytes: the whole-artifact digest, the recorded byteLength against the
 * actual byte count, and every section's digest.
 */
export function assertManifestMatchesBytes(
  manifest: ApprovedSourceManifest,
  bytes: Uint8Array,
): void {
  if (manifest.byteLength !== bytes.length) {
    throw new Error(
      `Source manifest ${manifest.manifestId} byteLength (${manifest.byteLength}) does not match the supplied bytes' actual length (${bytes.length}).`,
    );
  }
  const digest = computeArtifactDigest(bytes);
  if (digest !== manifest.artifactDigest) {
    throw new Error(
      `Source manifest ${manifest.manifestId} artifactDigest does not match the supplied bytes (source drift).`,
    );
  }
  for (const section of manifest.sections) {
    if (section.endByte > bytes.length) {
      throw new Error(
        `Source manifest ${manifest.manifestId} section ${section.id} endByte (${section.endByte}) exceeds the supplied bytes' length (${bytes.length}).`,
      );
    }
    const slice = bytes.subarray(section.startByte, section.endByte);
    const sectionDigest = computeArtifactDigest(slice);
    if (sectionDigest !== section.digest) {
      throw new Error(
        `Source manifest ${manifest.manifestId} section ${section.id} digest does not match the supplied bytes.`,
      );
    }
  }
}

export interface SourceManifestSectionInput {
  readonly id: string;
  readonly title?: string;
  readonly startByte: number;
  readonly endByte: number;
}

/**
 * Builds a manifest from original bytes plus a caller-supplied byte-span
 * section layout. Bytes are never rewritten; digests and byteLength are
 * derived from the actual bytes, never chosen by the caller.
 */
export function buildSourceManifest(
  bytes: Uint8Array,
  sections: readonly SourceManifestSectionInput[],
  meta: {
    readonly manifestId: string;
    readonly sourceId: string;
    readonly mediaType: string;
    readonly encoding: string;
    readonly authority: string;
    readonly createdAt: string;
    readonly amendment?: SourceManifestAmendment;
  },
): ApprovedSourceManifest {
  const artifactDigest = computeArtifactDigest(bytes);
  const builtSections: SourceManifestSection[] = sections.map((section) => ({
    id: section.id,
    ...(section.title !== undefined ? { title: section.title } : {}),
    startByte: section.startByte,
    endByte: section.endByte,
    digest: computeArtifactDigest(bytes.subarray(section.startByte, section.endByte)),
  }));
  const manifest: ApprovedSourceManifest = {
    manifestId: meta.manifestId,
    sourceId: meta.sourceId,
    artifactDigest,
    byteLength: bytes.length,
    mediaType: meta.mediaType,
    encoding: meta.encoding,
    sections: builtSections,
    ...(meta.amendment ? { amendment: meta.amendment } : {}),
    authority: meta.authority,
    createdAt: meta.createdAt,
  };
  assertApprovedSourceManifest(manifest);
  return manifest;
}

/**
 * Verifies an amendment manifest's amendment block actually references the
 * prior approved manifest it claims to amend (identity + digest match), so
 * an amendment chain cannot silently point at the wrong predecessor or claim
 * authority over a manifest whose bytes have since drifted.
 */
export function verifyAmendmentReferencesPredecessor(
  candidate: ApprovedSourceManifest,
  prior: ApprovedSourceManifest,
): void {
  if (!candidate.amendment) {
    throw new Error(`Manifest ${candidate.manifestId} is not an amendment.`);
  }
  if (candidate.sourceId !== prior.sourceId) {
    throw new Error(
      `Amendment ${candidate.manifestId} sourceId does not match predecessor ${prior.manifestId}.`,
    );
  }
  if (candidate.amendment.priorManifestId !== prior.manifestId) {
    throw new Error(
      `Amendment ${candidate.manifestId} does not reference predecessor ${prior.manifestId} (references ${candidate.amendment.priorManifestId}).`,
    );
  }
  if (candidate.amendment.priorArtifactDigest !== prior.artifactDigest) {
    throw new Error(
      `Amendment ${candidate.manifestId} priorArtifactDigest does not match predecessor ${prior.manifestId}'s actual digest (source drift).`,
    );
  }
}

/** True when the manifest's recorded digest matches a freshly computed digest. */
export function sourceManifestDigestMatches(
  manifest: ApprovedSourceManifest,
  currentDigest: string,
): boolean {
  return manifest.artifactDigest === currentDigest;
}

export function sourceManifestSectionIds(manifest: ApprovedSourceManifest): readonly string[] {
  if (!isObj(manifest) || !Array.isArray(manifest.sections)) return [];
  return manifest.sections.filter(isObj).map((section) => section.id);
}

/**
 * True when `amendmentRef` resolves against this manifest's own amendment
 * chain. T1's contracts validate one manifest snapshot at a time (no
 * persistent multi-manifest history — that is T2's store), so "the chain"
 * here is this manifest's own recorded `amendment.id`, if it has one. A
 * manifest with no `amendment` at all cannot resolve ANY amendmentRef —
 * an arbitrary string can never pass merely by being non-empty.
 */
export function manifestResolvesAmendmentRef(
  manifest: ApprovedSourceManifest,
  amendmentRef: string,
): boolean {
  return manifest.amendment?.id === amendmentRef;
}
