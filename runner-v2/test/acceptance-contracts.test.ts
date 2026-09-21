import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAcceptanceCriteria,
  assertSatisfiedVerdictsCiteGreenEvidence,
  failingCommandEvidenceIds,
  validateCriterionEvidenceLinks,
  validateCriterionReviewVerdicts,
  type AcceptanceCriterion,
  type CriterionEvidenceLink,
  type CriterionReviewVerdict,
} from "../src/acceptance-contracts.js";
import type { EvidenceRecord } from "../src/evidence-store.js";
import { commandEvidence } from "./support/evidence-fixtures.js";

const criteria: AcceptanceCriterion[] = [
  { id: "behavior", text: "The requested behavior works." },
  { id: "regression", text: "The regression check remains green." },
];

test("acceptance criteria require non-empty stable unique IDs and text", () => {
  assert.doesNotThrow(() => assertAcceptanceCriteria(criteria));
  assert.throws(
    () => assertAcceptanceCriteria([{ id: "behavior", text: "" }]),
    /non-empty/i
  );
  assert.throws(
    () => assertAcceptanceCriteria([
      { id: "duplicate", text: "one" },
      { id: "duplicate", text: "two" },
    ]),
    /duplicate.*criterion.*duplicate/i
  );
});

test("evidence links require exact criterion coverage and reject artifact-only links", () => {
  const complete: CriterionEvidenceLink[] = [
    {
      criterionId: "behavior",
      evidenceId: "evidence_behavior",
      artifactHashes: ["a".repeat(64)],
    },
    {
      criterionId: "regression",
      evidenceId: "evidence_regression",
      artifactHashes: ["b".repeat(64)],
    },
  ];
  assert.equal(validateCriterionEvidenceLinks(criteria, complete).valid, true);
  assert.match(
    validateCriterionEvidenceLinks(criteria, complete.slice(0, 1)).issues.join("\n"),
    /missing.*regression/i
  );
  assert.match(
    validateCriterionEvidenceLinks(criteria, [
      ...complete,
      { ...complete[0] },
    ]).issues.join("\n"),
    /duplicate.*behavior/i
  );
  assert.match(
    validateCriterionEvidenceLinks(criteria, [
      complete[0],
      complete[1],
      {
        criterionId: "unknown",
        evidenceId: "evidence_unknown",
        artifactHashes: ["c".repeat(64)],
      },
    ]).issues.join("\n"),
    /unknown.*criterion/i
  );
  assert.match(
    validateCriterionEvidenceLinks(criteria, [
      {
        criterionId: "behavior",
        evidenceId: "missing_record",
        artifactHashes: ["a".repeat(64)],
      },
      complete[1],
    ], {
      evidenceRecords: [],
    }).issues.join("\n"),
    /evidence.*record.*missing/i
  );
});

test("Architect review verdicts require exact coverage and evaluate every criterion", () => {
  const links: CriterionEvidenceLink[] = [
    { criterionId: "behavior", evidenceId: "evidence_behavior", artifactHashes: ["a".repeat(64)] },
    { criterionId: "regression", evidenceId: "evidence_regression", artifactHashes: ["b".repeat(64)] },
  ];
  const verdicts: CriterionReviewVerdict[] = [
    {
      criterionId: "behavior",
      verdict: "satisfied",
      rationale: "The command fact demonstrates the behavior.",
      evidenceIds: ["evidence_behavior"],
    },
    {
      criterionId: "regression",
      verdict: "unsatisfied",
      rationale: "The regression fact has a failing exit code.",
      evidenceIds: ["evidence_regression"],
    },
  ];
  const rejection = validateCriterionReviewVerdicts(criteria, verdicts, links);
  assert.equal(rejection.valid, true);
  assert.deepEqual(rejection.unsatisfiedCriterionIds, ["regression"]);
  assert.match(
    validateCriterionReviewVerdicts(criteria, verdicts.slice(0, 1), links).issues.join("\n"),
    /missing.*regression/i
  );
  assert.match(
    validateCriterionReviewVerdicts(criteria, [
      ...verdicts,
      { ...verdicts[0] },
    ], links).issues.join("\n"),
    /duplicate.*behavior/i
  );
  assert.match(
    validateCriterionReviewVerdicts(criteria, [
      {
        ...verdicts[0],
        evidenceIds: [],
      },
      verdicts[1],
    ], links).issues.join("\n"),
    /evidence/i
  );
});

