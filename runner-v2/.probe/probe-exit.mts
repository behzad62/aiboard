import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWindowsJobProcessHost } from "../src/windows-job-process-host.js";
const state = mkdtempSync(join(tmpdir(), "probe-exit-"));
const host = createWindowsJobProcessHost({ stateDirectory: state, injectedLaunchFault: "host_exit_after_create" });
const t0 = Date.now();
try {
  await host.launchOwned({ runId: "r", sessionId: "s", command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"], workingDirectory: process.cwd(), environment: { ...process.env } as Record<string, string>, interactive: true });
} catch (e) { console.log("ERR at", Date.now() - t0, (e as Error).message); }
for (const d of readdirSync(state, { withFileTypes: true })) if (d.isDirectory()) {
  for (const f of ["supervisor.jsonl", "job-events.jsonl"]) {
    try { console.log(`--- ${f}\n` + readFileSync(join(state, d.name, f), "utf8").split(/\r?\n/).map((l) => l.replace(/"protocol":"[^"]*","processId":"[^"]*",/, "").replace(/"retained.*$/, "")).join("\n")); } catch {}
  }
}
process.exit(0);
