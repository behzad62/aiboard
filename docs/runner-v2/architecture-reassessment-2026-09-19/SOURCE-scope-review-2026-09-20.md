You already produced:

`docs/runner-v2/architecture-reassessment-2026-09-19/DECISION.md`

and:

`docs/runner-v2/architecture-reassessment-2026-09-19/PLAN.md`

I reviewed the decision and broadly agree with its architectural direction.

Before we start implementation, I want one more review focused specifically on **scope control and implementation efficiency**.

The concern is not that the decision is wrong. The concern is that the migration plan may itself become another large project and recreate the exact problem the reassessment was meant to solve.

Please treat everything below as **suggestions and questions to evaluate**, not instructions that must be accepted.

Your task is to decide whether the current PLAN is appropriately scoped or whether it should be simplified.

---

# 1. Main concern

The architectural reassessment correctly identified that we were spending too much effort trying to make a POSIX process group behave like a containment primitive.

We want to avoid replacing that problem with another one:

```text
Fix one lifecycle abstraction
        ↓
version many contracts
        ↓
change many consumers
        ↓
revalidate every provider
        ↓
revisit historical schemas
        ↓
reopen old gates
        ↓
re-run enormous qualification campaigns
        ↓
another 100-hour migration
```

Some of those changes may genuinely be necessary.

But please determine which are actually required to correct the architecture and which are merely desirable cleanup.

The objective should remain:

> Make the smallest coherent architectural correction that gives Runner V2 honest lifecycle semantics and allows Gate G to converge.

---

# 2. Preserve the core decision unless new evidence contradicts it

The current decision appears strong:

* ordinary full/native POSIX execution uses a process-group lifecycle boundary;
* native POSIX does not claim arbitrary detached-descendant containment;
* Windows Job Objects provide a stronger lifecycle boundary;
* OCI provides contained-workload semantics;
* Linux cgroup v2 is deferred unless a concrete need appears;
* process backends and isolation providers remain distinct abstractions;
* fencing, durable ownership, recovery, output settlement, birth identity and fail-closed control remain;
* the experimental PPID/escaped-descendant reconstruction is likely removed.

Please challenge any of these if necessary, but do not redesign them merely for architectural elegance.

---

# 3. Possible simplification of the migration

One possible minimal migration might be approximately:

## Step A — Clarify lifecycle scope

Introduce or formalize the distinction between:

```text
process_group
```

and:

```text
contained_workload
```

The exact API shape is up to you.

The important property is that:

```text
verified emptiness
```

must always mean:

> empty within the lifecycle scope that was actually selected

rather than implicitly meaning:

> no descendant exists anywhere on the machine.

Please determine whether a full schema/version overhaul is necessary immediately, or whether this can be introduced safely with a smaller compatible amendment.

Do not sacrifice correctness for convenience, but do not version more structures than actually need semantic versioning.

---

# 4. Possible execution policy

Please evaluate a policy roughly like this:

```text
ordinary FULL/native execution
        ↓
requires process_group lifecycle
```

while:

```text
restricted execution
or
explicit requirement for complete contained cleanup
        ↓
requires contained_workload lifecycle
```

Potential provider mapping:

```text
POSIX process group
    → process_group

Windows Job Object
    → contained_workload

OCI provider
    → contained_workload

future Linux cgroup
    → possibly contained_workload
```

This is only a suggested model.

Refine it if there is a better one.

---

# 5. Avoid capability explosion

The earlier architecture almost became too complex because every implementation detail started looking like a capability.

Please prefer a small semantic contract over capabilities such as:

```text
ppid_tracking
birth_tracking
descendant_enumeration
group_tracking
escape_detection
```

Those sound more like implementation/evidence mechanisms than consumer-visible product guarantees.

A useful capability should answer a real consumer decision.

Please explicitly review the current proposed capability model with this principle.

---

# 6. Known escape handling

DECISION.md suggests that a known escaped process may block release, while theoretical unseen escapes should not block group-scoped release.

That seems reasonable.

However, there is a potential danger:

