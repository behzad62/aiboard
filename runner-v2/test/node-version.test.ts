import assert from "node:assert/strict";
import test from "node:test";

import {
  NODE_SQLITE_MINIMUM_VERSION,
  SUPPORTED_NODE_LTS_LINES,
  assertSupportedNodeVersion,
  supportsNodeVersion,
} from "../src/node-version.js";

test("Runner accepts both maintained LTS lines with the node:sqlite capability floor", () => {
  assert.deepEqual(SUPPORTED_NODE_LTS_LINES, [22, 24]);
  assert.equal(NODE_SQLITE_MINIMUM_VERSION, "22.13.0");
  assert.equal(supportsNodeVersion("22.13.0"), true);
  assert.equal(supportsNodeVersion("22.18.0"), true);
  assert.equal(supportsNodeVersion("24.0.0"), true);
  assert.equal(supportsNodeVersion("24.18.0"), true);
  assert.doesNotThrow(() => assertSupportedNodeVersion("24.20.0"));
});

test("Runner rejects EOL, Current, below-floor, and malformed Node versions", () => {
  assert.equal(supportsNodeVersion("22.12.9"), false);
  assert.equal(supportsNodeVersion("20.19.0"), false);
  assert.equal(supportsNodeVersion("23.0.0"), false);
  assert.equal(supportsNodeVersion("25.0.0"), false);
  assert.equal(supportsNodeVersion("26.0.0"), false);
  assert.equal(supportsNodeVersion("not-a-version"), false);
  assert.equal(supportsNodeVersion("v24.0.0"), false);
  assert.equal(supportsNodeVersion("24.0"), false);
  assert.throws(
    () => assertSupportedNodeVersion("23.9.0"),
    /maintained LTS release lines.*22\.x.*24\.x.*Received 23\.9\.0/
  );
});
