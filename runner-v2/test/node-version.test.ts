import assert from "node:assert/strict";
import test from "node:test";

import {
  SUPPORTED_NODE_LTS_LINES,
  assertSupportedNodeVersion,
  supportsNodeVersion,
} from "../src/node-version.js";

test("Runner accepts only the certified Node 24 LTS line", () => {
  assert.deepEqual(SUPPORTED_NODE_LTS_LINES, [24]);
  assert.equal(supportsNodeVersion("24.0.0"), true);
  assert.equal(supportsNodeVersion("24.18.0"), true);
  assert.doesNotThrow(() => assertSupportedNodeVersion("24.20.0"));
});

test("Runner rejects Node 22, unsupported lines, and malformed versions", () => {
  assert.equal(supportsNodeVersion("22.13.0"), false);
  assert.equal(supportsNodeVersion("22.18.0"), false);
  assert.equal(supportsNodeVersion("20.19.0"), false);
  assert.equal(supportsNodeVersion("23.0.0"), false);
  assert.equal(supportsNodeVersion("25.0.0"), false);
  assert.equal(supportsNodeVersion("26.0.0"), false);
  assert.equal(supportsNodeVersion("not-a-version"), false);
  assert.equal(supportsNodeVersion("v24.0.0"), false);
  assert.equal(supportsNodeVersion("24.0"), false);
  assert.throws(
    () => assertSupportedNodeVersion("22.18.0"),
    /certified Node\.js 24\.x LTS release line.*Received 22\.18\.0/
  );
});
