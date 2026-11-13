# POSIX: a descendant that detaches from the owned process group

2026-11-13 · Design note for the follow-up from the VF7a spike (`playwright-cli-spike-2026-11-13.md` §4, §7.1).

## 1. The gap

On Linux and macOS the native backend (`posix-process-backend.ts`) owns one process group. The supervisor starts an anchor with `detached: true`, so the anchor leads a new session and group, and the workload runs inside that group. A call or task ends when the group is empty. `tree_termination` and `verified_emptiness` are enforced **for that group** (`lifecycleScope: "process_group"`, `crash_cleanup: "unavailable"`).

A descendant that calls `setsid` (Node's `spawn(..., { detached: true })`, a daemonizing double fork, Playwright's Chrome launch) leaves the group and the session. One that calls only `setpgid` (a job-control shell, `set -m`) leaves the group but stays in the session. Either way, the Runner neither waits for it nor stops it at the end of its `process.run` call, its managed process or its task.

The escape is silent only if the leaver does not hold the workload's output. POSIX retirement also waits for stdout and stderr to reach EOF (`portable-process-supervisor.mjs:372-379`). A leaver that kept those pipes therefore keeps the stop from verifying, as an output-settlement failure (DECISION §8). A leaver with redirected or closed output (`stdio: "ignore"`, a daemon's `/dev/null`) is not seen at all.

The managed-process stop says "The process and every process it started have exited, so any port it listened on is closed. No further check is needed." (`managed-process-tools.ts:523` before this change). Under a Windows Job, or an OCI container, the backend proves that. Under a process-group backend (native POSIX, and the Windows fallback without a Job, `windows-process-backend.ts:53`) only the group is proven, so the sentence claims more than the Runner knows. The port clause fails as well: a classic daemon (bind, fork, setsid, no exec) inherits the listening socket, so the group's exit closes nothing.

### Reproduction

`runner-v2/test/posix-detached-escape.test.ts` is the spike's `control-detached` scenario, run through the real local-MCP composition (`LocalMcpSessions` + `createExecutionHost`, full profile, native backend). A Node script spawns a child with `detached: true, stdio: "ignore"`. The child writes its PID and sleeps 30 s.

Linux, `node:24-bookworm` in Docker, before any change (§6 has the commands):

```
process_run returned in 4733 ms; detached child 610 (pgid 610, sid 610) still running
process_signal stopped cfb1931a-…; detached child 676 still running
confirmed: The process and every process it started have exited, so any port it listened on is closed. No further check is needed.
```

Both the call and the managed stop end while the child keeps running in its own session and group, and the stop claims the whole tree. This matches the spike's Linux control (§4: "detached child alive after the call returned: true"). The fixture then kills its own child (§4).

Host facts from the same container, used in §3: `/proc/self/cgroup` is `0::/`; `/sys/fs/cgroup` is cgroup2 mounted `ro,nosuid,nodev,noexec,relatime,nsdelegate`; `systemd-run` is absent; `unshare --user --pid --fork --map-root-user true` fails with "Operation not permitted"; `python3` happens to be present in this Debian image, but nothing guarantees an interpreter on every host.

## 2. Constraints

- **No native binary.** No signing certificate, so no addon, no helper executable, nothing precompiled.
- **Standing rules.** Never weaken fail-closed ownership or fencing. Never raise a timeout to get a pass. Any change to process ownership gets an independent review.
- **The adopted 2026-09-19 decision** (`architecture-reassessment-2026-09-19/DECISION.md`), applied in `security.md:30` and pinned by `posix-process-backend.test.ts` ("never reconstructs ownership from PPID ancestry"). It already reviewed and removed a PPID/escaped-descendant signalling experiment from this supervisor. Its rules for native escape (§8):
  1. "Do not add continuous host-tree enumeration. Absence of an observed escape is never proof none occurred."
  2. PPID alone does not establish cleanup authority.
  3. "Do not introduce a generic per-PID escape killer."
  4. "Group empty" must never be displayed as "all descendants terminated."
  5. A tool that must daemonize uses its foreground mode, an external-service lease, or a contained provider.
- **Not on the critical path:** a cgroup service or a macOS containment subsystem (DECISION §14.8).

## 3. Options

### A. Descendant census by PID and birth, with session and group tracking

Each supervisor tick lists processes (`/proc` on Linux, `ps -A -o pid,ppid,pgid,lstart` on macOS). The supervisor records any process it can tie to an owned process, then stops recorded processes by PID plus birth when the workload stops.

