// Measures how fast command output moves through the production one-shot graph
// (grant -> runtime -> owned-process backend -> bounded output). Not a test; run by hand:
//   npx tsx runner-v2/scripts/measure-output-throughput.mts [MiB ...]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProductionOneShotCommandFixture } from "../test/support/one-shot-command-executor.js";

const sizes = process.argv.slice(2).map(Number).filter((value) => Number.isFinite(value) && value > 0);
const timeoutMs = Number(process.env.MEASURE_TIMEOUT_MS ?? 120_000);
const fixture = createProductionOneShotCommandFixture();
const workspace = mkdtempSync(join(tmpdir(), "aiboard-throughput-"));
try {
  for (const [index, mebibytes] of (sizes.length > 0 ? sizes : [1, 16, 64]).entries()) {
    const bytes = Math.round(mebibytes * 1024 * 1024);
    const script = `const b=Buffer.alloc(1024*1024,120);let n=${bytes};function w(){while(n>0){const c=b.subarray(0,Math.min(n,b.length));n-=c.length;if(!process.stdout.write(c)){process.stdout.once('drain',w);return;}}}w();`;
    const started = Date.now();
    const result = await fixture.internalExecution.execute({
      executable: process.execPath,
      arguments: ["-e", script],
      workingDirectory: workspace,
      timeoutMs,
      context: {
        runId: "run_throughput",
        sessionId: "session_throughput",
        actor: { role: "worker", id: "worker_throughput" },
        callId: `call_${index}`,
        toolName: "process.run",
      },
    });
    const seconds = (Date.now() - started) / 1000;
    const stdout = result.process.output.find((entry) => entry.stream === "stdout");
    console.log(JSON.stringify({
      mebibytes,
      seconds,
      mibPerSecond: Number((mebibytes / seconds).toFixed(2)),
      outcome: result.process.outcome,
      exitCode: result.process.exitCode,
      stdoutBytes: stdout?.totalBytes,
    }));
  }
} finally {
  await fixture.close();
  rmSync(workspace, { recursive: true, force: true });
}
