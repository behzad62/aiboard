import assert from "node:assert/strict";
import test from "node:test";

import {
  outcomeFromReportReading,
  readJUnitReport,
  readTrxReport,
} from "../src/test-report-readers.js";

const JUNIT = `<?xml version="1.0"?>
<testsuites tests="4" failures="1" errors="1" skipped="1">
  <testsuite name="a" tests="4" failures="1" errors="1" skipped="1">
    <testcase classname="a" name="t1"/>
    <testcase classname="a" name="t2"><failure message="boom"/></testcase>
    <testcase classname="a" name="t3"><error message="bang"/></testcase>
    <testcase classname="a" name="t4"><skipped/></testcase>
  </testsuite>
</testsuites>`;

const TRX = `<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <ResultSummary outcome="Failed">
    <Counters total="8" executed="8" passed="6" failed="2" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="0" disconnected="0" warning="0" completed="0" inProgress="0" pending="0" />
  </ResultSummary>
</TestRun>`;

test("JUnit XML reads selected/passed/failed/skipped", () => {
  const reading = readJUnitReport(JUNIT);
  assert.equal(reading.status, "ok");
  assert.deepEqual(reading.status === "ok" ? reading.counts : null, { selected: 4, passed: 1, failed: 2, skipped: 1 });
});

test("TRX reads selected/passed/failed/skipped", () => {
  const reading = readTrxReport(TRX);
  assert.equal(reading.status, "ok");
  assert.deepEqual(reading.status === "ok" ? reading.counts : null, { selected: 8, passed: 6, failed: 2, skipped: 0 });
});

test("missing, empty, or unreadable reports yield unknown, never passed", () => {
  for (const bad of [null, undefined, "", "   ", "<html>not a report</html>", "<testsuites tests=\"abc\"/>"]) {
    const junit = readJUnitReport(bad as string);
    assert.equal(junit.status, "unknown", `JUnit ${JSON.stringify(bad)}`);
    const trx = readTrxReport(bad as string);
    assert.equal(trx.status, "unknown", `TRX ${JSON.stringify(bad)}`);
  }
  const outcome = outcomeFromReportReading({ status: "unknown", reason: "missing" });
  assert.equal(outcome.outcome, "unknown");
});

test("zero-selected reports are unknown, and inconsistent counts are unknown", () => {
  const zero = outcomeFromReportReading(readJUnitReport(`<testsuites tests="0" failures="0" errors="0" skipped="0"/>`));
  assert.equal(zero.outcome, "unknown");
  const bad = readJUnitReport(`<testsuites tests="1" failures="2" errors="0" skipped="0"/>`);
  assert.equal(bad.status, "unknown");
  const trxBad = readTrxReport(`<TestRun><ResultSummary><Counters total="1" passed="2" failed="0"/></ResultSummary></TestRun>`);
  assert.equal(trxBad.status, "unknown");
});

test("JUnit reads testcase counts and rejects aggregate-only totals", () => {
  const aggregateOnly = readJUnitReport(`<testsuites><testsuite tests="2" failures="1"/><testsuite tests="3" failures="0"/></testsuites>`);
  assert.equal(aggregateOnly.status, "unknown");
  const wrappedAggregateOnly = readJUnitReport(`<testsuite name="x" tests="5" failures="0" errors="0" skipped="0"/>`);
  assert.equal(wrappedAggregateOnly.status, "unknown");
  const cases = readJUnitReport(`<testsuite><testcase name="a"/><testcase name="b"><failure/></testcase></testsuite>`);
  assert.equal(cases.status, "ok");
  assert.deepEqual(cases.status === "ok" ? cases.counts : null, { selected: 2, passed: 1, failed: 1, skipped: 0 });
});

// ---------------------------------------------------------------------------
// Repair cycle 1: fail-closed regression tests (independent review probes).
// ---------------------------------------------------------------------------

