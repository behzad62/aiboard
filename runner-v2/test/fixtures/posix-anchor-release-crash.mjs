// A POSIX anchor child that really dies right after its durable C1 claim. A fault thrown inside the
// claiming process is not a crash: the owned fence lock releases a claimed holder whose effect never
// started. Only a process that is gone leaves its holder row behind for C1 reclamation.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import vm from "node:vm";

import { isExactPosixAnchorRelease } from "../../src/portable-process-posix-control.mjs";
import { runPortableFenceEffectSync } from "../../src/portable-process-protocol.mjs";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { childFunctions, config, expectedSupervisor, workloadGroup, childPid, claimedPath } = spec;
const context = vm.createContext({
  Error,
  JSON,
  config,
  expectedSupervisor,
  workloadGroup,
  // The anchor's own identity as the production child sees it: process.pid and the group leader's birth.
  process: { pid: childPid },
  readFileSync,
  writeFileSync,
  renameSync: (from, to) => { renameSync(from, to); },
  inspectPosixProcessIdentity: (pid) => pid === expectedSupervisor.supervisorPid
    ? { state: "present", value: { pid, groupId: pid, birth: expectedSupervisor.supervisorBirth } }
    : { state: "absent" },
  isExactPosixAnchorRelease,
  runPortableFenceEffectSync: (options) => runPortableFenceEffectSync({
    ...options,
    lockOptions: {
      ...options.lockOptions,
      afterClaim: () => {
        writeFileSync(claimedPath, "claimed");
        process.kill(process.pid, "SIGKILL");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);
        throw new Error("SIGKILL did not end the anchor child at the claim boundary");
      },
    },
  }),
});
vm.runInContext(childFunctions, context);
const released = vm.runInContext("consumeExactPosixAnchorRelease(workloadGroup, expectedSupervisor)", context);
process.stdout.write(JSON.stringify({ released }));