Rules that are exact at the moment they are observed (Linux):
- **Parent.** Q's ppid is P, and P is a recorded owned process with the same birth. Read Q, then P, then Q again. If the second read of Q shows the same birth and still ppid P, then P was Q's live parent throughout, because an orphan is only ever re-parented to a reaper.
- **Session.** Q's sid is S, and the process with pid S is alive, has the recorded birth of an owned process, and leads session S. Every member of a session descends from its leader. The sid number cannot be reused while the session has members.

Where it fails:
- **The common case is a race it loses.** `detached: true` calls `setsid` in the child before `exec`. A parent that spawns and exits right away, like the spike's control and most CLI launchers, is gone within milliseconds. The child is re-parented to init (ppid 1) and leads its own session before a 25 ms poll sees it. After that, no kernel fact links it to the workload. Chrome's crashpad handlers double-fork the same way (spike §3: `1821 (sid 1820, ppid 1)`).
- **Catching that case needs a non-kernel marker.** For example, an unguessable per-workload variable that the census looks for in `/proc/<pid>/environ`. That attributes by content, not by identity. It is lost by any `env -i` or sanitizing launcher, and it has no reliable form on macOS: `ps -E` shows the environments of the user's processes, but not in a parseable form, and `lstart` is a one-second timestamp, which DECISION §5 already rejects as a process handle.
- It is continuous host-wide enumeration plus a generic per-PID escape killer, which is exactly DECISION §8.1 and §8.3. It still cannot prove that nothing escaped, so it could not make the stop sentence true either.

**Rejected.** A census narrows the gap but cannot close it, and it reverses an adopted, reviewed decision for a weaker guarantee than the one it would advertise.

### B. cgroup v2 where available

Run the workload in its own delegated cgroup: `systemd-run --user --scope`, or a subtree the Runner was delegated. `cgroup.procs` and `cgroup.events: populated` give exact membership and emptiness whatever `setsid` does, and `cgroup.kill` stops the whole subtree. It is the only Linux mechanism that really closes the gap without native code.

Limits:
- **Needs a delegated, writable subtree.** In `node:24-bookworm` under Docker, `/sys/fs/cgroup` is mounted `ro,nsdelegate`, there is no `systemd-run`, and the process is at `0::/`, so nothing is available. WSL without systemd, many CI images and most containers look the same. macOS has no cgroups.
- **It is a different lifecycle scope** (`contained_workload`, DECISION §4, §5). It needs its own backend or isolation-provider adapter: setup verification, a migration-rejection proof, durable identity of the cgroup, recovery after a Runner or supervisor crash, and qualification on every supported host. It cannot be a quiet fallback inside the group backend, because a request would then get different guarantees on different machines under the same name.
- DECISION §1 and §5 defer it as an optional adapter "until a concrete workload needs strong containment without OCI", and forbid making it a Linux prerequisite.

**Deferred.** This is the route if the owner wants POSIX containment for native full-access work. It is a project of its own (a backend, its qualification and recovery), not a patch to the group supervisor.

### C. A subreaper

`prctl(PR_SET_CHILD_SUBREAPER)` (Linux only) makes orphans re-parent to the anchor instead of init. Ancestry then stays a kernel fact: `ppid == anchor` with a verified anchor birth.

