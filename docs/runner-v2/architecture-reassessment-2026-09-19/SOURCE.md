# Runner V2 — Architecture Reassessment Before Further Implementation

I need you to act as a senior systems/software architect and independently reassess a process-execution design that has become increasingly complex during cross-platform qualification.

Do **not** assume the current architecture is correct just because significant implementation work already exists.

The goal of this review is to determine the simplest architecture that satisfies the **real requirements of Runner V2**, without spending another 100+ hours fixing pathological cases that are irrelevant to normal operation.

I want you to distinguish carefully between:

1. genuine product requirements,
2. realistic operational edge cases,
3. security requirements,
4. recovery requirements,
5. qualification/test artifacts,
6. adversarial/pathological scenarios that we may be overengineering around.

Your job is to challenge our assumptions and recommend the architecture we should actually finish.

---

# 1. Project Context

The project is **AIBoard Runner V2**, an execution subsystem for an AI coding harness.

Runner V2 executes work on behalf of coding agents, including things such as:

* one-shot shell/tool commands,
* `npm`, `node`, `git`, compilers, test runners, etc.,
* long-running managed processes,
* language servers,
* MCP servers,
* potentially Docker/OCI-isolated workloads.

The system has strong requirements around:

* durable task/process state,
* crash recovery,
* exact ownership,
* fencing,
* stale-owner protection,
* cleanup,
* output preservation,
* bounded execution,
* avoiding duplicate/replayed effects,
* cross-platform operation on Windows/Linux/macOS.

The architecture already has several useful concepts:

* backend capability negotiation,
* Windows Job Object support,
* generic POSIX process backend,
* OCI isolation provider,
* durable process records,
* execution grants,
* fencing tokens,
* PID/process birth identity,
* output settlement,
* recovery state,
* native-process qualification.

Do not assume all of these need to be removed. A major goal is to preserve the good parts while eliminating unnecessary complexity.

---

# 2. Where We Are

Task 12 / Runner V2 has gone through multiple implementation gates.

Gates A–F were already substantially completed.

Gate G is final cross-platform/native/CI qualification.

During Gate G we repeatedly found failures that initially looked like product bugs but were often:

* GitHub-hosted-runner timing problems,
* outer test timeout problems,
* stale test fixtures,
* Windows process-inspection latency,
* tests using old fencing assumptions,
* real-host tests running concurrently and interfering with each other,
* qualification tests being treated as mandatory deterministic PR tests,
* host-specific behavior incorrectly generalized across all OSes.

We consequently split CI into:

## Required PR CI

Fast/deterministic correctness checks:

* Windows
* Linux
* macOS
* Node 24 only
* package parity
* deterministic process contracts
* native adapter probe
* portable deterministic behavior
* cross-host reproducibility

## Qualification CI

Manual/nightly/label-triggered real-host qualification:

* lifecycle timing
* recovery
* real native process behavior
* Docker/OCI
* Windows native lifecycle
* macOS native lifecycle
* MCP/LSP lifecycle
* stress/race-sensitive cases

This CI split appears correct and should probably remain.

---

# 3. Important Bugs/Problems We Found

We encountered many failures, but they were not all the same class.

Examples:

## A. Genuine product issue

Portable output polling was re-attesting synchronous process birth too aggressively.

A transient macOS process-inspection uncertainty could poison an otherwise healthy output channel as `outcome_unknown`.

We changed output polling so it re-attests the durable fence rather than unnecessarily requiring synchronous process-birth verification on every output poll.

That was a genuine semantic correction.

---

## B. CI/test-harness problems

We found many tests where:

* the product itself legitimately has a 15–30 second bounded operation,
* but the outer test also had a 30-second timeout.

On a slow GitHub Windows/macOS host the test runner killed the test at exactly the product's legal boundary.

These tests needed larger **test-only outer guards**, not larger product timeouts.

We do not want to solve host slowness by weakening product deadlines.

---

## C. Stale fixtures

Several tests manually wrote old forms of:

* `fence.json`
* `lock-holder.json`

without creating the newer durable SQLite-backed fence authority.

The product correctly failed closed.

The fixture was wrong.

Similar stale-fixture problems occurred elsewhere.

---

## D. Qualification concurrency

Some real Docker/native tests were being run simultaneously.

They involve:

* process creation,
* cleanup,
* Docker,
* host process enumeration,
* timing-sensitive lifecycle operations.

Serial execution materially changes their reliability.

This appears to be qualification infrastructure behavior rather than necessarily product behavior.

