// Child entry for runStorePwshEndToEnd (packaged-member-e2e.ts): args <root> <storePwsh> <fault> <resultFile>. It writes
// the observations to resultFile and then stays up, since a run with a blocked record keeps its internal helper; the
// parent test retires this process tree by its own PID.
import { writeFileSync } from "node:fs";

import type { WindowsJobInjectedLaunchFault } from "../../src/windows-job-process-host.js";
import { runStorePwshEndToEnd } from "./packaged-member-e2e.js";

const [root, storePwsh, fault, resultFile] = process.argv.slice(2);
const observed = await runStorePwshEndToEnd(root!, storePwsh!, fault as WindowsJobInjectedLaunchFault);
writeFileSync(resultFile!, JSON.stringify(observed));
