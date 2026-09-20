import assert from "node:assert/strict";
import childProcess from "node:child_process";
import test from "node:test";
import { inspectWindowsFixtureBirth } from "./support/late-birth-fixture.js";

for (const [label, output, expected] of [
  ["present", "PRESENT:2026-09-11T00:00:00.1234567Z", { state: "present", fingerprint: "2026-09-11T00:00:00.123456Z" }],
  ["absent", "ABSENT", { state: "absent" }],
  ["empty", "", { state: "unknown" }],
  ["malformed", "unreadable", { state: "unknown" }],
  ["missing birth", "PRESENT:", { state: "unknown" }],
] as const) {
  test(`C5 Windows fixture uses the production birth-query protocol for ${label}`, (t) => {
    let calls = 0;
    t.mock.method(childProcess, "execFileSync", (_file: string, _args: string[], options: { timeout: number }) => {
      calls++; assert.equal(options.timeout, 50); return output;
    });
    assert.deepEqual(inspectWindowsFixtureBirth(42, "windows", 50), expected);
    assert.equal(calls, 1);
  });
}

test("C5 Windows fixture birth query never promotes a tool failure or invalid target into absence", (t) => {
  let calls = 0;
  t.mock.method(childProcess, "execFileSync", () => { calls++; throw new Error("query unavailable"); });
  assert.deepEqual(inspectWindowsFixtureBirth(42, "windows"), { state: "unknown" });
  assert.deepEqual(inspectWindowsFixtureBirth(0, "windows"), { state: "unknown" });
  assert.deepEqual(inspectWindowsFixtureBirth(42, "posix"), { state: "unknown" });
  assert.equal(calls, 1);
});
