import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  applyLateFindingRule,
  deltaFilesWithoutPriorFindings,
  findingNamesPath,
  invalidatedEvidenceIds,
  isOverCorrection,
  normalizeModelPath,
  parseConcreteLocation,
  parseDiffHunks,
  parseShownLines,
  type LateFindingRuleContext,
} from "../src/review-delta.js";
import { validateDeliveryFindings, validateReviewDelta } from "../src/delivery-acceptance.js";
import type { PlanningFinding } from "../src/planning-contracts.js";
import { NativeDeliverableReviewRuntime, deliveryReviewerSystemPrompt } from "../src/native-deliverable-review.js";
import type { ContextSection } from "../src/context-assembler.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createFilesystemTools } from "../src/filesystem-tools.js";
import { captureReviewReads } from "../src/review-evidence.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";

// W2 delta-first re-review and bounded late findings. Pure mechanics plus
// genuine Git fixtures: no seeded authority, no source-string assertions.

function repository(t: TestContext, label: string) {
  const cwd = mkdtempSync(join(tmpdir(), `w2-${label}-`));
  // Windows can hold a freshly-shelled git handle past process exit; retry
  // the scratch removal instead of failing the test on a transient lock.
  t.after(() => {
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(cwd, { recursive: true, force: true });
        return;
      } catch (error) {
        if (attempt >= 5) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
  });
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "--initial-branch=main");
  git("config", "user.name", "W2 Delta");
  git("config", "user.email", "w2-delta@example.invalid");
  git("config", "core.autocrlf", "false");
  git("config", "core.quotePath", "true");
  return {
    cwd,
    git,
    write: (p: string, s: string | Buffer) => {
      mkdirSync(join(cwd, dirname(p)), { recursive: true });
      writeFileSync(join(cwd, p), s);
    },
  };
}

function finding(
  id: string,
  location: string | undefined,
  extra: Partial<PlanningFinding> = {},
): PlanningFinding {
  return {
    id,
    category: "missing_coverage",
    severity: "blocking",
    ...(location === undefined ? {} : { location }),
    claim: `claim for ${id}`,
    evidenceRefs: [],
    ...extra,
  };
}

function ruleContext(overrides: Partial<LateFindingRuleContext> = {}): LateFindingRuleContext {
  return {
    isReReview: true,
    deltaFiles: [],
    priorReviewedFiles: [],
    deltaHunks: {},
    priorShownLines: {},
    priorReadRanges: [],
    failingTestIds: undefined,
    depthFailed: false,
    depthReportArtifactHash: undefined,
    ...overrides,
  };
}

function hunkRecord(hunks: Map<string, { oldStart: number; oldCount: number; newStart: number; newCount: number }[]>) {
  return Object.fromEntries(hunks);
}

function shownRecord(shown: Map<string, number[]>) {
  return Object.fromEntries(shown);
}

test("W2 strict locations bind exact Git path identity only", () => {
  assert.deepEqual(parseConcreteLocation("src/a.ts"), { path: "src/a.ts" });
  assert.deepEqual(parseConcreteLocation("  src/a.ts:12  "), { path: "src/a.ts", line: 12 });
  assert.deepEqual(parseConcreteLocation("./src/a.ts"), { path: "src/a.ts" });
  // No a/ or b/ prefix stripping: real directories keep their identity.
  assert.deepEqual(parseConcreteLocation("b/y.ts"), { path: "b/y.ts" });
  assert.deepEqual(parseConcreteLocation("a/y.ts"), { path: "a/y.ts" });
  // Ambiguous forms are unknown, never guessed.
  assert.equal(parseConcreteLocation(undefined), undefined);
  assert.equal(parseConcreteLocation(""), undefined);
  assert.equal(parseConcreteLocation("/dev/null"), undefined);
  assert.equal(parseConcreteLocation("old.ts -> new.ts"), undefined);
  assert.equal(parseConcreteLocation("a->b"), undefined);
  assert.equal(parseConcreteLocation('"quoted/x.ts"'), undefined);
  assert.equal(parseConcreteLocation("back\\slash.ts"), undefined);
  assert.equal(parseConcreteLocation("src/a.ts:12:3"), undefined);
  assert.equal(parseConcreteLocation("src/a.ts:0"), undefined);
});

test("W2 finding names are strict: no collapse across real directories", () => {
  assert.equal(findingNamesPath("src/a.ts", "src/a.ts"), true);
  assert.equal(findingNamesPath("src/a.ts:5", "src/a.ts"), true);
  assert.equal(findingNamesPath("./src/a.ts", "src/a.ts"), true);
  assert.equal(findingNamesPath("b/y.ts", "y.ts"), false);
  assert.equal(findingNamesPath("a/y.ts", "y.ts"), false);
  assert.equal(findingNamesPath("y.ts", "b/y.ts"), false);
  assert.equal(findingNamesPath("old.ts -> new.ts", "new.ts"), false);
  assert.equal(findingNamesPath(undefined, "src/a.ts"), false);
});

test("W2 delta files without prior findings and over-correction signal", () => {
  const split = deltaFilesWithoutPriorFindings(
    ["src/a.ts", "src/b.ts"],
    [finding("f1", "src/a.ts:3")],
  );
  assert.deepEqual(split.named, ["src/a.ts"]);
  assert.deepEqual(split.unnamed, ["src/b.ts"]);
  assert.equal(isOverCorrection(split), true);
  assert.equal(isOverCorrection(deltaFilesWithoutPriorFindings(["src/a.ts"], [finding("f1", "src/a.ts")])), false);
  // An unknown prior location proves no review: the file counts as unnamed
  // (more reviewer context, the safe direction).
  const unknown = deltaFilesWithoutPriorFindings(["src/a.ts"], [finding("f1", "old -> new")]);
  assert.deepEqual(unknown.unnamed, ["src/a.ts"]);
});

test("W2 invalidated evidence follows tree identity only", () => {
  const treeA = "a".repeat(40);
  const treeB = "b".repeat(40);
  assert.deepEqual(invalidatedEvidenceIds(["e1", "e2"], treeA, treeA), []);
  assert.deepEqual(invalidatedEvidenceIds(["e1", "e2"], treeA, treeB), ["e1", "e2"]);
  assert.deepEqual(invalidatedEvidenceIds(["e1"], undefined, treeA), ["e1"]);
  assert.deepEqual(invalidatedEvidenceIds(["e1"], treeA, undefined), ["e1"]);
  assert.deepEqual(invalidatedEvidenceIds([], treeA, treeB), []);
});

