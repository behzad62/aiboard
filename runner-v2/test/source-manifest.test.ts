import assert from "node:assert/strict";
import test from "node:test";

import {
  assertApprovedSourceManifest,
  assertManifestMatchesBytes,
  buildSourceManifest,
  computeArtifactDigest,
  sourceManifestDigestMatches,
  sourceManifestSectionIds,
  validateApprovedSourceManifest,
  verifyAmendmentReferencesPredecessor,
  type ApprovedSourceManifest,
} from "../src/source-manifest.js";

const TEXT = "SECTION ONE.\nSECTION TWO.\nSECTION THREE.\n";
const BYTES = Buffer.from(TEXT, "utf-8");

function threeSections() {
  const lines = TEXT.split("\n");
  const s1 = Buffer.from(lines[0] + "\n", "utf-8").length;
  const s2 = Buffer.from(lines[1] + "\n", "utf-8").length;
  const s3 = Buffer.from(lines[2] + "\n", "utf-8").length;
  return [
    { id: "s1", startByte: 0, endByte: s1 },
    { id: "s2", startByte: s1, endByte: s1 + s2 },
    { id: "s3", startByte: s1 + s2, endByte: s1 + s2 + s3 },
  ];
}

function buildBase(): ApprovedSourceManifest {
  return buildSourceManifest(BYTES, threeSections(), {
    manifestId: "manifest_base",
    sourceId: "source_x",
    mediaType: "text/plain",
    encoding: "utf-8",
    authority: "owner",
    createdAt: "2026-09-08T00:00:00.000Z",
  });
}

test("buildSourceManifest computes real digests from the original bytes and round-trips through validation", () => {
  const manifest = buildBase();
  assert.equal(manifest.artifactDigest, computeArtifactDigest(BYTES));
  assert.equal(manifest.sections.length, 3);
  assert.deepEqual(sourceManifestSectionIds(manifest), ["s1", "s2", "s3"]);
  assert.doesNotThrow(() => assertApprovedSourceManifest(manifest));
  assert.doesNotThrow(() => assertManifestMatchesBytes(manifest, BYTES));
});

test("a complete, ordered, contiguous section inventory is required — gaps, overlaps, and out-of-order sections are rejected", () => {
  const manifest = buildBase();

  const withGap: ApprovedSourceManifest = {
    ...manifest,
    sections: [manifest.sections[0]!, manifest.sections[2]!], // drops s2 — a dropped source section
  };
  const gapResult = validateApprovedSourceManifest(withGap);
  assert.equal(gapResult.valid, false);
  assert.ok(gapResult.issues.some((issue) => issue.code === "section_gap"));

  const overlapping: ApprovedSourceManifest = {
    ...manifest,
    sections: [
      manifest.sections[0]!,
      { ...manifest.sections[1]!, startByte: manifest.sections[0]!.startByte },
      manifest.sections[2]!,
    ],
  };
  const overlapResult = validateApprovedSourceManifest(overlapping);
  assert.equal(overlapResult.valid, false);
  assert.ok(overlapResult.issues.some((issue) => issue.code === "section_overlap"));

  const outOfOrder: ApprovedSourceManifest = {
    ...manifest,
    sections: [manifest.sections[1]!, manifest.sections[0]!, manifest.sections[2]!],
  };
  const orderResult = validateApprovedSourceManifest(outOfOrder);
  assert.equal(orderResult.valid, false);
  assert.ok(orderResult.issues.some((issue) => issue.code === "section_out_of_order"));

  const duplicateId: ApprovedSourceManifest = {
    ...manifest,
    sections: [manifest.sections[0]!, { ...manifest.sections[1]!, id: "s1" }, manifest.sections[2]!],
  };
  assert.ok(
    validateApprovedSourceManifest(duplicateId).issues.some((issue) => issue.code === "duplicate_section_id"),
  );

  const notFromZero: ApprovedSourceManifest = {
    ...manifest,
    sections: manifest.sections.map((section) => ({ ...section, startByte: section.startByte + 5, endByte: section.endByte + 5 })),
  };
  assert.ok(
    validateApprovedSourceManifest(notFromZero).issues.some((issue) =>
      ["section_not_contiguous_from_zero", "section_gap"].includes(issue.code)),
  );
});