test("repair B1: nothing-ran reports are unknown, never passed", () => {
  const allSkipped = outcomeFromReportReading(readJUnitReport(
    `<testsuites tests="3" failures="0" errors="0" skipped="3"><testsuite tests="3" skipped="3"/></testsuites>`,
  ));
  assert.equal(allSkipped.outcome, "unknown");
  assert.deepEqual(allSkipped.counts, { selected: 0, passed: 0, failed: 0, skipped: 0 });
  const trxIdle = outcomeFromReportReading(readTrxReport(
    `<TestRun><ResultSummary outcome="Completed"><Counters total="4" executed="0" passed="0" failed="0" error="0" notExecuted="4"/></ResultSummary></TestRun>`,
  ));
  assert.equal(trxIdle.outcome, "unknown");
  const gtestDisabled = outcomeFromReportReading(readJUnitReport(
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="2" failures="0" disabled="2" skipped="0" errors="0" time="0" name="AllTests"><testsuite name="S" tests="2" failures="0" disabled="2" skipped="0" errors="0"><testcase name="DISABLED_a" status="notrun" result="suppressed"/><testcase name="DISABLED_b" status="notrun" result="suppressed"/></testsuite></testsuites>`,
  ));
  assert.equal(gtestDisabled.outcome, "unknown");
  assert.deepEqual(gtestDisabled.counts, { selected: 2, passed: 0, failed: 0, skipped: 2 });
});

test("repair B2: TRX timeout/aborted fail; other terminal outcomes are unknown", () => {
  const timeout = outcomeFromReportReading(readTrxReport(
    `<TestRun><ResultSummary outcome="Failed"><Counters total="3" executed="3" passed="1" failed="0" error="0" timeout="1" aborted="1"/></ResultSummary></TestRun>`,
  ));
  assert.equal(timeout.outcome, "failed");
  assert.deepEqual(timeout.counts, { selected: 3, passed: 1, failed: 2, skipped: 0 });
  for (const name of ["inconclusive", "passedButRunAborted", "notRunnable", "disconnected", "inProgress"]) {
    const reading = readTrxReport(
      `<TestRun><ResultSummary outcome="Completed"><Counters total="2" executed="2" passed="1" failed="0" ${name}="1"/></ResultSummary></TestRun>`,
    );
    assert.equal(reading.status, "unknown", name);
  }
  const disagree = readTrxReport(
    `<TestRun><ResultSummary outcome="Passed"><Counters total="2" executed="2" passed="1" failed="1"/></ResultSummary></TestRun>`,
  );
  assert.equal(disagree.status, "unknown");
  const disagreeFail = readTrxReport(
    `<TestRun><ResultSummary outcome="Failed"><Counters total="2" executed="2" passed="2" failed="0"/></ResultSummary></TestRun>`,
  );
  assert.equal(disagreeFail.status, "unknown");
});

test("repair B3: malformed and self-contradicting JUnit is unknown", () => {
  const mismatch = outcomeFromReportReading(readJUnitReport(
    `<testsuites tests="2" failures="0" errors="0"><testsuite tests="2" failures="0"><testcase name="a"/><testcase name="b"><failure message="boom"/></testcase></testsuite></testsuites>`,
  ));
  assert.equal(mismatch.outcome, "unknown");
  const truncated = outcomeFromReportReading(readJUnitReport(
    `<?xml version="1.0"?><testsuites tests="5" failures="0" errors="0"><testsuite name="x" tests="5"><testcase name="a"/><testc`,
  ));
  assert.equal(truncated.outcome, "unknown");
  const shadowed = readJUnitReport(
    `<!-- <testsuites tests="9" failures="0"> --><testsuites><testsuite tests="2" failures="1"/></testsuites>`,
  );
  assert.equal(shadowed.status, "unknown");
  const xxe = readJUnitReport(
    `<?xml version="1.0"?><!DOCTYPE t [<!ENTITY x SYSTEM "file:///etc/passwd">]><testsuites tests="1" failures="0">&x;</testsuites>`,
  );
  assert.equal(xxe.status, "unknown");
});

test("repair N1 (cycle 2): genuine passes read passed, not unknown", () => {
  const phpunit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="" tests="2" assertions="2" errors="0" failures="0" skipped="0" time="0.01">
    <testsuite name="Tests\\\\CalcTest" file="/p/tests/CalcTest.php" tests="2" assertions="2" errors="0" failures="0" skipped="0" time="0.01">
      <testcase name="testAdd" file="/p/tests/CalcTest.php" line="7" assertions="1" time="0.001"/>
      <testcase name="testSub" file="/p/tests/CalcTest.php" line="9" assertions="1" time="0.001"/>
    </testsuite>
  </testsuite>
</testsuites>`;
  const phpunitReading = outcomeFromReportReading(readJUnitReport(phpunit));
  assert.equal(phpunitReading.outcome, "passed");
  assert.deepEqual(phpunitReading.counts, { selected: 2, passed: 2, failed: 0, skipped: 0 });
  // ctest --output-junit writes status="notrun" plus a <skipped/> child for
  // one skip: a single not-executed test, not a contradiction.
  const ctest = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="Linux-c++" tests="3" failures="0" disabled="0" skipped="1" hostname="h" time="0" timestamp="x">
  <testcase name="core_add" classname="core_add" time="0.01" status="run"><system-out>ok</system-out></testcase>
  <testcase name="core_sub" classname="core_sub" time="0.01" status="run"><system-out>ok</system-out></testcase>
  <testcase name="needs_gpu" classname="needs_gpu" time="0" status="notrun"><skipped message="SKIP_RETURN_CODE=77"/><system-out>skip</system-out></testcase>
</testsuite>`;
  const ctestReading = outcomeFromReportReading(readJUnitReport(ctest));
  assert.equal(ctestReading.outcome, "passed");
  assert.deepEqual(ctestReading.counts, { selected: 3, passed: 2, failed: 0, skipped: 1 });
  // A <!DOCTYPE html> page dump inside CDATA output is output, not a doctype.
  const selenium = `<testsuite name="ui" tests="1" failures="0" errors="0" skipped="0"><testcase name="home"><system-out><![CDATA[page: <!DOCTYPE html><html></html>]]></system-out></testcase></testsuite>`;
  const seleniumReading = outcomeFromReportReading(readJUnitReport(selenium));
  assert.equal(seleniumReading.outcome, "passed");
  assert.deepEqual(seleniumReading.counts, { selected: 1, passed: 1, failed: 0, skipped: 0 });
  // A real prolog doctype is still rejected.
  const xxe = readJUnitReport(
    `<?xml version="1.0"?><!DOCTYPE t [<!ENTITY x SYSTEM "file:///etc/passwd">]><testsuites tests="1" failures="0">&x;</testsuites>`,
  );
  assert.equal(xxe.status, "unknown");
});

test("repair N2 (cycle 2): truncated TRX and result/counter disagreement are unknown", () => {
  const clean = `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="1" name="r" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult testName="A" outcome="Passed" />
    <UnitTestResult testName="B" outcome="Passed" />
  </Results>
  <ResultSummary outcome="Completed">
    <Counters total="2" executed="2" passed="2" failed="0" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="0" disconnected="0" warning="0" completed="0" inProgress="0" pending="0" />
  </ResultSummary>
</TestRun>`;
  const cleanReading = outcomeFromReportReading(readTrxReport(clean));
  assert.equal(cleanReading.outcome, "passed");
  // Cut after <Counters>: no </ResultSummary> or </TestRun> close.
  const truncated = clean.slice(0, clean.indexOf("</ResultSummary>"));
  assert.equal(readTrxReport(truncated).status, "unknown");
  // Per-test results disagree with the counters.
  const lying = clean.replace('testName="B" outcome="Passed"', 'testName="B" outcome="Failed"');
  const lyingReading = readTrxReport(lying);
  assert.equal(lyingReading.status, "unknown");
  // Matching failed results still read failed.
  const mixed = clean
    .replace('testName="B" outcome="Passed"', 'testName="B" outcome="Failed"')
    .replace('passed="2" failed="0"', 'passed="1" failed="1"')
    .replace('outcome="Completed"', 'outcome="Failed"');
  const mixedReading = outcomeFromReportReading(readTrxReport(mixed));
  assert.equal(mixedReading.outcome, "failed");
  assert.deepEqual(mixedReading.counts, { selected: 2, passed: 1, failed: 1, skipped: 0 });
});

test("repair N1: readers stay linear on hostile and large inputs", () => {
  for (const n of [2000, 32000]) {
    for (const [label, input] of [["junit", "<testsuite ".repeat(n)], ["trx", "<counters ".repeat(n)]] as const) {
      const started = Date.now();
      if (label === "junit") readJUnitReport(input);
      else readTrxReport(input);
      assert.ok(Date.now() - started < 2000, `${label} n=${n} must not backtrack`);
    }
  }
  const one = `<testcase classname="a" name="t"/>`;
  const big = `<testsuites tests="50000" failures="0" errors="0" skipped="0">` +
    `<testsuite tests="50000" failures="0">` + one.repeat(50000) + `</testsuite></testsuites>`;
  assert.ok(Buffer.byteLength(big, "utf8") > 1_000_000);
  const started = Date.now();
  const reading = outcomeFromReportReading(readJUnitReport(big));
  assert.ok(Date.now() - started < 5000, "multi-megabyte reports finish within seconds");
  assert.equal(reading.outcome, "passed");
  assert.equal(reading.counts.selected, 50000);
});
