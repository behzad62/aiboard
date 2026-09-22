# Evidence — <PACKET ID>

**Authoritative acceptance record for this packet.** One fact, one location. Reference other
records rather than copying them. Keep derived summaries identifiable as summaries.

| | |
|---|---|
| Packet | <ID> · Lane <X> · Phase <Y> |
| Requirements | <AC-n, AC-m> |
| Base revision | <sha> |
| Uncommitted diff identity | `git diff --stat` summary + sha256 of each changed source file |
| Node | `C:\Program Files\nodejs\node.exe` v24.x |
| State | PLANNED / RUNNING / IN_REVIEW / READY_TO_INTEGRATE / BLOCKED / ACCEPTED |

---

## 1. Acceptance conditions

One row per mandatory criterion from the packet contract. No row may be left blank.

| Requirement | Acceptance condition | Method | Outcome | Log |
|---|---|---|---|---|
| AC-n | <the exact condition> | <command or verification method> | <pass/fail + counts + exit status> | <path> |

---

## 2. Prove-red

One row per guard introduced or relied on. An injection with no RED is a coverage gap, not a
pass — say so plainly and record what was added to close it.

| Injection | File | Bytes / SHA-256 before → after | Applied? | RED signature (exact) | Restored byte-exact? |
|---|---|---|---|---|---|
| <what was disabled, alone> | <path> | <n / hash> → <n / hash> | yes/no | <verbatim assertion text> | yes + hash |

**Discipline reminders — each of these cost a real defect in P6.5:**
- Prove the injection changed the file **before** reading the test result.
- Probe a **type-level** injection with `npx tsc --noEmit`, never a `tsx` script run.
- Assert **exact sorted allow-lists**; prove both directions.
- An assertion that passed before the feature existed proves nothing until it can fail.

---

## 3. Validation scope and rationale

| | |
|---|---|
| Affected graph | <file count> files — list or reference |
| Why this scope | <behavioural impact: callers, shared contracts, config, schema, runtime, security, compatibility> |
| Concurrency | `--test-concurrency=1` if the set contains host/process fixtures — state which |
| Result | `tests N / pass N / fail 0 / skipped N` |
| Skips | each skip named with its host gate. An unexplained skip is not acceptance. |

---

## 4. Static gates

| Gate | Exit | Note |
|---|---|---|
| `tsc -p runner-v2/tsconfig.json --noEmit` | | |
| `tsc --noEmit` | | |
| `npx eslint .` | | must introduce no new error or warning |
| `npm run build` | | only if UI or client files changed |

---

## 5. Defect-class checks

Confirm each, from P6.5's recurring failures:

| Check | Result |
|---|---|
| Every variant tested, not just the first | |
| The **wiring** is tested, not only an extracted helper — deleting a call site reddens | |
| Every clause of every compound guard reddened individually | |
| Invariants tested for **difference**, not only sameness | |
| Every new exported class/function/tool is **constructed or called** by a test (grep proof) | |

---

## 6. Independent review

| | |
|---|---|
| Reviewer | <fresh-context identity — not the implementing worker> |
| Findings | <id, severity, disposition> |
| Unresolved mandatory findings | <must be none for acceptance> |
| Repair cycles used | <n> of 3 |

Self-review is not independent review. If no reviewer is available, leave this gate
outstanding and report the blocker; do not accept the work anyway.

---

## 7. Cleanup and rollback

| | |
|---|---|
| Injections removed, regression tests retained | |
| `public/*.zip` left dirty, not staged | |
| Rollback | whole-packet revert; state any durable data shape change |
| New `node:fs` importer added to the reviewed owner list? | see plan §3 A4 cleanup note |
