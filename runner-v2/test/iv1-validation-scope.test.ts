import assert from "node:assert/strict";
import test from "node:test";

import {
  cloneValidationScope,
  parseValidationScope,
  validationScopeJsonSchema,
  type ValidationScope,
} from "../src/validation-scope.js";

/**
 * IV-1 (CD-23): the canonical validation-scope contract. One parser, one
 * cloner, one schema — reused by the worker tool, the change set, and the
 * scheduler kernel instead of duplicated validation logic.
 */

function validScope(): ValidationScope {
  return {
    changed: ["src/value.mjs", "test/value.test.mjs"],
    verified: ["value exports 2", "guard caps at 9"],
    testsRun: [
      { command: "node --test test/value.test.mjs", counts: { selected: 2, passed: 2, failed: 0, skipped: 0 } },
    ],
    notRun: [{ what: "full suite", why: "narrow change; no shared contract touched" }],
  };
}

test("IV-1 canonical scope parses and trims to a fresh clone", () => {
  const parsed = parseValidationScope({
    changed: ["  src/value.mjs  "],
    verified: ["value exports 2"],
    testsRun: [
      { command: "  node --test  ", counts: { selected: 3, passed: 1, failed: 1, skipped: 1 } },
    ],
    notRun: [],
  });
  assert.deepEqual(parsed, {
    changed: ["src/value.mjs"],
    verified: ["value exports 2"],
    testsRun: [
      { command: "node --test", counts: { selected: 3, passed: 1, failed: 1, skipped: 1 } },
    ],
    notRun: [],
  });
});

test("IV-1 empty arrays are legitimate except an all-empty scope", () => {
  const parsed = parseValidationScope({ changed: ["src/a.ts"], verified: [], testsRun: [], notRun: [] });
  assert.deepEqual(parsed.verified, []);
  assert.throws(
    () => parseValidationScope({ changed: [], verified: [], testsRun: [], notRun: [] }),
    /at least one/
  );
});

test("IV-1 missing or misshapen scope is refused", () => {
  assert.throws(() => parseValidationScope(undefined), /must be an object/);
  assert.throws(() => parseValidationScope(null), /must be an object/);
  assert.throws(() => parseValidationScope("trust me"), /must be an object/);
  assert.throws(() => parseValidationScope({}), /changed.*array/);
  assert.throws(
    () => parseValidationScope({ ...validScope(), changed: "src/a.ts" }),
    /changed.*array/
  );
  assert.throws(
    () => parseValidationScope({ ...validScope(), verified: [42] }),
    /verified.*strings/
  );
  assert.throws(
    () => parseValidationScope({ ...validScope(), testsRun: {} }),
    /testsRun.*array/
  );
  assert.throws(
    () => parseValidationScope({ ...validScope(), notRun: "none" }),
    /notRun.*array/
  );
});

test("IV-1 blank or unbounded strings are refused", () => {
  assert.throws(
    () => parseValidationScope({ ...validScope(), changed: ["   "] }),
    /non-empty after trimming/
  );
  assert.throws(
    () => parseValidationScope({ ...validScope(), verified: ["x".repeat(501)] }),
    /at most 500/
  );
  assert.throws(
    () =>
      parseValidationScope({
        ...validScope(),
        testsRun: [{ command: "  ", counts: { selected: 1, passed: 1, failed: 0, skipped: 0 } }],
      }),
    /command.*non-empty/
  );
  assert.throws(
    () =>
      parseValidationScope({
        ...validScope(),
        notRun: [{ what: "full suite", why: "" }],
      }),
    /why.*non-empty/
  );
  assert.throws(
    () =>
      parseValidationScope({
        ...validScope(),
        changed: Array.from({ length: 51 }, (_, index) => `surface-${index}`),
      }),
    /at most 50/
  );
});

test("IV-1 counts must be non-negative safe integers with selected equal to the sum", () => {
  const counts = (counts: unknown) =>
    parseValidationScope({
      ...validScope(),
      testsRun: [{ command: "node --test", counts }],
    });
  assert.throws(() => counts({ selected: -1, passed: 0, failed: 0, skipped: 0 }), /non-negative safe integer/);
  assert.throws(() => counts({ selected: 1.5, passed: 1, failed: 0, skipped: 0 }), /non-negative safe integer/);
  assert.throws(() => counts({ selected: 2, passed: 1, failed: 0, skipped: 0 }), /inconsistent/);
  assert.throws(() => counts({ selected: 1, passed: 1, failed: 0 }), /non-negative safe integer/);
  const parsed = counts({ selected: 4, passed: 2, failed: 1, skipped: 1 });
  assert.deepEqual(parsed.testsRun[0]!.counts, { selected: 4, passed: 2, failed: 1, skipped: 1 });
});

test("IV-1 a run claiming selected=0 cannot masquerade as verification", () => {
  assert.throws(
    () =>
      parseValidationScope({
        ...validScope(),
        testsRun: [{ command: "node --test", counts: { selected: 0, passed: 0, failed: 0, skipped: 0 } }],
      }),
    /selected=0/
  );
});

test("IV-1 unknown fields are refused at every level", () => {
  assert.throws(
    () => parseValidationScope({ ...validScope(), trustMe: true }),
    /unknown field/
  );
  assert.throws(
    () =>
      parseValidationScope({
        ...validScope(),
        testsRun: [
          {
            command: "node --test",
            counts: { selected: 1, passed: 1, failed: 0, skipped: 0 },
            green: true,
          },
        ],
      }),
    /unknown field/
  );
  assert.throws(
    () =>
      parseValidationScope({
        ...validScope(),
        testsRun: [
          { command: "node --test", counts: { selected: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 } },
        ],
      }),
    /unknown field/
  );
  assert.throws(
    () =>
      parseValidationScope({
        ...validScope(),
        notRun: [{ what: "x", why: "y", approvedBy: "model" }],
      }),
    /unknown field/
  );
});

test("IV-1 clone is a deep independent copy", () => {
  const scope = validScope();
  const cloned = cloneValidationScope(scope);
  assert.deepEqual(cloned, scope);
  assert.notEqual(cloned, scope);
  cloned.changed.push("mutated");
  cloned.testsRun[0]!.counts.passed = 999;
  cloned.notRun[0]!.why = "mutated";
  assert.deepEqual(scope, validScope());
});

test("IV-1 JSON schema requires the four arrays and forbids extras", () => {
  const schema = validationScopeJsonSchema() as {
    required: string[];
    additionalProperties: boolean;
    properties: Record<string, { required?: string[]; additionalProperties?: boolean }>;
  };
  assert.deepEqual(schema.required, ["changed", "verified", "testsRun", "notRun"]);
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties.testsRun);
  assert.ok(schema.properties.notRun);
});