test("W2 late rule: initial reviews and unknown facts stay blocking", () => {
  const late = finding("late", "src/a.ts");
  // Initial reviews never demote.
  assert.deepEqual(
    applyLateFindingRule([late], ruleContext({ isReReview: false, deltaFiles: ["src/b.ts"], priorReviewedFiles: ["src/a.ts"] })).followUp,
    [],
  );
  // Unknown delta, unknown surface, or unknown prior surface: blocking.
  assert.deepEqual(applyLateFindingRule([late], ruleContext({ deltaFiles: undefined })).followUp, []);
  assert.deepEqual(
    applyLateFindingRule([late], ruleContext({ deltaFiles: ["src/b.ts"], priorReviewedFiles: undefined })).followUp,
    [],
  );
  assert.deepEqual(
    applyLateFindingRule([finding("u", undefined)], ruleContext({ deltaFiles: [], priorReviewedFiles: ["src/a.ts"] })).followUp,
    [],
  );
  assert.deepEqual(
    applyLateFindingRule([finding("u2", "old -> new")], ruleContext({ deltaFiles: [], priorReviewedFiles: ["src/a.ts"] })).followUp,
    [],
  );
});

test("W2 late rule: unchanged reviewed demotes, never-reviewed stays blocking", () => {
  const reviewed = finding("reviewed", "src/a.ts");
  const neverReviewed = finding("fresh", "src/c.ts:1");
  const outcome = applyLateFindingRule(
    [reviewed, neverReviewed],
    ruleContext({ deltaFiles: ["src/b.ts"], priorReviewedFiles: ["src/a.ts", "src/b.ts"] }),
  );
  assert.deepEqual(outcome.followUp.map((item) => item.id), ["reviewed"]);
  assert.deepEqual(outcome.retained.map((item) => item.id), ["fresh"]);
});

test("W2 late rule: line findings need verified line coverage, not filenames", () => {
  const line = finding("line", "src/a.ts:4");
  const covered = ruleContext({
    deltaFiles: ["src/b.ts"],
    priorReviewedFiles: ["src/a.ts", "src/b.ts"],
    priorShownLines: { "src/a.ts": [1, 2, 3, 4, 5] },
  });
  assert.deepEqual(applyLateFindingRule([line], covered).followUp.map((item) => item.id), ["line"]);
  // Same file, same line, but no verified line coverage: blocking.
  const uncovered = ruleContext({
    deltaFiles: ["src/b.ts"],
    priorReviewedFiles: ["src/a.ts", "src/b.ts"],
    priorShownLines: { "src/a.ts": [1, 2] },
  });
  assert.deepEqual(applyLateFindingRule([line], uncovered).retained.map((item) => item.id), ["line"]);
  // An authentic read range covering the exact line authorizes it.
  const ranged = ruleContext({
    deltaFiles: ["src/b.ts"],
    priorReviewedFiles: ["src/b.ts"],
    priorReadRanges: [{ path: "src/a.ts", startLine: 4, endLine: 4 }],
  });
  assert.deepEqual(applyLateFindingRule([line], ranged).followUp.map((item) => item.id), ["line"]);
  // The same range does not authorize a different line.
  const elsewhere = finding("elsewhere", "src/a.ts:50");
  assert.deepEqual(applyLateFindingRule([elsewhere], ranged).retained.map((item) => item.id), ["elsewhere"]);
});

test("W2 late rule: critical and failing-test exceptions", () => {
  const critical = finding("crit", "src/a.ts:2", {
    lateFinding: { basis: "critical", criticalKind: "security", rationale: "Unsanitized shell interpolation." },
  });
  const blankCritical = finding("blank", "src/a.ts:2", {
    lateFinding: { basis: "critical", criticalKind: "data_loss", rationale: "   " },
  });
  const proven = finding("proven", "src/a.ts:2", {
    lateFinding: { basis: "failing_test", testIds: ["t1"], rationale: "Runner check t1 fails." },
  });
  const forged = finding("forged", "src/a.ts:2", {
    lateFinding: { basis: "failing_test", testIds: ["invented"], rationale: "Model claims a failure." },
  });
  const foreign = finding("foreign", "src/a.ts:2", {
    lateFinding: { basis: "failing_test", testIds: ["other-run-test"], rationale: "A different run failed." },
  });
  const base = ruleContext({
    deltaFiles: ["src/b.ts"],
    priorReviewedFiles: ["src/a.ts"],
    priorShownLines: { "src/a.ts": [1, 2, 3] },
  });
  const failing = ruleContext({
    deltaFiles: ["src/b.ts"],
    priorReviewedFiles: ["src/a.ts"],
    priorShownLines: { "src/a.ts": [1, 2, 3] },
    failingTestIds: ["t1"],
    depthFailed: true,
    depthReportArtifactHash: "f".repeat(64),
  });
  // An explicit critical rationale keeps the finding blocking.
  assert.deepEqual(applyLateFindingRule([critical], base).retained.map((item) => item.id), ["crit"]);
  // A blank rationale authorizes nothing.
  assert.deepEqual(applyLateFindingRule([blankCritical], base).followUp.map((item) => item.id), ["blank"]);
  // Only this review's own FAILED report authorizes the failing-test basis.
  assert.deepEqual(applyLateFindingRule([proven], failing).retained.map((item) => item.id), ["proven"]);
  assert.deepEqual(applyLateFindingRule([proven], base).followUp.map((item) => item.id), ["proven"]);
  assert.deepEqual(applyLateFindingRule([forged], failing).followUp.map((item) => item.id), ["forged"]);
  assert.deepEqual(applyLateFindingRule([foreign], failing).followUp.map((item) => item.id), ["foreign"]);
  // A passing report with the same ids authorizes nothing.
  const passing = ruleContext({
    deltaFiles: ["src/b.ts"],
    priorReviewedFiles: ["src/a.ts"],
    priorShownLines: { "src/a.ts": [1, 2, 3] },
    failingTestIds: [],
    depthFailed: false,
    depthReportArtifactHash: "f".repeat(64),
  });
  assert.deepEqual(applyLateFindingRule([proven], passing).followUp.map((item) => item.id), ["proven"]);
  // Stored report bytes are required: ids without a content hash mint nothing.
  const hashless = ruleContext({
    deltaFiles: ["src/b.ts"],
    priorReviewedFiles: ["src/a.ts"],
    priorShownLines: { "src/a.ts": [1, 2, 3] },
    failingTestIds: ["t1"],
    depthFailed: true,
    depthReportArtifactHash: undefined,
  });
  assert.deepEqual(applyLateFindingRule([proven], hashless).followUp.map((item) => item.id), ["proven"]);
});

