# Runner V2 Control Plane Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the durable local Runner V2 service foundation that owns run state independently of every browser tab.

**Architecture:** A separate Node 24.18.0 package exposes an authenticated localhost control API. SQLite stores append-only events and rebuildable projections; a content-addressed artifact directory stores large payloads. The first vertical slice supports run creation, pause/resume/stop, event streaming, restart recovery, and Git prerequisite checks without any model calls.

**Tech Stack:** TypeScript 6, Node.js 24.18.0, built-in `node:sqlite`, built-in `node:test`, `tsx`, HTTP/JSON, Server-Sent Events, Git CLI.

## Global Constraints

- The runner, never a browser tab, owns execution and durable state.
- The Architect owns intent and semantic judgment; this foundation contains no semantic verifier.
- Every state change is an append-only event with an idempotency key.
- SQLite projections are rebuildable from events.
- Large payloads are content-addressed artifacts, not duplicated in events.
- Git is mandatory; missing Git blocks run creation before model usage.
- Node.js 24.18.0 is the certified Runner V2 runtime; startup rejects incompatible versions before opening state.
- No global memory, browser execution engine, mutable checkpoint authority, or automatic Architect handoff.
- Existing `scripts/runner.mjs` remains operational until the Build V2 migration is complete.
- Do not import runner modules into browser bundles.

---

## File map

- `runner-v2/package.json` — isolated package commands and Node version floor.
- `runner-v2/.node-version` — exact certified runtime version.
- `runner-v2/tsconfig.json` — NodeNext compiler boundary.
- `runner-v2/src/contracts.ts` — stable event, run, state, and API types.
- `runner-v2/src/event-store.ts` — event-store interface.
- `runner-v2/src/sqlite-event-store.ts` — transactional SQLite implementation.
- `runner-v2/src/reducer.ts` — pure event-to-run projection reducer.
- `runner-v2/src/run-supervisor.ts` — lifecycle commands and projection recovery.
- `runner-v2/src/artifact-store.ts` — SHA-256 artifact persistence.
- `runner-v2/src/git-preflight.ts` — Git capability validation.
- `runner-v2/src/control-server.ts` — token-authenticated HTTP/SSE API.
- `runner-v2/src/cli.ts` — service entrypoint and runner token output.
- `runner-v2/test/*.test.ts` — unit, integration, and restart tests.
- `package.json` — root scripts for Runner V2 verification.

### Task 1: Package boundary and stable event contracts

**Files:**
- Create: `runner-v2/package.json`
- Create: `runner-v2/.node-version`
- Create: `runner-v2/tsconfig.json`
- Create: `runner-v2/src/contracts.ts`
- Create: `runner-v2/test/contracts.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `RunEvent`, `RunProjection`, `RunState`, `RunCommand`, `NewRunEvent`, and `RUNNER_V2_SCHEMA_VERSION`.
- Consumes: no Runner V2 interfaces.

- [ ] **Step 1: Write the failing contract test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNNER_V2_SCHEMA_VERSION,
  assertRunEvent,
  type RunEvent,
} from "../src/contracts.js";

test("run events require identity, ordering, provenance, and idempotency", () => {
  const event: RunEvent = {
    schemaVersion: 1,
    eventId: "evt_1",
    runId: "run_1",
    sequence: 1,
    type: "run.created",
    occurredAt: "2026-07-11T00:00:00.000Z",
    actor: { kind: "user", id: "local-user" },
    idempotencyKey: "create:run_1",
    payload: { projectPath: "C:/work/project", permissionProfile: "project" },
  };
  assert.equal(RUNNER_V2_SCHEMA_VERSION, 1);
  assert.doesNotThrow(() => assertRunEvent(event));
  assert.throws(
    () => assertRunEvent({ ...event, idempotencyKey: "" }),
    /idempotencyKey/
  );
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npx tsx --test runner-v2/test/contracts.test.ts`

