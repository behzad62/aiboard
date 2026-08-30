# Task 8.0B1 exceptional round 6 — independent scoped re-review

## Range and verdict

- Fix base reviewed: `c6a5c5be`
- Head reviewed: `ac7d837f`
- Review package: `review-c6a5c5be..ac7d837f.diff`
- Verdict: **NOT APPROVED**
- Critical remaining: 0
- Important remaining: 2
- New Critical/Important breakage outside the two residual findings: none
- **PACKET 8.0B1 BLOCKED — GENUINE USER DECISION REQUIRED**
- Packet 8.0B2 remains locked.

## Finding 1 — NOT ADDRESSED

New launches persist `begin_channel` before acquisition, and current marked
records derive and validate an exact cleanup set. However, the unchanged active
schema version treats both `channelAcquisitionStartedAt` and
`outputCheckpointCreatedAt` as optional. It accepts a valid `bound` row with a
lease and backend binding but neither marker. That durable shape is ambiguous:
the pre-fix runtime could leave it both immediately before and immediately after
channel acquisition.

For this row, `derivedHostCleanupDefinitions()` emits only `host` and
`isolation_lease`. `begin_cleanup` accepts that kernel-derived set, and
`settle_cleanup_cleaned` reaches `released`/owner `none` after those two facts
succeed even though the backend binding remains and a channel may exist. The
new checkpoint/link guard rejects a checkpoint without a marker, but it does
not fail closed for an active bound row without either marker.

Evidence:

- `runner-v2/src/streaming-session-store.ts:1516-1522` leaves the marker fields
  optional in schema v1.
- `runner-v2/src/streaming-session-store.ts:1565-1577` validates a marker when
  present but does not require one for an active bound row.
- `runner-v2/src/streaming-session-store.ts:2282-2287` omits the channel duty
  when the optional channel marker is absent.
- `runner-v2/src/streaming-session-store.ts:2138-2146` permits release when the
  incomplete derived ledger succeeds.

Controller reproduction at `ac7d837f` exited 0 and printed exactly:

```json
{"derived":["host","isolation_lease"],"state":"released","ownerId":"none","backendRetained":true}
```

Required closure: unsafe ambiguous active pre-marker data must fail closed or
conservatively retain the possible channel obligation. It cannot become
released without proof that the possible channel was absent or cleaned.

## Finding 2 — NOT ADDRESSED

Durable cleanup resource facts now use an exact closed code/message mapping,
and ordinary provider failures no longer copy raw messages into durable rows.
But `StreamingProcessSessionError` remains exported with a public constructor
that accepts arbitrary message/cause data. Both cancellation and normal open
failure paths treat any instance of that class as trusted Runner-owned data and
rethrow it unchanged. An injected provider can construct the same exported
class and bypass the new boundary.

Evidence:

- `runner-v2/src/streaming-process-session-runtime.ts:11-12` exports the class
  and its arbitrary message/cause constructor.
- `runner-v2/src/streaming-process-session-runtime.ts:303` rethrows an injected
  typed instance unchanged on cancellation.
- `runner-v2/src/streaming-process-session-runtime.ts:309-311` rethrows an
  injected typed instance unchanged on the normal open failure path.

Controller reproduction at `ac7d837f` exited 0 and printed exactly:

```json
{"name":"StreamingProcessSessionError","message":"credential=B1_R6_TYPED_PROVIDER_SENTINEL","cause":{"name":"Error","message":"payload=credential=B1_R6_TYPED_PROVIDER_SENTINEL"},"code":"launch_failed"}
```

Required closure: every provider boundary must return a newly constructed
Runner-owned fixed typed error. Provider-controlled messages, causes, aggregate
children, stacks, and arbitrary values must remain non-durable and must not be
caller/model-visible, even when the provider throws an exported Runner error
class.

## Evidence audit

The implementation report contains genuine initial RED/GREEN results, four
reverted mutation checks, a valid-HMAC pre-marker checkpoint guard, in-memory
and SQLite sentinel scans, and green reported gates of B1 79/79, 8.0A 89/89,
Task 7 plus Task 3 173/173, typecheck, targeted lint, and diff check. Those tests
cover marked current rows and ordinary foreign errors. They do not cover the
ambiguous active bound/no-marker durable row or a provider-created exported
typed runtime error. The two controller reproductions above therefore keep the
semantic exit gate red regardless of the broader green suite.

## Exit

The owner-authorized one-time exceptional round is consumed. No additional fix
dispatch is authorized by the current budget. Packet 8.0B1 cannot be declared
verified and Packet 8.0B2 may not begin.