test("failingCommandEvidenceIds flags non-zero exit, signal, timeout, and cancellation only", () => {
  const records: EvidenceRecord[] = [
    commandEvidence("green"),
    commandEvidence("exit1", { exitCode: 1 }),
    commandEvidence("killed", { exitCode: null, signal: "SIGKILL" }),
    commandEvidence("slow", { timedOut: true }),
    commandEvidence("stopped", { cancelled: true }),
    {
      ...commandEvidence("shot"),
      fact: {
        kind: "browser_screenshot",
        label: "ui",
        capturedAt: "2026-09-02T00:00:00.000Z",
        screenshotArtifactHash: "c".repeat(64),
        mediaType: "image/png",
        byteLength: 16,
      },
    },
  ];
  assert.deepEqual(failingCommandEvidenceIds(records), ["exit1", "killed", "slow", "stopped"]);
});

test("a satisfied verdict may cite failing command evidence only with an explicit accepted failure", () => {
  const records = [commandEvidence("green"), commandEvidence("red", { exitCode: 1 })];
  assert.throws(
    () => assertSatisfiedVerdictsCiteGreenEvidence(
      [{ verdict: "satisfied", evidenceIds: ["red"] }],
      records,
      "Review decision",
    ),
    /Review decision cites failing command evidence red for a satisfied verdict/,
  );
  assert.doesNotThrow(() => assertSatisfiedVerdictsCiteGreenEvidence(
    [{
      verdict: "satisfied",
      evidenceIds: ["red"],
      acceptedFailures: [{ evidenceId: "red", rationale: "RED phase of the TDD cycle before the fix." }],
    }],
    records,
    "Review decision",
  ));
  assert.doesNotThrow(() => assertSatisfiedVerdictsCiteGreenEvidence(
    [{ verdict: "unsatisfied", evidenceIds: ["red"] }],
    records,
    "Review decision",
  ));
  assert.throws(
    () => assertSatisfiedVerdictsCiteGreenEvidence(
      [{
        verdict: "satisfied",
        evidenceIds: ["green"],
        acceptedFailures: [{ evidenceId: "green", rationale: "not actually failing" }],
      }],
      records,
      "Review decision",
    ),
    /accepted failure green is not failing command evidence cited by that verdict/,
  );
});

test("review verdict acceptedFailures must be unique non-empty evidenceId/rationale pairs", () => {
  const links: CriterionEvidenceLink[] = [
    { criterionId: "behavior", evidenceId: "evidence_behavior", artifactHashes: ["a".repeat(64)] },
    { criterionId: "regression", evidenceId: "evidence_regression", artifactHashes: ["b".repeat(64)] },
  ];
  const verdicts: CriterionReviewVerdict[] = [
    {
      criterionId: "behavior",
      verdict: "satisfied",
      rationale: "The command fact demonstrates the behavior.",
      evidenceIds: ["evidence_behavior"],
      acceptedFailures: [{ evidenceId: "evidence_behavior", rationale: "   " }],
    },
    {
      criterionId: "regression",
      verdict: "unsatisfied",
      rationale: "The regression fact has a failing exit code.",
      evidenceIds: ["evidence_regression"],
    },
  ];
  assert.match(
    validateCriterionReviewVerdicts(criteria, verdicts, links).issues.join("\n"),
    /criterion behavior acceptedFailures is malformed/,
  );
});
