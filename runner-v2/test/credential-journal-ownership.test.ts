import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareCredentialStores } from "../src/credential-migration.js";

for (const resumed of [false, true]) {
  test(`credential migration retains a changed journal (resumed: ${resumed})`, () => {
    const root = mkdtempSync(join(tmpdir(), "journal-owner-"));
    try {
      if (resumed) {
        assert.throws(() => prepareCredentialStores({ stateDirectory: root, onStep: (step) => {
          if (step === "commit-verified") throw new Error("interrupt");
        } }), /interrupt/);
      }
      const journal = join(root, "credential-migration.json");
      assert.throws(() => prepareCredentialStores({ stateDirectory: root, onStep: (step) => {
        if (step === "commit-verified") writeFileSync(journal, "replacement");
      } }));
      assert.equal(readFileSync(journal, "utf8"), "replacement");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
