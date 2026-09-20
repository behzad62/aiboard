import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createRealStreamingHarness } from "../support/real-streaming-harness.js";

const [stateDirectory, projectDirectory, keyPath, leaseReleaseMarker] = process.argv.slice(2);
if (!stateDirectory || !projectDirectory || !keyPath || !leaseReleaseMarker) {
  throw new Error("Streaming crash fixture arguments are missing.");
}
const childScript = fileURLToPath(new URL("./persistent-stream-child.mjs", import.meta.url));
const harness = await createRealStreamingHarness({
  stateDirectory,
  projectDirectory,
  integrityKey: new Uint8Array(await readFile(keyPath)),
  leaseReleaseMarker,
  childScript,
  adoptionFault: (point) => {
    if (point === "before_session_insert") process.exit(86);
  },
});
await harness.crashOpen();
process.exit(87);