Expected: FAIL because `runner-v2/src/contracts.ts` does not exist.

- [ ] **Step 3: Add package configuration**

`runner-v2/package.json`:

```json
{
  "name": "@aiboard/runner-v2",
  "private": true,
  "type": "module",
  "engines": { "node": "24.18.0" },
  "scripts": {
    "test": "tsx --test test/*.test.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

`runner-v2/.node-version`:

```text
24.18.0
```

`runner-v2/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "types": ["node"],
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Add root scripts:

```json
"test:runner-v2": "tsx --test runner-v2/test/*.test.ts",
"typecheck:runner-v2": "tsc -p runner-v2/tsconfig.json --noEmit"
```

- [ ] **Step 4: Implement the contracts**

```ts
export const RUNNER_V2_SCHEMA_VERSION = 1 as const;
export type PermissionProfile = "guarded" | "project" | "full";
export type RunState =
  | "created"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed";
export type RunActor = {
  kind: "user" | "runner" | "architect" | "worker" | "subagent";
  id: string;
};
export type RunEventType =
  | "run.created"
  | "run.started"
  | "run.paused"
  | "run.resumed"
  | "run.stop_requested"
  | "run.stopped"
  | "run.completed"
  | "run.failed";
export interface RunEvent {
  schemaVersion: typeof RUNNER_V2_SCHEMA_VERSION;
  eventId: string;
  runId: string;
  sequence: number;
  type: RunEventType;
  occurredAt: string;
  actor: RunActor;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}
export type NewRunEvent = Omit<RunEvent, "schemaVersion" | "eventId" | "sequence">;
export interface RunProjection {
  runId: string;
  state: RunState;
  projectPath: string;
  permissionProfile: PermissionProfile;
  createdAt: string;
  updatedAt: string;
  lastSequence: number;
  stopReason?: string;
}
export type RunCommand = "start" | "pause" | "resume" | "stop";

export function assertRunEvent(value: RunEvent): void {
  if (!value.eventId) throw new Error("eventId is required");
  if (!value.runId) throw new Error("runId is required");
  if (!Number.isInteger(value.sequence) || value.sequence < 1) {
    throw new Error("sequence must be a positive integer");
  }
  if (!value.idempotencyKey) throw new Error("idempotencyKey is required");
  if (!value.occurredAt || Number.isNaN(Date.parse(value.occurredAt))) {
    throw new Error("occurredAt must be an ISO timestamp");
  }
}
```

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm run test:runner-v2 -- --test-name-pattern="run events" && npm run typecheck:runner-v2`

Expected: contract test PASS and typecheck exit 0.

Commit:

```powershell
git add package.json runner-v2
git commit -m "feat(runner-v2): define durable run contracts"
```

### Task 2: Transactional SQLite event store

**Files:**
- Create: `runner-v2/src/event-store.ts`
- Create: `runner-v2/src/sqlite-event-store.ts`
- Create: `runner-v2/test/sqlite-event-store.test.ts`

**Interfaces:**
- Consumes: `NewRunEvent`, `RunEvent`.
- Produces: `EventStore.append(event): RunEvent`, `readRun(runId, afterSequence?)`, `listRunIds()`, `close()`.

- [ ] **Step 1: Write failing atomicity and idempotency tests**

```ts
test("append assigns monotonic sequences and deduplicates idempotency keys", () => {
  const store = new SqliteEventStore(tempDb());
  const first = store.append(newEvent("run_1", "create:run_1"));
  const duplicate = store.append(newEvent("run_1", "create:run_1"));
  const second = store.append(newEvent("run_1", "start:run_1"));
  assert.equal(first.sequence, 1);
  assert.equal(duplicate.eventId, first.eventId);
  assert.equal(second.sequence, 2);
  assert.deepEqual(store.readRun("run_1").map((event) => event.sequence), [1, 2]);
  store.close();
});
```

- [ ] **Step 2: Confirm RED**

Run: `npx tsx --test runner-v2/test/sqlite-event-store.test.ts`

Expected: FAIL because `SqliteEventStore` is missing.

- [ ] **Step 3: Define the interface**

```ts
export interface EventStore {
  append(event: NewRunEvent): RunEvent;
  readRun(runId: string, afterSequence?: number): RunEvent[];
  listRunIds(): string[];
  close(): void;
}
```

- [ ] **Step 4: Implement SQLite WAL storage**

Use `DatabaseSync` from `node:sqlite`. Initialize:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS run_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  UNIQUE(run_id, sequence),
  UNIQUE(run_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_run_events_order
ON run_events(run_id, sequence);
```

