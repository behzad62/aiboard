import { access, mkdir } from "node:fs/promises";

import { createExecutionGrantAuthority } from "../../src/execution-grants.js";
import {
  createExecutionIsolationRegistry,
  createExecutionIsolationSelector,
} from "../../src/execution-isolation-provider.js";

const [statePath, workspace, barrier, writer, countText] = process.argv.slice(2);
if (!statePath || !workspace || !barrier || !writer) throw new Error("missing fixture argument");
await mkdir(workspace, { recursive: true });
while (true) {
  try { await access(barrier); break; }
  catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
}
const authority = createExecutionGrantAuthority();
const selector = createExecutionIsolationSelector(createExecutionIsolationRegistry([]), { statePath });
const count = countText === undefined ? 20 : Number(countText);
if (!Number.isSafeInteger(count) || count < 1 || count > 2_000) throw new Error("invalid fixture count");
for (let index = 0; index < count; index += 1) {
  const binding = {
    runId: `run-${writer}`, sessionId: `session-${writer}`,
    actor: { role: "worker" as const, id: `worker-${writer}` },
    toolName: "process.run", callId: `call-${writer}-${index}`, permissionProfile: "full" as const,
  };
  const opaque = await authority.issue({
    ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
    externalApproved: false, destructiveApproved: false, networkApproved: false,
  });
  const grant = authority.consume(opaque, binding);
  await selector.acquire({
    permissionProfile: "full", grant,
    intent: {
      invocationId: `invocation-${writer}-${index}`, runId: binding.runId, taskId: "task",
      sessionId: binding.sessionId, kind: "command", executable: "node", arguments: [],
      workingDirectory: workspace, requestedCapabilities: [],
    },
  });
}
