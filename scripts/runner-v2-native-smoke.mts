import assert from "node:assert/strict";

import { createPosixProcessBackend } from "../runner-v2/src/posix-process-backend.js";
import { createWindowsProcessBackend } from "../runner-v2/src/windows-process-backend.js";

const backend = process.platform === "win32"
  ? createWindowsProcessBackend({ jobObjects: "unavailable" })
  : createPosixProcessBackend();
const probe = await backend.probe() as {
  backendId: string;
  platformLabel: string;
  capabilities: Record<string, string>;
};

if (process.platform === "win32") {
  assert.equal(probe.backendId, "runner-windows-supervisor-v1");
  assert.equal(probe.platformLabel, "windows");
} else {
  assert.equal(probe.backendId, "runner-posix-process-group-v1");
  assert.equal(probe.platformLabel, "posix");
}
assert.ok(probe.capabilities.tree_termination, "native adapter probe must publish tree-termination capability semantics");
console.log(`Runner V2 native adapter probe passed on ${process.platform}: ${probe.backendId}`);