```text
known escape support
        ↓
requires finding escapes
        ↓
PPID scanning returns
        ↓
ancestry reconstruction returns
        ↓
we are back where we started
```

Please define **known escape** very narrowly.

One possible interpretation is:

> Runner has a concrete authenticated identity for that resource because it was explicitly registered/owned through an existing Runner execution relationship.

This would exclude:

> host-wide scanning found a PID that appears related.

Please determine whether this is the correct definition.

If supporting known escapes requires rebuilding generic ancestry discovery, consider whether native POSIX should simply treat those escapes as outside its lifecycle scope.

---

# 7. Windows fallback question

The historical design wanted:

* Job Objects optional,
* portable Windows native baseline still available.

The reassessment correctly questions whether sampled process enumeration can honestly claim the same containment semantics as a Job Object.

Please reassess this requirement pragmatically.

Possible options include:

### Option A

Preserve a weaker non-Job Windows execution mode with clearly weaker lifecycle guarantees.

### Option B

Require Job Objects for managed native lifecycle operations that require strong cleanup.

### Option C

Use another qualifying configured provider when Job Objects are unavailable.

### Option D

Something better.

Do not preserve a historical requirement merely because it exists if doing so creates major complexity with little real-world value.

At the same time, do not unnecessarily make Windows unusable.

---

# 8. MCP and LSP

Please specifically review whether these should inherently require contained-workload semantics.

My current intuition is:

```text
MCP/LSP protocol persistence
```

does not automatically imply:

```text
adversarial process containment
```

A normal MCP/LSP server under explicit full/native mode could plausibly use process-group lifecycle semantics.

Restricted execution could require containment.

But please validate this from the actual code and threat model.

Do not assign stronger lifecycle requirements merely because a process is long-lived.

---

# 9. Detached-child test

One of the tests currently effectively does:

```js
spawn(..., { detached: true })
```

and expects Runner to eliminate that descendant.

Please classify that test based on the provider actually used.

Potential interpretation:

### POSIX process-group provider

This test should demonstrate the documented limitation or known-escape behavior.

It should not demand arbitrary containment if that capability is not advertised.

### Windows Job / OCI / future cgroup provider

This should be a real containment test.

Please verify whether this classification is correct.

Also verify that a test simply running **inside Docker CI** is not accidentally being treated as proof that the invocation itself used the OCI isolation provider.

---

# 10. Strong recommendation: remove accidental complexity before adding new machinery

Please inspect the current dirty tree carefully.

There is experimental work involving roughly:

* POSIX PPID enumeration,
* descendant closure discovery,
* escaped-member tracking,
* birth-attested escaped descendants,
* separate signaling,
* extra terminal verification.

The current architectural direction suggests most or all of this should be discarded.

But do not blanket-reset the dirty files because they also contain legitimate unrelated fixes, including qualification/test-harness work.

Please create a **per-hunk disposition**:

```text
KEEP
REMOVE
REWORK
DEFER
```

with a short reason.

This should happen before implementation.

---

# 11. Migration size review

Please independently review each current PLAN packet:

```text
M0
M1
M2
M3
M4
```

For every packet, classify work as:

```text
REQUIRED NOW
REQUIRED FOR FINAL GATE G
CAN REUSE EXISTING EVIDENCE
FOLLOW-UP AFTER GATE G
UNNECESSARY
```

The goal is not necessarily to delete packets.

The goal is to prevent unrelated improvements from entering the critical path.

---

# 12. Be particularly skeptical of broad schema migrations

The current plan proposes versioning lifecycle contracts and carefully handling legacy durable records.

This may be absolutely correct.

But please ask:

> Do persisted records actually require the full new descriptor?

Could an existing field plus explicit scope metadata solve the problem?

Could old records be conservatively interpreted without migrating them?

Could new scope semantics apply only to new executions?

Could a migration be smaller while remaining safe?

Conversely, if versioning really is necessary to avoid silent semantic downgrade, explain exactly why and keep it.

Please choose correctness first, but implementation surface second.

---

# 13. Reuse previous evidence