---

# 4. The Major Architectural Problem We Just Found

A real Docker/Linux MCP lifecycle test revealed the following scenario.

An MCP server launched a child like this:

```js
spawn(..., {
    detached: true
})
```

On POSIX, this creates a new session/process group.

The hierarchy became approximately:

```text
Runner V2
    |
POSIX workload process group
    |
MCP server
    |
    +---- detached child
              |
              +-- new session / new PGID
```

When the MCP server exits or is terminated, the detached child can become:

```text
PID 1
  |
detached child
```

It is no longer part of Runner V2's original process group.

Our POSIX backend currently uses process-group ownership and advertises:

```text
tree_termination = enforced
verified_emptiness = enforced
```

That claim is questionable.

A POSIX process group does **not** guarantee containment of a process that deliberately calls:

* `setsid()`,
* changes process group/session,
* daemonizes,
* double-forks,
* intentionally detaches.

---

# 5. Where the Complexity Started Exploding

To preserve the existing claim of arbitrary tree termination, we started moving toward logic such as:

```text
Launch process
    |
Track PGID
    |
Track PID
    |
Track birth identity
    |
Enumerate process tree
    |
Track PPID
    |
Detect descendants
    |
Detect descendants changing PGID
    |
Birth-attest escaped descendants
    |
Track them separately
    |
Handle parent exit
    |
Handle reparenting to PID 1
    |
Handle PID reuse
    |
Re-attest before signaling
    |
Signal exact descendants
    |
Verify disappearance
    |
Handle inspection races
    |
Retry under fencing
```

This started looking like we were attempting to make a POSIX process group behave like a container.

Before continuing down this road, I want an architectural reassessment.

---

# 6. Important Question: Is the Detached-Descendant Scenario Actually a Core Requirement?

This is the key question.

Runner V2 primarily exists to support AI coding work.

Typical real workloads include:

```text
npm test
  ├─ node worker
  ├─ node worker
  └─ compiler

dotnet test
  ├─ dotnet
  └─ testhost

language server
  ├─ server
  └─ helpers

git
compiler
eslint
typescript
pytest
build tools
dev servers
```

Most normal subprocesses remain in their inherited process group/session.

However, some tools can legitimately:

* daemonize,
* detach,
* spawn background services,
* start long-lived helper processes.

The existing old Runner also uses `detached: true` in some internal places, so detached processes are not purely hypothetical.

But there is an important distinction between:

> Runner V2 itself intentionally creating a detached supervisor

and:

> arbitrary child software being allowed to escape Runner V2's containment boundary while Runner V2 still promises complete tree termination.

Please analyze this distinction carefully.

---

# 7. Current Capability Usage

Another important issue:

Runner V2 currently requests:

```text
tree_termination
verified_emptiness
```

for almost every execution family:

* one-shot commands,
* arbitrary managed commands,
* MCP servers,
* LSP servers.

Therefore the POSIX backend is being asked to satisfy the strongest lifecycle contract even for ordinary commands.

This may itself be a design mistake.

The capability model may be insufficiently precise.

---

# 8. Proposed Direction We Are Considering

Our current hypothesis is:

## Keep Windows Job Objects

Windows Job Objects are real OS containment.

They naturally support strong process-tree lifecycle control.

So Windows can plausibly advertise:

```text
tree_termination = enforced
verified_emptiness = enforced
```

---

## Keep POSIX process groups for normal native execution

Process groups are simple and appropriate for cooperative/normal child trees.

They work for the vast majority of ordinary developer tools.

But perhaps the backend should **not claim arbitrary process-tree containment**.

Its guarantee might be closer to:

```text
process_group_termination = enforced
group_emptiness = enforced
arbitrary_descendant_escape_containment = unavailable
```

or an equivalent capability model.

Do not assume these exact capability names are correct; refine them.

---

## Use stronger isolation only when genuinely required

If an execution genuinely requires:

```text
a child must not be able to escape the lifecycle boundary
```

then use an actual containment primitive.

Possible mechanisms:

### Windows

Job Object.

### Linux

Potentially:

* cgroup v2,
* OCI container,
* another kernel-backed isolation mechanism.

### macOS

Generic process groups cannot provide equivalent strict containment.

Strong isolation may require:

* container/VM,
* another macOS-specific provider,
* or explicitly reporting the capability unavailable.

### Cross-platform

OCI/VM provider.

---

# 9. Alternative We Are Considering

Instead of making cgroups mandatory for Linux native execution, perhaps have several explicit backends:

