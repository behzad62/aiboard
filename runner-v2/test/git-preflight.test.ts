import assert from "node:assert/strict";
import test from "node:test";

import { checkGit } from "../src/git-preflight.js";

test("Git preflight reports missing Git without trying to install it", async () => {
  assert.deepEqual(
    await checkGit(async () => ({
      exitCode: 127,
      stdout: "",
      stderr: "not found",
    })),
    {
      available: false,
      version: null,
      code: "git_missing",
      reason: "Git is required for Build V2.",
    }
  );
});

test("Git preflight parses Windows versions and enforces the minimum", async () => {
  assert.deepEqual(
    await checkGit(async () => ({
      exitCode: 0,
      stdout: "git version 2.45.1.windows.1\n",
      stderr: "",
    })),
    {
      available: true,
      version: "2.45.1.windows.1",
      code: "git_ready",
      reason: null,
    }
  );

  assert.deepEqual(
    await checkGit(
      async () => ({
        exitCode: 0,
        stdout: "git version 2.38.4",
        stderr: "",
      }),
      { minimumVersion: "2.39.0" }
    ),
    {
      available: false,
      version: "2.38.4",
      code: "git_too_old",
      reason: "Git 2.39.0 or newer is required for Build V2.",
    }
  );
});

test("Git preflight treats malformed successful output as unavailable", async () => {
  const result = await checkGit(async () => ({
    exitCode: 0,
    stdout: "unexpected",
    stderr: "",
  }));
  assert.equal(result.available, false);
  assert.equal(result.code, "git_missing");
});