We have already spent substantial effort obtaining accepted evidence.

Please do not automatically invalidate all previous Gate B/E/etc. work merely because lifecycle terminology changes.

For every previously accepted area, ask:

```text
Did behavior actually change?
```

If no:

```text
reuse evidence with an impact rationale.
```

If yes:

```text
rerun only the affected evidence.
```

Gate G should not become a complete Task 12 restart.

---

# 14. Testing strategy

Please refine the test model around the actual advertised scope.

Potential classification:

## Deterministic PR tests

* capability selection
* lifecycle scope semantics
* fencing
* stale ownership
* serialization/parsing
* fail-closed behavior
* package parity

## Native qualification

* real process group lifecycle
* crash/recovery
* real Windows Job behavior
* macOS/Linux process behavior
* timing-sensitive lifecycle tests

## Containment-provider qualification

* detached child
* `setsid`
* double fork
* process-group changes
* attach-process loss
* whole-container retirement

Only providers advertising containment should be required to pass adversarial escape tests.

Please refine this if necessary.

---

# 15. Gate G convergence

I want the revised plan to make it obvious when we are done.

Please define a very small number of concrete Gate G blockers.

For example, perhaps something like:

```text
1. lifecycle contract matches reality
2. experimental ancestry reconstruction removed
3. provider selection is correct
4. existing realistic native workloads pass
5. strong providers pass escape containment tests
6. required CI/qualification is green
7. final independent review/evidence clean
```

Do not use these exact items unless appropriate.

The important thing is that Gate G should have a finite and understandable finish line.

---

# 16. Complexity stopping rules

Please strengthen the stopping rules.

Some possible principles:

### Rule 1

If correctness requires discovering every process after it has escaped the owned OS boundary, change provider/contract rather than adding another scanner.

### Rule 2

A process observed through PPID/host enumeration does not automatically become Runner-owned.

### Rule 3

A test may require only guarantees advertised by the provider it actually exercises.

### Rule 4

CI host slowness should modify harness scheduling/outer guards before product semantics.

### Rule 5

After repeated evidence-backed repairs of the same architectural boundary, reassess the requirement instead of adding another retry/heuristic.

### Rule 6

Do not add a new backend/provider during Gate G unless an existing required real workload cannot be supported without it.

### Rule 7

Do not turn implementation mechanisms into public capabilities unless a consumer makes a decision based on them.

Please refine these rules rather than mechanically adopting them.

---

# 17. What I want from you now

Do **not** implement yet.

Please produce a revised plan or a review of the existing PLAN that answers:

## A. Is DECISION.md still the recommended architecture?

If yes, say what you would keep.

If not, explain the correction.

## B. Is PLAN.md larger than necessary?

Identify specifically where.

## C. What is the smallest safe migration?

Give ordered steps.

## D. What current dirty code should be kept/removed?

Use per-hunk or per-feature disposition.

## E. What old evidence can remain valid?

Avoid reopening unaffected gates.

## F. What exact tests need to change classification?

Especially detached descendants and Docker/native confusion.

## G. What are the final Gate G blockers after this amendment?

Make the finish line concrete.

## H. What work should explicitly be deferred?

For example:

* cgroup backend,
* generic escape tracking,
* broader provider redesign,
* unrelated cleanup/refactors.

---

# 18. Decision style

Please be decisive, but do not optimize merely for minimum code.

The priority order should be approximately:

```text
correctness
↓
honest guarantees
↓
security boundary integrity
↓
maintainability
↓
scope control
↓
implementation cost
```

We do want simplification, but only where it does not create a hidden safety downgrade.

Likewise, do not retain complexity merely because significant effort has already been invested in it.

Treat sunk implementation cost as sunk.

---

# 19. Final objective

We want to leave this reassessment with:

```text
a precise lifecycle contract
+
a small provider-selection model
+
a bounded migration
+
a finite Gate G acceptance path
```

rather than another large redesign project.

Please use the repository and the existing DECISION/PLAN/evidence as the source of truth and challenge these suggestions where the actual code or requirements justify doing so.