test("assertManifestMatchesBytes rejects a source digest that no longer matches the actual bytes", () => {
  const manifest = buildBase();
  const driftedBytes = Buffer.from(TEXT.replace("THREE", "FOUR"), "utf-8");
  assert.throws(() => assertManifestMatchesBytes(manifest, driftedBytes), /does not match/);
  assert.equal(sourceManifestDigestMatches(manifest, computeArtifactDigest(driftedBytes)), false);
  assert.equal(sourceManifestDigestMatches(manifest, computeArtifactDigest(BYTES)), true);
});

test("an amendment must reference its actual predecessor manifest and digest, not merely claim to", () => {
  const prior = buildBase();
  const amendedText = TEXT + "SECTION FOUR.\n";
  const amendedBytes = Buffer.from(amendedText, "utf-8");
  const amendedSections = [
    ...threeSections(),
    { id: "s4", startByte: BYTES.length, endByte: amendedBytes.length },
  ];
  const amendment = buildSourceManifest(amendedBytes, amendedSections, {
    manifestId: "manifest_amend_1",
    sourceId: "source_x",
    mediaType: "text/plain",
    encoding: "utf-8",
    authority: "owner",
    createdAt: "2026-09-22T00:00:00.000Z",
    amendment: {
      id: "amend-1",
      priorManifestId: prior.manifestId,
      priorArtifactDigest: prior.artifactDigest,
      authorizedBy: "owner",
      rationale: "Add section four.",
    },
  });
  assert.doesNotThrow(() => verifyAmendmentReferencesPredecessor(amendment, prior));

  const wrongPredecessorId: ApprovedSourceManifest = {
    ...amendment,
    amendment: { ...amendment.amendment!, priorManifestId: "manifest_other" },
  };
  assert.throws(() => verifyAmendmentReferencesPredecessor(wrongPredecessorId, prior), /does not reference predecessor/);

  const wrongPredecessorDigest: ApprovedSourceManifest = {
    ...amendment,
    amendment: { ...amendment.amendment!, priorArtifactDigest: "a".repeat(64) },
  };
  assert.throws(() => verifyAmendmentReferencesPredecessor(wrongPredecessorDigest, prior), /source drift/);

  const notAnAmendment: ApprovedSourceManifest = { ...amendment, amendment: undefined };
  assert.throws(() => verifyAmendmentReferencesPredecessor(notAnAmendment, prior), /is not an amendment/);
});

test("missing identity, digest, media type, encoding, authority, and timestamp are each rejected", () => {
  const manifest = buildBase();
  assert.ok(validateApprovedSourceManifest({ ...manifest, manifestId: "" }).issues.some((i) => i.code === "missing_identity"));
  assert.ok(validateApprovedSourceManifest({ ...manifest, artifactDigest: "not-a-digest" }).issues.some((i) => i.code === "invalid_digest"));
  assert.ok(validateApprovedSourceManifest({ ...manifest, mediaType: "" }).issues.some((i) => i.code === "invalid_media_type"));
  assert.ok(validateApprovedSourceManifest({ ...manifest, encoding: "" }).issues.some((i) => i.code === "invalid_encoding"));
  assert.ok(validateApprovedSourceManifest({ ...manifest, authority: "" }).issues.some((i) => i.code === "invalid_authority"));
  assert.ok(validateApprovedSourceManifest({ ...manifest, createdAt: "not-a-date" }).issues.some((i) => i.code === "invalid_timestamp"));
  assert.ok(validateApprovedSourceManifest({ ...manifest, sections: [] }).issues.some((i) => i.code === "no_sections"));
});
