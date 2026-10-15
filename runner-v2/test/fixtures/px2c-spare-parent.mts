// PX-2c — parent-death fixture: prestart a spare pair, report it, then die
// WITHOUT retiring. The test's assertion is that the orphaned supervisor
// retires its unclaimed spare itself (parent-death rule) instead of leaking.
import { writeFileSync } from "node:fs";

import { createWindowsJobProcessHost } from "../../src/windows-job-process-host.js";

const [stateDirectory, runId, sessionId, outPath] = process.argv.slice(2);
if (!stateDirectory || !runId || !sessionId || !outPath) {
  throw new Error("px2c spare parent fixture arguments are missing.");
}

const host = createWindowsJobProcessHost({ stateDirectory });
const spare = await host.prestartSpare({ runId, sessionId });
writeFileSync(outPath, JSON.stringify(spare));
// Abrupt exit, like a crashed runner: no retireSpare, no close, no cleanup.
process.exit(0);