`append` must use `BEGIN IMMEDIATE`, return an existing row for a duplicate `(run_id, idempotency_key)`, allocate `MAX(sequence)+1`, insert, commit, and roll back on error.

- [ ] **Step 5: Add corruption and reopen tests**

Test that closing and reopening preserves ordering, invalid persisted JSON throws with the event ID, and separate run IDs have independent sequences.

- [ ] **Step 6: Verify and commit**

Run: `npx tsx --test runner-v2/test/sqlite-event-store.test.ts && npm run typecheck:runner-v2`

Expected: all event-store tests PASS.

Commit:

```powershell
git add runner-v2/src/event-store.ts runner-v2/src/sqlite-event-store.ts runner-v2/test/sqlite-event-store.test.ts
git commit -m "feat(runner-v2): persist append-only run events"
```

### Task 3: Pure projections and run supervisor

**Files:**
- Create: `runner-v2/src/reducer.ts`
- Create: `runner-v2/src/run-supervisor.ts`
- Create: `runner-v2/test/run-supervisor.test.ts`

**Interfaces:**
- Consumes: `EventStore`, `RunEvent`, `RunProjection`.
- Produces: `reduceRunEvent`, `rebuildRunProjection`, and `RunSupervisor` lifecycle methods.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
test("restart rebuilds state and commands remain idempotent", () => {
  const supervisor = makeSupervisor(dbPath);
  const run = supervisor.createRun({
    runId: "run_1",
    projectPath: projectDir,
    permissionProfile: "project",
    idempotencyKey: "create:run_1",
  });
  supervisor.start("run_1", "start:run_1");
  supervisor.pause("run_1", "pause:run_1", "user");
  supervisor.close();

  const recovered = makeSupervisor(dbPath);
  assert.equal(recovered.getRun("run_1").state, "paused");
  recovered.resume("run_1", "resume:run_1");
  recovered.resume("run_1", "resume:run_1");
  assert.equal(recovered.getRun("run_1").state, "running");
  assert.equal(recovered.events("run_1").filter((e) => e.type === "run.resumed").length, 1);
});
```

- [ ] **Step 2: Confirm RED**

Run: `npx tsx --test runner-v2/test/run-supervisor.test.ts`

Expected: FAIL because reducer and supervisor are missing.

- [ ] **Step 3: Implement the pure reducer**

`reduceRunEvent` must reject non-contiguous sequences and invalid transitions. `run.created` creates the projection; later events update state and timestamps. No reducer reads the filesystem or current clock.

```ts
export function rebuildRunProjection(events: readonly RunEvent[]): RunProjection {
  if (events.length === 0) throw new Error("Cannot project an empty run");
  return events.reduce<RunProjection | undefined>(reduceRunEvent, undefined)!;
}
```

- [ ] **Step 4: Implement lifecycle commands**

`RunSupervisor` appends events and immediately rebuilds the affected projection. It accepts the clock and ID generator as constructor dependencies so tests are deterministic. Invalid commands fail before append. Stop is two-stage: `run.stop_requested` then `run.stopped` after future process reconciliation.

- [ ] **Step 5: Add transition-table tests**

Cover created→running, running→paused, paused→running, running→stopping→stopped, terminal-state rejection, duplicate command idempotency, and recovery of multiple runs.

- [ ] **Step 6: Verify and commit**

Run: `npx tsx --test runner-v2/test/run-supervisor.test.ts && npm run typecheck:runner-v2`

Commit:

```powershell
git add runner-v2/src/reducer.ts runner-v2/src/run-supervisor.ts runner-v2/test/run-supervisor.test.ts
git commit -m "feat(runner-v2): add recoverable run lifecycle"
```

### Task 4: Content-addressed artifact store

**Files:**
- Create: `runner-v2/src/artifact-store.ts`
- Create: `runner-v2/test/artifact-store.test.ts`

**Interfaces:**
- Produces: `ArtifactStore.put`, `get`, `stat`, and `verify`.

- [ ] **Step 1: Write the failing artifact tests**

```ts
test("artifacts deduplicate by SHA-256 and verify corruption", async () => {
  const store = new ArtifactStore(tempDir);
  const first = await store.put(Buffer.from("tool output"), "text/plain");
  const second = await store.put(Buffer.from("tool output"), "text/plain");
  assert.equal(first.hash, second.hash);
  assert.equal((await store.get(first.hash)).toString(), "tool output");
  await fs.writeFile(first.path, "corrupt");
  await assert.rejects(store.verify(first.hash), /hash mismatch/);
});
```

- [ ] **Step 2: Confirm RED**

Run: `npx tsx --test runner-v2/test/artifact-store.test.ts`

- [ ] **Step 3: Implement atomic artifact writes**

Use SHA-256 lowercase hex, two-character prefix directories, temporary files plus atomic rename, and a JSON metadata sidecar containing media type, byte length, creation time, and original optional label. Existing valid artifacts are reused.

- [ ] **Step 4: Add concurrent-put and missing-artifact tests**

Use `Promise.all` with identical bytes and assert one durable payload. Assert unknown hashes return a typed `ArtifactNotFoundError`.

- [ ] **Step 5: Verify and commit**

Run: `npx tsx --test runner-v2/test/artifact-store.test.ts && npm run typecheck:runner-v2`

Commit:

```powershell
git add runner-v2/src/artifact-store.ts runner-v2/test/artifact-store.test.ts
git commit -m "feat(runner-v2): add content-addressed artifacts"
```

### Task 5: Git preflight and authenticated control API

**Files:**
- Create: `runner-v2/src/git-preflight.ts`
- Create: `runner-v2/src/control-server.ts`
- Create: `runner-v2/test/git-preflight.test.ts`
- Create: `runner-v2/test/control-server.test.ts`

**Interfaces:**
- Consumes: `RunSupervisor`, `ArtifactStore`.
- Produces: `checkGit`, `ControlServer.start`, `ControlServer.close`, REST endpoints, and SSE event stream.

- [ ] **Step 1: Write failing Git preflight tests**

Inject a command executor and assert:

```ts
assert.deepEqual(
  await checkGit(async () => ({ exitCode: 127, stdout: "", stderr: "not found" })),
  { available: false, version: null, reason: "Git is required for Build V2." }
);
```

Also test parsing `git version 2.45.1.windows.1` and rejecting a configured minimum lower than `2.39.0`.

- [ ] **Step 2: Write failing API/auth/SSE tests**

Start on port `0`. Assert missing or wrong bearer token returns 401. With the token:

- `POST /v2/runs` creates a run only after Git preflight.
- `GET /v2/runs/:id` returns the projection.
- `POST /v2/runs/:id/commands` accepts `{command,idempotencyKey}`.
- `GET /v2/runs/:id/events?after=0` returns ordered JSON.
- `GET /v2/runs/:id/stream?after=0` emits SSE IDs equal to event sequence.

- [ ] **Step 3: Confirm RED**

Run: `npx tsx --test runner-v2/test/git-preflight.test.ts runner-v2/test/control-server.test.ts`

- [ ] **Step 4: Implement Git preflight**

Use `spawn` with argument arrays only. Return a typed result and installation guidance code (`git_missing`, `git_too_old`, or `git_ready`). Do not invoke a shell or install Git.

- [ ] **Step 5: Implement the control server**

Use `node:http`, bind only to `127.0.0.1`, enforce `Authorization: Bearer <token>` on every `/v2` endpoint, cap request bodies at 1 MiB, return structured errors, and set `Cache-Control: no-store`. SSE sends historical events after the requested sequence, then subscribes to supervisor append notifications and sends heartbeat comments without creating run events.

- [ ] **Step 6: Add disconnect/reconnect tests**

Disconnect after event 2, append events 3 and 4, reconnect with `after=2`, and assert only 3 and 4 arrive once.

- [ ] **Step 7: Verify and commit**

Run: `npx tsx --test runner-v2/test/git-preflight.test.ts runner-v2/test/control-server.test.ts && npm run typecheck:runner-v2`

Commit:

```powershell
git add runner-v2/src/git-preflight.ts runner-v2/src/control-server.ts runner-v2/test/git-preflight.test.ts runner-v2/test/control-server.test.ts
git commit -m "feat(runner-v2): expose durable local control API"
```

### Task 6: CLI bootstrap and crash-recovery vertical slice

**Files:**
- Create: `runner-v2/src/cli.ts`
- Create: `runner-v2/test/recovery-smoke.test.ts`
- Modify: `runner-v2/package.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: SQLite store, supervisor, artifact store, Git preflight, control server.
- Produces: executable `aiboard-runner-v2` development entrypoint.