```text
runner-windows-job-v1
runner-posix-process-group-v1
runner-linux-cgroup-v1
runner-oci-v1
```

Then Runner V2 selects a backend according to the actual requested capabilities.

For example:

```text
ordinary coding command
        |
        v
POSIX process-group backend
```

but:

```text
execution requiring strict containment
        |
        v
cgroup / Job Object / OCI provider
```

This seems preferable to making every ordinary command pay for maximum isolation.

Please evaluate this critically.

---

# 10. Security Boundary Question

Please explicitly decide what the native process backend's threat model should be.

Possible interpretations:

### Model A — Cooperative workload

The launched command is trusted/normal software.

Runner needs to:

* stop it,
* stop normal children,
* avoid leaks during crashes,
* recover safely.

It is not expected to deliberately evade containment.

### Model B — Potentially buggy workload

The program may accidentally:

* daemonize,
* detach,
* leave helpers behind.

Runner should attempt to clean these up but may report an inability to certify cleanup.

### Model C — Adversarial workload

The process may intentionally attempt to evade Runner:

* setsid,
* double fork,
* PID namespace tricks,
* spawning detached descendants,
* racing inspection.

If Runner V2 truly needs to defend against this, a process group is not an adequate containment boundary.

Please determine which of these threat models Runner V2 actually needs in each permission/isolation mode.

Do not silently apply Model C to everything.

---

# 11. Requirements That Must Be Preserved

Any simplification must not casually remove valuable guarantees.

We still need appropriate protection against:

## Crash/restart

Runner may terminate while owned processes are still alive.

Recovery must not blindly kill a recycled PID belonging to somebody else.

PID birth/fingerprint protection may still be valuable here.

---

## Stale control

An old Runner instance must not control a process after ownership has changed.

Fencing still appears important.

---

## Duplicate effects

Recovery must not replay uncertain destructive operations.

---

## Output durability

Process output settlement and retained delivery must remain correct.

---

## Exact ownership

Runner must not kill unrelated host processes merely because a PID or PGID happens to match stale state.

---

## Cleanup honesty

If cleanup cannot actually be proven, Runner should report:

```text
cleanup_blocked
outcome_unknown
capability unavailable
```

rather than invent success.

---

# 12. What I Want You to Determine

Please perform an architecture review and answer these questions.

## A. Are we actually overengineering the native POSIX backend?

Specifically, should it be responsible for chasing arbitrary detached descendants?

---

## B. Which scenarios are realistic enough that Runner V2 must support them?

Classify scenarios into something like:

* common and mandatory,
* uncommon but legitimate,
* recovery-only,
* adversarial/security,
* pathological and not worth supporting in native mode.

Include examples.

---

## C. What exactly should `tree_termination` mean?

Our current name may be too broad.

Define precise semantics.

For example, distinguish:

* process termination,
* process-group termination,
* normal descendant termination,
* containment,
* inability to escape,
* verified emptiness.

Do not let vague terminology recreate the same problem later.

---

## D. Should capabilities be decomposed?

For example:

```text
group_termination
descendant_tracking
strict_containment
verified_group_emptiness
verified_containment_emptiness
crash_cleanup
```

or some better design.

Recommend the **minimum useful capability set**.

Avoid capability explosion.

---

## E. What should each backend honestly advertise?

At minimum assess:

```text
Windows Job Object
Linux process group
macOS process group
Linux cgroup v2
OCI/container provider
```

Use explicit semantics.

---

## F. Should cgroup v2 be required, optional, or unnecessary?

Consider:

* Linux desktop environments,
* CI runners,
* permissions,
* user namespaces,
* rootless operation,
* portability,
* implementation cost.

Do not recommend cgroups merely because they are theoretically stronger.

---

## G. What should macOS do?

We need a realistic answer.

If macOS cannot provide strict native containment, should Runner:

* expose weaker native capabilities,
* automatically use another provider,
* reject executions requiring strict containment,
* or something else?

---

## H. What should MCP/LSP/managed-command execution require?

Should all of them require strict tree containment?

Or should their requirements differ?

For example, perhaps MCP server execution only needs cooperative tree cleanup in full/native mode but strict containment in a restricted security profile.

Analyze actual use.

---

## I. What happens when a process escapes a POSIX group?

Possible policies include:

1. Ignore it because escaping is outside the native contract.
2. Detect it best-effort and report incomplete cleanup.
3. Track it but never promise containment.
4. Refuse further release because verified emptiness cannot be proven.
5. Require stronger provider before launch for workloads that could escape.