test("W2 late rule: reserved findings and advisory never demote", () => {
  const facts = [
    finding("submission-scope:s1", "cs1"),
    finding("submission-encoding:e1", "cs1"),
    finding("mutation-survivor:0", "src/a.ts:1"),
    finding("repair-oscillation:1", "cs1"),
    finding("carried:old", "src/a.ts"),
  ];
  const outcome = applyLateFindingRule(facts, ruleContext({ deltaFiles: [], priorReviewedFiles: [] }));
  assert.deepEqual(outcome.followUp, []);
  assert.equal(outcome.retained.length, 5);
  const advisory = finding("note", "src/a.ts", { severity: "advisory" });
  const advisoryOutcome = applyLateFindingRule([advisory], ruleContext({ deltaFiles: [], priorReviewedFiles: [] }));
  assert.deepEqual(advisoryOutcome.retained.map((item) => item.id), ["note"]);
});

test("W2 actual Git same-file distinct hunks: only proven-unchanged lines demote", (t) => {
  const r = repository(t, "hunks");
  const numbered = Array.from({ length: 20 }, (_, index) => `line${index + 1}\n`).join("");
  r.write("fix.ts", numbered);
  r.write("other.ts", "other1\nother2\n");
  r.git("add", ".");
  r.git("commit", "-m", "base");
  const base = r.git("rev-parse", "HEAD").trim();
  // Prior repair: hunk A in fix.ts plus other.ts.
  r.write("fix.ts", numbered.replace("line3\n", "line3-prior\n").replace("line4\n", "line4-prior\n"));
  r.write("other.ts", "other1-prior\nother2\n");
  r.git("add", ".");
  r.git("commit", "-m", "prior");
  const prior = r.git("rev-parse", "HEAD").trim();
  // Current correction: hunk B elsewhere in the same file; other.ts untouched.
  r.write("fix.ts", numbered.replace("line3\n", "line3-prior\n").replace("line4\n", "line4-prior\n").replace("line15\n", "line15-now\n").replace("line16\n", "line16-now\n"));
  r.git("add", ".");
  r.git("commit", "-m", "current");
  const current = r.git("rev-parse", "HEAD").trim();
  // Actual verified bytes in both directions: never a synthesized inverse.
  const fixText = r.git("diff", prior, current, "--");
  assert.match(fixText, /^diff --git /m);
  const nulFiles = r.git("diff", "-z", "--name-only", prior, current, "--").split("\0").filter(Boolean);
  assert.deepEqual(nulFiles, ["fix.ts"]);
  const hunks = parseDiffHunks(fixText);
  assert.equal(hunks.get("fix.ts")?.length, 1, "one verified correction hunk");
  const priorText = r.git("diff", base, prior, "--");
  const context = ruleContext({
    deltaFiles: nulFiles,
    priorReviewedFiles: r.git("diff", "-z", "--name-only", base, prior, "--").split("\0").filter(Boolean).sort(),
    deltaHunks: hunkRecord(hunks),
    priorShownLines: shownRecord(parseShownLines(priorText)),
    priorReadRanges: [],
  });
  assert.deepEqual(context.priorReviewedFiles, ["fix.ts", "other.ts"]);
  assert.ok((context.priorShownLines?.["fix.ts"] ?? []).includes(3), "the prior hunk showed hunk A lines");
  // Hunk A line: proven unchanged and proven reviewed, no basis => follow-up.
  const hunkA = applyLateFindingRule([finding("hunk-a", "fix.ts:3")], context);
  assert.deepEqual(hunkA.followUp.map((item) => item.id), ["hunk-a"]);
  // Hunk A line with a valid critical basis stays blocking.
  const hunkACritical = applyLateFindingRule(
    [finding("hunk-a-crit", "fix.ts:3", {
      lateFinding: { basis: "critical", criticalKind: "false_acceptance", rationale: "Accepts without the required check." },
    })],
    context,
  );
  assert.deepEqual(hunkACritical.retained.map((item) => item.id), ["hunk-a-crit"]);
  // Hunk B line: the correction hunk itself stays blocking.
  const hunkB = applyLateFindingRule([finding("hunk-b", "fix.ts:15")], context);
  assert.deepEqual(hunkB.retained.map((item) => item.id), ["hunk-b"]);
  // File-level location on a changed file: ambiguous, stays blocking.
  const fileLevel = applyLateFindingRule([finding("file-level", "fix.ts")], context);
  assert.deepEqual(fileLevel.retained.map((item) => item.id), ["file-level"]);
  // other.ts line: outside the fix delta with verified prior line coverage => follow-up.
  const other = applyLateFindingRule([finding("other", "other.ts:1")], context);
  assert.deepEqual(other.followUp.map((item) => item.id), ["other"]);
});