- [ ] **Step 1: Write failing recovery smoke test**

Spawn the CLI with temporary `--state-dir`, `--project`, `--port 0`, and fixed test token. Create/start/pause a run via HTTP, terminate the process, restart with the same state directory, and assert the paused projection and complete ordered event history are unchanged. Resume and stop, then assert sequence continuity and no duplicate idempotency keys.

- [ ] **Step 2: Confirm RED**

Run: `npx tsx --test runner-v2/test/recovery-smoke.test.ts`

- [ ] **Step 3: Implement CLI parsing and startup**

Required flags:

```text
--project <absolute-path>
--state-dir <absolute-path>
--port <0-65535, default 0>
--token <test/development override; otherwise generate 32 random bytes>
```

Startup order is an exact Node 24.18.0 version check, directory validation, Git preflight, SQLite open/recovery, artifact verification, control-server bind, then one JSON readiness line on stdout containing protocol version, URL, token hint, PID, project path, and state directory. Never print provider credentials.

- [ ] **Step 4: Add package commands**

`runner-v2/package.json`:

```json
"bin": { "aiboard-runner-v2": "./src/cli.ts" },
"scripts": {
  "dev": "tsx src/cli.ts",
  "test": "tsx --test test/*.test.ts",
  "typecheck": "tsc --noEmit"
}
```

Root `package.json`:

```json
"runner:v2": "tsx runner-v2/src/cli.ts",
"test:runner-v2": "tsx --test runner-v2/test/*.test.ts",
"typecheck:runner-v2": "tsc -p runner-v2/tsconfig.json --noEmit"
```

- [ ] **Step 5: Run the complete foundation gate**

Run:

```powershell
npm run test:runner-v2
npm run typecheck:runner-v2
npx tsc --noEmit
npm run lint
git diff --check
```

Expected: all Runner V2 tests pass, both typechecks exit 0, ESLint exits 0, and diff check is clean.

- [ ] **Step 6: Commit the vertical slice**

```powershell
git add package.json runner-v2
git commit -m "feat(runner-v2): complete durable control-plane foundation"
```

## Foundation completion gate

This plan is complete only when a test can create a run through the localhost API, observe ordered events, kill every browser and the runner process, restart the runner, reconnect after an event sequence, and continue the same run without lost or duplicated state.

The next plan begins only after this gate and covers Git initialization, dirty baseline capture, task worktrees/overlays, change-set artifacts, and serialized integration.
