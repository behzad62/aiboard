import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const markerPath = process.argv[2];
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
if (!descendant.pid) throw new Error("Git tree fixture descendant has no PID.");
descendant.unref();
writeFileSync(markerPath, JSON.stringify({ rootPid: process.pid, descendantPid: descendant.pid }), {
  flag: "wx",
});
setInterval(() => {}, 1_000);
