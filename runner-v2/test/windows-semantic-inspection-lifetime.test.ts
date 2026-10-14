import assert from "node:assert/strict";
import test from "node:test";

import { createWindowsProcessSemanticProbeSource } from "../src/windows-process-semantic-probes.js";

test("Windows semantic probes require creator cleanup registration before admission", async () => {
  const source = createWindowsProcessSemanticProbeSource();
  await assert.rejects(source.portableDuplex(), /cleanup must be registered before admission/);
});

test("closing the semantic creator rejects queued and later probes before admission", async () => {
  let close!: () => Promise<void>;
  const source = createWindowsProcessSemanticProbeSource({ registerCleanup: (cleanup) => { close = cleanup; } });
  assert.equal(typeof close, "function", "the creator must own cleanup before receiving the source");
  const queued = assert.rejects(source.portableDuplex(), /source is closed/);
  await close();
  await queued;
  await assert.rejects(source.exactTreeBirth(), /source is closed/);
});