test("W2 F1 actual Git guard deletion cannot demote the surviving call", (t) => {
  const r = repository(t, "guard-deletion");
  r.write("service.js", "export function run(ok) {\n  if (!ok) return;\n  dangerous();\n}\n");
  r.git("add", ".");
  r.git("commit", "-m", "prior reviewed");
  const prior = r.git("rev-parse", "HEAD^{tree}").trim();
  r.write("service.js", "export function run(ok) {\n  dangerous();\n}\n// unrelated comment\n");
  r.git("add", ".");
  r.git("commit", "-m", "repair removes guard");
  const head = r.git("rev-parse", "HEAD^{tree}").trim();
  const diff = r.git("diff", prior, head, "--");
  const files = r.git("diff", "-z", "--name-only", prior, head, "--").split("\0").filter(Boolean);
  // Honest prior line coverage: the prior review saw the whole 4-line file.
  const priorShown = shownRecord(parseShownLines(r.git("diff", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", prior, "--")));
  assert.deepEqual(priorShown, { "service.js": [1, 2, 3, 4] });
  const out = applyLateFindingRule(
    [finding("call", "service.js:2")],
    ruleContext({
      deltaFiles: files,
      priorReviewedFiles: ["service.js"],
      deltaHunks: hunkRecord(parseDiffHunks(diff)),
      priorShownLines: priorShown,
      priorReadRanges: [],
    }),
  );
  assert.deepEqual(out.followUp, [], "a call whose enclosing guard was deleted is a changed surface");
  assert.deepEqual(out.retained.map((item) => item.id), ["call"]);
});

test("W2 F1 pure deletion point stays blocking", (t) => {
  const r = repository(t, "deletion-point");
  const numbered = Array.from({ length: 12 }, (_, index) => `l${index + 1}\n`).join("");
  r.write("service.js", numbered);
  r.git("add", ".");
  r.git("commit", "-m", "prior");
  const prior = r.git("rev-parse", "HEAD^{tree}").trim();
  r.write("service.js", "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl11\nl12\n");
  r.git("add", ".");
  r.git("commit", "-m", "repair deletes middle");
  const head = r.git("rev-parse", "HEAD^{tree}").trim();
  const diff = r.git("diff", prior, head, "--");
  const files = r.git("diff", "-z", "--name-only", prior, head, "--").split("\0").filter(Boolean);
  const context = ruleContext({
    deltaFiles: files,
    priorReviewedFiles: ["service.js"],
    deltaHunks: hunkRecord(parseDiffHunks(diff)),
    priorShownLines: shownRecord(parseShownLines(r.git("diff", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", prior, "--"))),
    priorReadRanges: [],
  });
  // Covered lines and every shifted line below the deletion stay blocking.
  for (const location of ["service.js:7", "service.js:8"]) {
    const out = applyLateFindingRule([finding(`del-${location}`, location)], context);
    assert.deepEqual(out.retained.map((item) => item.id), [`del-${location}`], `${location} stays blocking`);
  }
  // Lines above the deletion with intact numbering and coverage demote.
  const above = applyLateFindingRule([finding("above", "service.js:2")], context);
  assert.deepEqual(above.followUp.map((item) => item.id), ["above"]);
});

test("W2 F2 actual Git leading-space file is a distinct identity", (t) => {
  const r = repository(t, "leading-space");
  r.write("service.js", "plain\n");
  r.write(" service.js", "spaced\n");
  r.write("repair.js", "old\n");
  r.git("add", ".");
  r.git("commit", "-m", "baseline");
  const base = r.git("rev-parse", "HEAD^{tree}").trim();
  r.write(" service.js", "reviewed changed\n");
  r.git("add", ".");
  r.git("commit", "-m", "prior review");
  const prior = r.git("rev-parse", "HEAD^{tree}").trim();
  r.write("repair.js", "fixed\n");
  r.git("add", ".");
  r.git("commit", "-m", "repair");
  const head = r.git("rev-parse", "HEAD^{tree}").trim();
  const names = (a: string, b: string) => r.git("diff", "-z", "--name-only", a, b, "--").split("\0").filter(Boolean);
  const priorReviewed = names(base, prior);
  const delta = names(prior, head);
  assert.deepEqual(priorReviewed, [" service.js"]);
  assert.deepEqual(delta, ["repair.js"]);
  const out = applyLateFindingRule(
    [finding("spaced", "service.js:1")],
    ruleContext({
      deltaFiles: delta,
      priorReviewedFiles: priorReviewed,
      deltaHunks: hunkRecord(parseDiffHunks(r.git("diff", prior, head, "--"))),
      priorShownLines: shownRecord(parseShownLines(r.git("diff", base, prior, "--"))),
      priorReadRanges: [],
    }),
  );
  assert.deepEqual(out.followUp, [], "service.js is distinct from the actually reviewed leading-space filename");
});

test("W2 F2 spaced delta path stays unnamed by a different filename finding", (t) => {
  const r = repository(t, "spaced-delta");
  r.write("service.js", "plain\n");
  r.write(" service.js", "spaced\n");
  r.git("add", ".");
  r.git("commit", "-m", "prior");
  const prior = r.git("rev-parse", "HEAD^{tree}").trim();
  r.write(" service.js", "fix\n");
  r.git("add", ".");
  r.git("commit", "-m", "repair");
  const head = r.git("rev-parse", "HEAD^{tree}").trim();
  const files = r.git("diff", "-z", "--name-only", prior, head, "--").split("\0").filter(Boolean);
  assert.deepEqual(deltaFilesWithoutPriorFindings(files, [finding("f", "service.js:1")]).unnamed, [" service.js"]);
});

test("W2 model paths trim presentation; machine paths keep every byte", () => {
  assert.equal(normalizeModelPath("  src/a.ts  "), "src/a.ts");
  assert.equal(normalizeModelPath("./src/a.ts"), "src/a.ts");
  assert.equal(normalizeModelPath("sp ace.ts"), "sp ace.ts");
  // A spaced machine path matches exactly; padded or renamed forms never alias it.
  assert.equal(findingNamesPath("sp ace.ts", "sp ace.ts"), true);
  assert.equal(findingNamesPath(" sp ace.ts ", "sp ace.ts"), true);
  assert.equal(findingNamesPath("sp ace.ts", " sp ace.ts"), false);
  assert.equal(findingNamesPath("sp ace.ts", "sp ace.ts "), false);
});

test("W2 actual Git correction delta includes unrelated paths", (t) => {
  const r = repository(t, "unrelated");
  r.write("keep.ts", "keep\n");
  r.write("fix.ts", "fix1\n");
  r.git("add", ".");
  r.git("commit", "-m", "base");
  r.write("fix.ts", "fix2\n");
  r.git("add", ".");
  r.git("commit", "-m", "prior");
  const prior = r.git("rev-parse", "HEAD").trim();
  // The correction touches the reviewed file AND an unrelated new file.
  r.write("fix.ts", "fix3\n");
  r.write("unrelated.ts", "unrelated\n");
  r.git("add", ".");
  r.git("commit", "-m", "current");
  const current = r.git("rev-parse", "HEAD").trim();
  const nulFiles = r.git("diff", "-z", "--name-only", prior, current, "--").split("\0").filter(Boolean).sort();
  assert.deepEqual(nulFiles, ["fix.ts", "unrelated.ts"]);
  const split = deltaFilesWithoutPriorFindings(nulFiles, [finding("f1", "fix.ts")]);
  assert.deepEqual(split.unnamed, ["unrelated.ts"]);
  assert.equal(isOverCorrection(split), true);
});

test("W2 actual Git trees diff directly and NUL names keep exact identity", (t) => {
  const r = repository(t, "paths");
  r.write("a/inner.ts", "a\n");
  r.write("b/inner.ts", "b\n");
  r.write("sp ace.ts", "space\n");
  r.write("plain.ts", "plain\n");
  r.git("add", ".");
  r.git("commit", "-m", "prior");
  const priorTree = r.git("rev-parse", `${r.git("rev-parse", "HEAD").trim()}^{tree}`).trim();
  assert.match(priorTree, /^[a-f0-9]{40}$/);
  r.write("b/inner.ts", "b2\n");
  r.write("sp ace.ts", "space2\n");
  r.git("add", ".");
  r.git("commit", "-m", "current");
  const currentTree = r.git("rev-parse", `${r.git("rev-parse", "HEAD").trim()}^{tree}`).trim();
  // Raw tree ids are valid diff operands: the audited factory path.
  const nulFiles = r.git("diff", "-z", "--name-only", priorTree, currentTree, "--").split("\0").filter(Boolean).sort();
  assert.deepEqual(nulFiles, ["b/inner.ts", "sp ace.ts"]);
  const text = r.git("diff", priorTree, currentTree, "--");
  assert.ok(text.includes("sp ace.ts"), "the real diff names the spaced path");
  // Strict identity: no prefix invention, no quote decoding.
  assert.equal(findingNamesPath("b/inner.ts", "b/inner.ts"), true);
  assert.equal(findingNamesPath("sp ace.ts", "sp ace.ts"), true);
  assert.equal(findingNamesPath("inner.ts", "b/inner.ts"), false);
  assert.equal(findingNamesPath('"sp ace.ts"', "sp ace.ts"), false);
  assert.equal(findingNamesPath("a/inner.ts -> b/inner.ts", "b/inner.ts"), false);
});

test("W2 validateReviewDelta binds the prior and the verified surface", () => {
  const head = "c".repeat(40);
  const valid = {
    priorReviewId: "r1",
    headTree: head,
    deltaFiles: ["src/a.ts"],
    priorReviewedFiles: ["src/a.ts", "src/b.ts"],
    priorShownLines: { "src/a.ts": [1, 2, 3, 4] },
    priorReadRanges: [{ path: "src/a.ts", startLine: 2, endLine: 2 }],
    deltaHunks: { "src/a.ts": [{ oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 }] },
    filesWithoutPriorFindings: ["src/a.ts"],
    invalidatedEvidenceIds: ["e1"],
    cumulativeIncludedUpFront: false,
    overCorrection: true,
  };
  const parsed = validateReviewDelta(valid, "r1");
  assert.deepEqual(parsed?.priorReviewedFiles, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(parsed?.priorShownLines, { "src/a.ts": [1, 2, 3, 4] });
  assert.deepEqual(parsed?.priorReadRanges, [{ path: "src/a.ts", startLine: 2, endLine: 2 }]);
  assert.deepEqual(parsed?.deltaHunks, { "src/a.ts": [{ oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 }] });
  assert.equal(validateReviewDelta(undefined, "r1"), undefined);
  assert.throws(() => validateReviewDelta(valid, "r2"), /prior review/);
  assert.throws(() => validateReviewDelta({ ...valid, filesWithoutPriorFindings: ["src/zzz.ts"] }, "r1"), /unnamed/);
  assert.throws(() => validateReviewDelta({ ...valid, deltaArtifactHash: "zz" }, "r1"), /artifact/);
  assert.throws(
    () => validateReviewDelta({ ...valid, headTree: undefined, fallback: undefined }, "r1"),
    /fallback/,
  );
  const fallback = validateReviewDelta(
    {
      priorReviewId: "r1",
      deltaFiles: ["src/a.ts"],
      priorReviewedFiles: [],
      priorReadRanges: [],
      filesWithoutPriorFindings: ["src/a.ts"],
      invalidatedEvidenceIds: [],
      cumulativeIncludedUpFront: true,
      overCorrection: false,
      fallback: "full_cumulative",
    },
    "r1",
  );
  assert.equal(fallback?.fallback, "full_cumulative");
  assert.throws(() => validateReviewDelta({ ...valid, priorReviewedFiles: ["  "] }, "r1"), /prior reviewed/);
  assert.throws(
    () => validateReviewDelta({ ...valid, deltaHunks: { "src/a.ts": [{ oldStart: 3, oldCount: -1, newStart: 3, newCount: 1 }] } }, "r1"),
    /hunk/,
  );
  assert.throws(
    () => validateReviewDelta({ ...valid, priorReadRanges: [{ path: "src/a.ts", startLine: 5, endLine: 2 }] }, "r1"),
    /read range/,
  );
  assert.throws(() => validateReviewDelta({ ...valid, priorReadRanges: undefined }, "r1"), /read ranges/);
});

test("W2 finding validation carries the late basis structurally, rejects fakes", () => {
  const parsed = validateDeliveryFindings([
    {
      id: "f1",
      category: "missing_coverage",
      severity: "blocking",
      claim: "gap",
      evidenceRefs: [],
      lateFinding: { basis: "critical", criticalKind: "security", rationale: "Rationale." },
    },
    {
      id: "f2",
      category: "missing_coverage",
      severity: "blocking",
      claim: "gap",
      evidenceRefs: [],
      lateFinding: { basis: "failing_test", testIds: ["t1"], rationale: "Runner check t1 fails." },
    },
    { id: "f3", category: "missing_coverage", severity: "blocking", claim: "gap", evidenceRefs: [] },
  ]);
  assert.equal(parsed[0]?.lateFinding?.basis, "critical");
  assert.equal(parsed[1]?.lateFinding?.basis, "failing_test");
  assert.equal(parsed[2]?.lateFinding, undefined);
  assert.throws(
    () => validateDeliveryFindings([
      { id: "bad", category: "missing_coverage", severity: "blocking", claim: "gap", evidenceRefs: [], lateFinding: { basis: "rumor", rationale: "x" } },
    ]),
    /lateFinding/,
  );
  assert.throws(
    () => validateDeliveryFindings([
      { id: "bad", category: "missing_coverage", severity: "blocking", claim: "gap", evidenceRefs: [], lateFinding: { basis: "failing_test", testIds: [], rationale: "x" } },
    ]),
    /lateFinding|testIds/,
  );
});

// Real section assembly through the product runtime (white-box, as the W1
// boundary tests do): blind-first ordering, cumulative gating and the
// tool reference are observed behavior, not source strings.

const W2_DIFF_HASH = "d".repeat(64);

function w2SectionRuntime(options: {
  priorReviewId?: string;
  history?: Array<{ reviewId: string; findings: PlanningFinding[] }>;
  fixDelta?: Record<string, unknown>;
}) {
  const runtime = Object.create(NativeDeliverableReviewRuntime.prototype) as unknown as {
    options: { sessions: { events(id: string): unknown[] } };
    projection(runId: string): {
      delivery?: {
        reviews: Record<string, Record<string, unknown>>;
        reviewHistory: Record<string, Array<{ reviewId: string; findings: PlanningFinding[] }>>;
      };
      tasks: Record<string, unknown>;
    };
    sections(context: unknown, pass: "findings" | "verdict" | "obligations"): ContextSection[];
  };
  runtime.options = { sessions: { events: () => [] } };
  runtime.projection = () => ({
    delivery: {
      reviews: {
        T1: {
          ...(options.priorReviewId ? { priorReviewId: options.priorReviewId } : {}),
          stage: "diff_delivered",
        },
      },
      reviewHistory: { T1: options.history ?? [] },
    },
    tasks: {},
  });
  return runtime;
}

function w2SectionInputs(fixDelta?: Record<string, unknown>) {
  return {
    taskId: "T1",
    attempt: 2,
    changeSetId: "cs2",
    baselineRevision: "base",
    taskRevision: "head",
    diffArtifactHash: W2_DIFF_HASH,
    diffText: "FULL-CUMULATIVE-DIFF",
    changedPaths: ["src/a.ts"],
    objective: "Fix a.",
    criteria: [{ id: "c1", text: "A holds." }],
    workerSummary: "Fixed.",
    unresolvedConcerns: [],
    claims: [],
    authorRuntimeId: "worker",
    ...(fixDelta ? { fixDelta } : {}),
  };
}

function w2FixDelta(overrides: Record<string, unknown> = {}) {
  return {
    priorReviewId: "r1",
    priorHeadTree: "a".repeat(40),
    headTree: "b".repeat(40),
    deltaFiles: ["src/a.ts"],
    priorReviewedFiles: ["src/a.ts"],
    priorShownLines: { "src/a.ts": [1, 2, 3] },
    priorReadRanges: [],
    deltaHunks: { "src/a.ts": [{ oldStart: 7, oldCount: 1, newStart: 7, newCount: 2 }] },
    filesWithoutPriorFindings: [],
    invalidatedEvidenceIds: ["e1"],
    deltaText: "FIX-DELTA-DIFF",
    cumulativeArtifactHash: W2_DIFF_HASH,
    cumulativeIncludedUpFront: false,
    overCorrection: false,
    ...overrides,
  };
}

function sectionIds(sections: ContextSection[]) {
  return sections.map((section) => section.id);
}

function sectionText(sections: ContextSection[], id: string) {
  return sections.find((section) => section.id === id)?.content ?? "";
}

test("W2 findings pass is blind-first: delta up front, no prior findings", () => {
  const runtime = w2SectionRuntime({
    priorReviewId: "r1",
    history: [{
      reviewId: "r1",
      findings: [{ ...finding("prior-1", "src/a.ts"), claim: "prior-secret-claim" }],
    }],
  });
  const context = {
    request: { runId: "run", taskId: "T1" },
    reviewId: "rev2",
    inputs: w2SectionInputs(w2FixDelta()),
    tier: "low",
  };
  const sections = runtime.sections(context, "findings");
  const ids = sectionIds(sections);
  for (const id of ["fix-delta", "delta-files-without-findings", "invalidated-evidence", "submitted-diff"]) {
    assert.ok(ids.includes(id), `findings carry ${id}`);
  }
  assert.ok(!ids.includes("prior-findings"), "no prior findings in the blind pass");
  assert.ok(!ids.includes("late-finding-rule"), "no verdict rule in the findings pass");
  // F4 correction-first order: criteria -> fix delta -> unnamed files ->
  // invalidated evidence -> allowed cumulative (reference here).
  assert.deepEqual(
    ids.filter((id) => ["fix-delta", "delta-files-without-findings", "invalidated-evidence", "submitted-diff"].includes(id)),
    ["fix-delta", "delta-files-without-findings", "invalidated-evidence", "submitted-diff"],
  );
  assert.ok(ids.indexOf("acceptance-criteria") < ids.indexOf("fix-delta"), "criteria precede the fix delta");
  // Ordinary repair at low tier: the full cumulative text is withheld, the
  // real tool reference (artifact hash, artifact read) is present.
  assert.ok(!sectionText(sections, "submitted-diff").includes("FULL-CUMULATIVE-DIFF"));
  assert.ok(sectionText(sections, "submitted-diff").includes(W2_DIFF_HASH));
  assert.ok(sectionText(sections, "submitted-diff").includes("artifact read"));
  // The delta carries no prior finding names or claims.
  assert.ok(sectionText(sections, "fix-delta").includes("FIX-DELTA-DIFF"));
  assert.ok(!sections.map((section) => section.content).join("\n").includes("prior-secret-claim"));
});

test("W2 high tier and over-correction include the cumulative diff up front", () => {
  const runtime = w2SectionRuntime({ priorReviewId: "r1" });
  const base = {
    request: { runId: "run", taskId: "T1" },
    reviewId: "rev2",
    tier: "low" as const,
  };
  const high = runtime.sections(
    { ...base, tier: "high", inputs: w2SectionInputs(w2FixDelta({ cumulativeIncludedUpFront: true })) },
    "findings",
  );
  assert.ok(sectionText(high, "submitted-diff").includes("FULL-CUMULATIVE-DIFF"));
  // F4: even with the cumulative included, the correction leads.
  const highText = high.map((section) => section.content).join("\n");
  assert.ok(highText.indexOf("FIX-DELTA-DIFF") < highText.indexOf("FULL-CUMULATIVE-DIFF"));
  const over = runtime.sections(
    {
      ...base,
      inputs: w2SectionInputs(w2FixDelta({
        deltaFiles: ["src/a.ts", "src/unrelated.ts"],
        filesWithoutPriorFindings: ["src/unrelated.ts"],
        cumulativeIncludedUpFront: true,
        overCorrection: true,
      })),
    },
    "findings",
  );
  assert.ok(sectionText(over, "submitted-diff").includes("FULL-CUMULATIVE-DIFF"));
  assert.ok(sectionText(over, "delta-files-without-findings").includes("src/unrelated.ts"));
});

test("W2 verdict pass releases prior findings after own findings, with the rule", () => {
  const runtime = w2SectionRuntime({
    priorReviewId: "r1",
    history: [{
      reviewId: "r1",
      findings: [{ ...finding("prior-1", "src/a.ts"), claim: "prior-secret-claim" }],
    }],
  });
  const context = {
    request: { runId: "run", taskId: "T1" },
    reviewId: "rev2",
    inputs: {
      ...w2SectionInputs(w2FixDelta()),
      workerSummary: "Fixed.",
      claims: [{ id: "claim:c1", text: "C1.", evidenceIds: [] }],
    },
    tier: "low" as const,
  };
  const sections = runtime.sections(context, "verdict");
  const ids = sectionIds(sections);
  assert.ok(ids.includes("late-finding-rule"), "the verdict states the late-finding rule");
  assert.ok(ids.includes("prior-findings"), "the verdict releases prior findings");
  assert.ok(sectionText(sections, "prior-findings").includes("prior-1"));
  assert.ok(ids.indexOf("own-findings") < ids.indexOf("prior-findings"), "own findings precede released priors");
  assert.ok(ids.indexOf("late-finding-rule") < ids.indexOf("prior-findings"), "the rule precedes released priors");
});

test("W2 F5 captured one-line read cannot prove untouched line fifty", async (t) => {
  const r = repository(t, "ranged");
  r.write("service.js", Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n"));
  r.write("repair.js", "baseline\n");
  r.git("add", ".");
  r.git("commit", "-m", "baseline");
  const base = r.git("rev-parse", "HEAD^{tree}").trim();
  r.write("repair.js", "prior review\n");
  r.git("add", ".");
  r.git("commit", "-m", "prior");
  const prior = r.git("rev-parse", "HEAD^{tree}").trim();
  // An actual one-line read through the real tool and the real ledger.
  const fsRead = createFilesystemTools().find((tool) => tool.definition.name === "fs.read")!;
  const toolContext = { runId: "r", sessionId: "prior-verdict", workspacePath: r.cwd, actor: { role: "verifier" as const, id: "reviewer" } };
  const actual = await fsRead.execute({ path: "service.js", startLine: 1, endLine: 1 }, toolContext);
  assert.equal(actual.isError, false);
  const ledger = new SqliteToolLedger(join(r.cwd, "ledger.sqlite"));
  const key = "r\0prior-verdict\0read";
  ledger.begin({
    key, fingerprint: "unit-range-fingerprint", callId: "read", toolName: "fs.read", runId: "r",
    sessionId: "prior-verdict", replaySafe: true, effect: "none",
    access: { kind: "path", mode: "read", path: "service.js" } as never,
    actor: { role: "verifier", id: "reviewer" }, outsideWorkspace: false, occurredAt: "2026-10-05T10:00:00Z",
  });
  ledger.complete(key, "unit-range-fingerprint", { ...actual, callId: "read", toolName: "fs.read" } as never, "2026-10-05T10:00:01Z");
  const capture = captureReviewReads(ledger, {
    runId: "r", taskId: "task", reviewId: "prior", changeSetId: "prior-cs", submissionAttempt: 1,
    reviewerRuntimeId: "reviewer", reviewerModelIdentity: "reviewer-model", sessionId: "prior-verdict",
  });
  assert.equal(capture.reads.length, 1);
  assert.equal(capture.reads[0]?.endLine, 1);
  // Close in-body: after-hooks run in registration order, so the
  // repository() removal would otherwise race the open SQLite handle.
  ledger.close();
  r.write("repair.js", "fixed\n");
  r.git("add", "repair.js");
  r.git("commit", "-m", "repair");
  const head = r.git("rev-parse", "HEAD^{tree}").trim();
  const names = (a: string, b: string) => r.git("diff", "-z", "--name-only", a, b, "--").split("\0").filter(Boolean);
  const artifacts = new ArtifactStore(join(r.cwd, "artifacts"));
  const priorBytes = Buffer.from(r.git("diff", base, prior, "--"), "utf8");
  const priorRecord = await artifacts.put(priorBytes, "text/x-diff", "prior cumulative");
  const seam = Object.create(NativeDeliverableReviewRuntime.prototype) as unknown as {
    options: {
      artifacts: ArtifactStore;
      resolveFixDelta: (input: { priorBaseTree?: string; priorHeadTree: string; headTree: string }) => Promise<{ deltaFiles: string[]; deltaText: string; priorReviewed: string[] } | undefined>;
    };
    assembleFixDelta(task: unknown, inputs: unknown, prior: unknown, headTree: string, tier: string): Promise<{
      deltaFiles: string[]; priorReviewedFiles: string[]; priorReadRanges: Array<{ path: string; startLine: number; endLine: number }>;
      priorShownLines?: Record<string, number[]>; invalidatedEvidenceIds: string[]; filesWithoutPriorFindings: string[];
    }>;
  };
  seam.options = {
    artifacts,
    resolveFixDelta: async () => ({ deltaFiles: names(prior, head), deltaText: r.git("diff", prior, head, "--"), priorReviewed: names(base, prior) }),
  };
  const delta = await seam.assembleFixDelta(
    { id: "task" },
    { changedPaths: ["repair.js"], diffArtifactHash: "a".repeat(64) },
    {
      reviewId: "prior", reviewKeyInputs: { baseTree: base, headTree: prior }, readCapture: capture,
      diffArtifactHash: priorRecord.hash, findings: [], claims: [],
    },
    head,
    "medium",
  );
  // The read authorizes exactly its line: the path is NOT widened to the file.
  assert.deepEqual(delta.priorReviewedFiles, ["repair.js"]);
  assert.deepEqual(delta.priorReadRanges, [{ path: "service.js", startLine: 1, endLine: 1 }]);
  const context = ruleContext({
    deltaFiles: delta.deltaFiles,
    priorReviewedFiles: delta.priorReviewedFiles,
    deltaHunks: {},
    priorShownLines: delta.priorShownLines,
    priorReadRanges: delta.priorReadRanges,
  });
  const far = applyLateFindingRule([finding("far", "service.js:50")], context);
  assert.deepEqual(far.followUp, [], "a one-line native read does not review every untouched line");
  assert.deepEqual(far.retained.map((item) => item.id), ["far"]);
  const near = applyLateFindingRule([finding("near", "service.js:1")], context);
  assert.deepEqual(near.followUp.map((item) => item.id), ["near"], "the actually read line demotes");
});

test("W2 F6 invalidation spans runner depth/probe and finding evidence, ids only", async () => {
  const seam = Object.create(NativeDeliverableReviewRuntime.prototype) as unknown as {
    options: {
      artifacts: { put(bytes: Buffer, mediaType: string, label?: string): Promise<{ hash: string }> };
      resolveFixDelta: (input: { priorBaseTree?: string; priorHeadTree: string; headTree: string }) => Promise<{ deltaFiles: string[]; deltaText: string; priorReviewed: string[] } | undefined>;
    };
    assembleFixDelta(task: unknown, inputs: unknown, prior: unknown, headTree: string, tier: string): Promise<{ invalidatedEvidenceIds: string[] }>;
  };
  seam.options = {
    artifacts: { put: async () => ({ hash: "d".repeat(64) }) },
    resolveFixDelta: async () => ({
      deltaFiles: ["service.js"],
      deltaText: "diff --git a/service.js b/service.js\n--- a/service.js\n+++ b/service.js\n@@ -1 +1 @@\n-old\n+new\n",
      priorReviewed: ["service.js"],
    }),
  };
  const prior = {
    reviewId: "prior",
    reviewKeyInputs: { baseTree: "a".repeat(40), headTree: "b".repeat(40) },
    claims: [],
    claimVerdicts: [],
    depth: { affectedTests: { evidenceIds: ["prior-affected-test"] }, probe: { evidenceIds: ["prior-probe"] } },
    findings: [{ id: "f1", location: "service.js:1", claim: "secret-claim-text", evidenceRefs: ["prior-finding-evidence"] }],
  };
  const delta = await seam.assembleFixDelta(
    { id: "task" },
    { changedPaths: ["service.js"], diffArtifactHash: "e".repeat(64) },
    prior,
    "c".repeat(40),
    "medium",
  );
  assert.deepEqual(
    new Set(delta.invalidatedEvidenceIds),
    new Set(["prior-affected-test", "prior-probe", "prior-finding-evidence"]),
    "all prior tree-bound test/probe/finding facts are invalidated",
  );
  assert.ok(!JSON.stringify(delta).includes("secret-claim-text"), "no finding text leaks through the invalidated view");
});

test("W2 initial reviews keep full-diff behavior with no delta sections", () => {
  const runtime = w2SectionRuntime({});
  const context = {
    request: { runId: "run", taskId: "T1" },
    reviewId: "rev1",
    inputs: w2SectionInputs(),
    tier: "low" as const,
  };
  const sections = runtime.sections(context, "findings");
  const ids = sectionIds(sections);
  assert.ok(sectionText(sections, "submitted-diff").includes("FULL-CUMULATIVE-DIFF"));
  for (const id of ["fix-delta", "delta-files-without-findings", "invalidated-evidence", "late-finding-rule"]) {
    assert.ok(!ids.includes(id), `initial reviews carry no ${id}`);
  }
});

test("W2 blind-first prompts: findings judge the delta alone, verdict checks both directions", () => {
  // EP42: the findings pass has not received prior findings yet, so its
  // re-review instruction judges the repair delta independently and must
  // never ask for prior-finding resolution.
  const findingsReReview = deliveryReviewerSystemPrompt("findings", "medium", 1, true);
  assert.match(findingsReReview, /repair delta first/);
  assert.match(findingsReReview, /regression/);
  assert.match(findingsReReview, /over-correction/);
  assert.match(findingsReReview, /withheld until the later verdict pass/);
  assert.match(findingsReReview, /without inferring or reconstructing/);
  assert.doesNotMatch(findingsReReview, /each prior finding/i);
  assert.doesNotMatch(findingsReReview, /resolved or outstanding/i);
  assert.doesNotMatch(findingsReReview, /check BOTH/i);
  // The verdict pass runs after own findings are durable and prior
  // findings are released: exact both-directions checks plus the
  // late-finding policy (CD-4).
  const verdictReReview = deliveryReviewerSystemPrompt("verdict", "medium", 1, true);
  assert.match(verdictReReview, /own findings are now durable/);
  assert.match(verdictReReview, /prior findings are released/);
  assert.match(verdictReReview, /BOTH directions/);
  assert.match(verdictReReview, /each prior finding resolved or outstanding/);
  assert.match(verdictReReview, /no change beyond/);
  assert.match(verdictReReview, /regressed/);
  assert.match(verdictReReview, /critical \(security, data loss, false acceptance\)/);
  assert.match(verdictReReview, /failing test/);
  assert.match(verdictReReview, /follow-up/);
  // Initial reviews receive no re-review-only prior/late-finding instructions.
  const verdictInitial = deliveryReviewerSystemPrompt("verdict", "medium", 1, false);
  assert.doesNotMatch(verdictInitial, /prior finding/i);
  assert.doesNotMatch(verdictInitial, /BOTH directions/);
  assert.doesNotMatch(verdictInitial, /failing test/);
  assert.doesNotMatch(verdictInitial, /follow-up/);
  {
    // Initial-review prompts carry no re-review-only instructions.
    const findingsInitial = deliveryReviewerSystemPrompt("findings", "medium", 1, false);
    assert.ok(findingsInitial.length > 0);
    assert.doesNotMatch(findingsInitial, /prior finding/i);
    assert.doesNotMatch(findingsInitial, /fix re-review/i);

  }
});
