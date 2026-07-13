import assert from "node:assert/strict";
import test from "node:test";

import {
  MINIMUM_NODE_VERSION,
  assertSupportedNodeVersion,
  supportsNodeVersion,
} from "../src/node-version.js";

test("Runner accepts its minimum Node version and newer releases", () => {
  assert.equal(MINIMUM_NODE_VERSION, "24.18.0");
  assert.equal(supportsNodeVersion("24.18.0"), true);
  assert.equal(supportsNodeVersion("24.19.1"), true);
  assert.equal(supportsNodeVersion("25.0.0"), true);
  assert.doesNotThrow(() => assertSupportedNodeVersion("26.3.0"));
});

test("Runner rejects older and malformed Node versions", () => {
  assert.equal(supportsNodeVersion("24.17.9"), false);
  assert.equal(supportsNodeVersion("22.15.0"), false);
  assert.equal(supportsNodeVersion("not-a-version"), false);
  assert.throws(
    () => assertSupportedNodeVersion("23.9.0"),
    /requires Node\.js 24\.18\.0 or newer; received 23\.9\.0/
  );
});
