# Task 8.0B1 round 7 — independent scoped re-review

## Range and verdict

- Fix base: `2643cf75`
- Head: `392804c4`
- Review package: `review-2643cf75..392804c4.diff`
- Finding 1: **ADDRESSED**
- Finding 2: **NOT ADDRESSED**
- New Critical/Important breakage outside Finding 2: none
- Packet 8.0B1 remains unapproved; Packet 8.0B2 remains locked.

## Finding 1 — ADDRESSED

Host-launch schema generation 2 is explicit. New launches use it, while every
active older-generation row is refused as `unsupported_active_version` before
content parsing or cleanup. Generation-2 marker history is ordered; handshake
requires both channel and checkpoint markers; cleanup derives the channel duty
only after the pre-effect marker. SQLite list/read/transition/reopen share the
same HMAC/version refusal boundary.

The focused tests cover the exact legacy false-release reproduction, all six
active legacy boundaries, generation-2 pre/post-marker semantics, marker order,
valid-HMAC refusal, write-fault non-mutation, and raw-byte preservation. No
Critical/Important residual remains for the schema finding.

## Finding 2 — NOT ADDRESSED

The private WeakSet proves an error was originally minted by Runner, but it does
not protect the error's mutable public fields after the object crosses a caller
boundary. `StreamingProcessSessionError` exposes mutable `code`, `message`, and
`cause`; `runnerSessionError()` brands that same object; and catch/facade paths
rethrow a still-branded object unchanged.

A caller can retain a genuine branded error, mutate its message/cause, and a
provider can later inject the same object. WeakSet membership still passes, so
the provider-controlled values become caller/model-visible again.

Controller reproduction at `392804c4` exited 0 and printed exactly:

```json
{"same":true,"name":"StreamingProcessSessionError","code":"launch_failed","message":"credential=B1_R7_REPLAY","cause":{"payload":"credential=B1_R7_REPLAY"}}
```

Required closure:

- Store immutable private claims for each internally minted error; never trust
  its public mutable fields after minting.
- At every public/provider boundary, create a fresh fixed Runner-owned error
  from the private claims or from the phase mapping. Never rethrow or unwrap the
  same error object.
- A replayed branded error with mutated code/message/cause must return a fresh
  safe object, original fixed code/message, no cause, and no sentinel.
- Add the exact replay test plus mutation proof. Preserve the already-approved
  schema fix and all earlier gates.

## Evidence audit

The round-7 report contains genuine RED/GREEN results, four reverted mutations,
and reported green B1/8.0A/compatibility/type/lint/diff/scope/residue gates. Its
foreign-error matrix covers fresh exported instances, subclasses, lookalikes,
aggregates, arbitrary values, and delivery nesting, but not mutation/replay of
a previously exposed branded object. Therefore the remaining R7.2 requirement
is not verified.

## Verdict

**Findings remain open** — schema generation is closed; error provenance still
permits replay of a mutated caller-exposed branded error.