Limits:
- Node exposes no `prctl`. The routes are a native addon or a host interpreter that can make the system call: Python `ctypes`, or Perl's built-in `syscall()`, which needs no module. An addon is a native binary, so it is out. An interpreter ships no binary, but it depends on the host having one, needs per-architecture syscall numbers (Perl), and must run as the anchor itself, through an `exec` chain. That makes the interpreter part of the ownership path, which is an ownership change in its own right.
- `unshare --user --pid --fork` (a PID namespace whose init's death kills everything inside) needs unprivileged user namespaces. In the Docker image above it fails with "Operation not permitted". Ubuntu 24.04's AppArmor default restricts it too. It also changes the workload's uid: root with `-r`, or the overflow "nobody" without a mapping. Tools behave differently either way (Chrome refuses to sandbox as root).
- macOS has no equivalent.
- Even with a subreaper, stopping escapees is still per-PID signalling outside the group, so DECISION §8.3 applies.

**Rejected.** It is reachable only through a host interpreter inside the ownership path, and the namespace route is unavailable where it would be needed.

### D. A truthful confirmation (minimum)

Say on POSIX what the group backend proves, and what it does not cover, so a model knows a detached child is its own concern:

> The process and every process still in its process group have exited. A process that left the group (on POSIX: setsid, setpgid, or spawn with detached: true) is not covered by this stop and may still be running or holding a port.

It makes no port claim, and it drops "No further check is needed": a leaver may hold an inherited socket. A contained workload keeps today's sentence, because its boundary proves the whole tree.

**Chosen.** It is the only option that closes the misstatement without reversing DECISION §8. It is also what §8.4 asks for: never display "group empty" as "all descendants terminated."

## 4. The design

1. **The text follows the attested scope, not the OS** (DECISION §4: an OS name must not stand in for semantic evidence; §8: "Display the scope").
   - Every managed session's durable record carries the backend attestation's lifecycle scope (`StreamingSessionBackendBinding.lifecycle.scope`).
   - `execution-host-managed-transport.ts` copies it onto the live snapshot as `lifecycleScope`. `ManagedProcessService.signal` keeps it on the stop's answer. It is not written to the managed record, so persistence does not change.
   - `stopConfirmation(scope)` in `managed-process-tools.ts` gives `contained_workload` (a Windows Job, `windows-process-backend.ts:98`; OCI, `oci-execution-isolation-provider.ts:316`) today's sentence. `process_group`, or no scope at all (a legacy binding, a historical record), gets the scoped sentence.
2. **Nothing in the supervisor, the backend, the fence or ownership changes.** No process outside the owned group is inspected or signalled.
3. **`posix-detached-escape.test.ts`** has two parts:
   - A live, Linux-only test of about 9 s that pins the limitation for both `process.run` and `process.start`/`process.signal`: the call returns without waiting, the child leads its own session and group and survives, and the stop gives exactly the scoped sentence. Per DECISION §9, the fixture cleans up its own escaped child, only by the PID and `/proc` start time it first saw, whose command line names the test's marker file.
   - A unit test of `stopConfirmation`, run on every OS.
   - `client-process-results.test.ts`, which pinned the old sentence for every OS, now expects the scoped sentence off Windows. On Windows it accepts either sentence: it gets the full one only under a Job.

Known detaching workloads keep the routes DECISION §8.5 lists. The policy already sends `knownUnavoidableDetachment` and `requireCompleteCleanup` to `contained_workload` (`execution-lifecycle-policy.ts:44-53`):
- **Playwright's CLI** (VF7b): the daemon runs in the foreground as a managed process (spike §9.1). VF7b's narrow post-stop browser check (§9.6) is that workload's own exception, with its own independent review.
- **Anything else:** its foreground or no-daemon mode, or a contained provider.

## 5. Follow-ups and what would change this

- **Optional, needs its own review: a known-escape diagnostic** (DECISION §8.2–3). While members are in the group, the supervisor already records them by PID and birth (`posixRecordedMembers`, `portable-process-supervisor.mjs:338-348`). At stop, a recorded member that is alive with the same birth but in another group is a *known* escape, found with no enumeration. §8.3 says to record it and block automatic release until it ends, never to signal it. It catches daemons that call `setsid` or `setpgid` late; it never sees a child that was detached before `exec`, as in this test.
- **macOS is unverified.** No machine. The text change does not depend on the OS, and the live test runs only on Linux.


If the owner decides that native full-access POSIX work must leave no escaped descendants, DECISION §14.10 already gives the answer: amend the decision and provide real containment. The candidate is Option B, the cgroup v2 adapter, on Linux hosts with delegation. Elsewhere such work is refused for that requirement, and no census is added. That needs the owner's decision; it is not taken here.

## 6. Reviews and commands

- **Design review** (independent, before any product code): approved with changes. It asked for the text to be chosen by the recorded scope rather than `process.platform`; for no port claim under `process_group`; for `setpgid` to be named; for the output-pipe fact to be stated; for overstatements about `ps -E`, Perl and `unshare` to be corrected; for the parent rule's birth condition; for birth in the fixture's cleanup; and for the §8.2 diagnostic to be listed as a follow-up. All are applied above.


```bash
git archive --format=tar -o <scratch>/docker/repo.tar HEAD
docker run -d --name posix-escape --init -v <scratch>/docker:/mnt/x node:24-bookworm sleep infinity
docker exec posix-escape bash -c "mkdir -p /repo && tar -xf /mnt/x/repo.tar -C /repo && chown -R node:node /repo"
docker exec -u node -w /repo posix-escape npm ci --ignore-scripts
docker cp runner-v2/test/posix-detached-escape.test.ts posix-escape:/repo/runner-v2/test/
docker exec -u node -w /repo posix-escape npx tsx --test runner-v2/test/posix-detached-escape.test.ts
```

After the change, the same test passes in Docker in about 9 s (`process_run returned in 2508 ms`, both children still running and then killed by the fixture, no sleeper left).

In Git Bash, prefix `docker exec` with `MSYS_NO_PATHCONV=1`. The "before" run above used the same test without its three `confirmed` assertions, which today's text fails as expected ("actual: 'The process and every process it started have exited…'").