Recommend an exact policy.

---

## J. Which existing mechanisms should stay?

Evaluate separately:

* fencing,
* birth identity,
* durable ownership store,
* process-group tracking,
* PPID tracking,
* continuous tree enumeration,
* output settlement,
* Job Objects,
* OCI provider,
* crash recovery.

Do not throw away useful mechanisms merely to simplify the design.

---

# 13. Assess Our Test Strategy Too

One cause of the current situation may be that tests are enforcing stronger semantics than the product actually needs.

Review the distinction between:

## Product correctness tests

Must correspond directly to supported contract.

## Qualification tests

Real-host timing/recovery tests.

## Adversarial containment tests

Should only be required for providers that claim strict containment.

Example:

A POSIX process-group backend probably should **not fail its release gate** merely because this test escapes the process group:

```js
spawn(..., { detached: true })
```

if its documented capability says arbitrary escape containment is unsupported.

But a cgroup/Job/OCI backend claiming strict containment absolutely should pass such a test.

Please design the appropriate test matrix.

---

# 14. Important Engineering Constraint

We want to avoid this development pattern:

```text
95% complete
  ↓
find obscure host failure
  ↓
add another inspection layer
  ↓
find race introduced by inspection
  ↓
add retry/fencing logic
  ↓
new CI timing failure
  ↓
increase fixture complexity
  ↓
find another OS-specific edge case
  ↓
repeat forever
```

Give us clear **complexity stopping rules**.

For example:

> If satisfying an edge case requires reconstructing a containment primitive that the OS does not provide, change the capability contract/provider instead of adding more heuristics.

Please formulate several rules like this.

---

# 15. Migration Concern

There is currently uncommitted experimental work attempting to solve escaped POSIX descendants using:

* PPID enumeration,
* escaped-descendant tracking,
* birth fingerprints,
* separate signaling,
* additional terminal verification.

Do not assume we should keep it.

Tell us whether to:

* discard it,
* keep a small useful subset,
* or finish it.

Explain why.

---

# 16. Deliverable I Want

Please produce a concrete architecture decision, not just observations.

Structure the result approximately as:

## 1. Executive conclusion

What architecture should we use?

## 2. Root cause of the current complexity

What assumption caused Gate G to expand?

## 3. Realistic workload/threat analysis

Which scenarios matter?

## 4. Correct execution capability model

Define exact semantics.

## 5. Backend matrix

For each OS/provider, state what it can honestly guarantee.

## 6. Execution-provider selection algorithm

Given an invocation and permission profile, how does Runner choose:

* Windows Job,
* POSIX group,
* cgroup,
* OCI,
* etc.?

## 7. Recovery model

What evidence remains necessary?

## 8. Cleanup semantics

Define exactly when Runner may say:

```text
released
cleanup_blocked
outcome_unknown
```

## 9. Testing/CI model

Which tests belong to:

* deterministic PR CI,
* qualification,
* strict containment provider tests.

## 10. What current code should be removed/simplified

Be explicit.

## 11. What current code should remain

Be explicit.

## 12. Migration plan

Give an ordered implementation plan from the current codebase to the recommended architecture.

Prefer small steps and avoid a large rewrite.

## 13. Acceptance criteria

Define what must be true before we can finally close Gate G.

## 14. Complexity budget / stopping rules

Tell future implementers when to stop patching and change the abstraction instead.

---

# 17. Important Review Behavior

Please challenge both possibilities:

### Possibility 1

Our current POSIX design is fundamentally too ambitious and should be simplified.

### Possibility 2

The strong tree guarantee is genuinely necessary, and we should therefore finish real containment rather than weaken the contract.

Do not choose one because I suggested it.

Evaluate both from first principles.

Also challenge the proposed Windows/Linux/macOS/OCI split if there is a better architecture.

---

# 18. Primary Goal

The goal is **not maximum theoretical safety at any cost**.

The goal is:

> The simplest architecture that gives Runner V2 correct, explicit, reliable guarantees for real AI coding workloads and fails honestly when a stronger guarantee is unavailable.

We care strongly about:

* robustness,
* maintainability,
* cross-platform behavior,
* clear contracts,
* crash recovery,
* security boundaries,
* avoiding process leaks,
* avoiding false claims of cleanup,
* and finishing this project without spending another enormous amount of time chasing increasingly artificial edge cases.

Please give a decisive recommendation and explain the tradeoffs.

Where the current requirements themselves are wrong or unnecessarily strong, say so directly.
