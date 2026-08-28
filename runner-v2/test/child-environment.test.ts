import assert from "node:assert/strict";
import test from "node:test";

import {
  createChildEnvironmentFactory,
  type RunnerOwnedChildEnvironmentCredentialResolver,
} from "../src/child-environment.js";

const NOW = "2026-08-28T12:00:00.000Z";
const GENERIC_GRANT_ERROR = /Child environment credential grant (?:is invalid|could not be consumed)\./;

interface GrantRecord {
  grantId: string;
  runId: string;
  invocationId: string;
  expiresAt?: string;
  names: string[];
  values: Record<string, string>;
}

function resolver(records: Record<string, GrantRecord>): RunnerOwnedChildEnvironmentCredentialResolver {
  const consumed = new Set<string>();
  return {
    consume(grantId) {
      if (consumed.has(grantId)) throw new Error(`SENTINEL_REPLAY_${grantId}`);
      consumed.add(grantId);
      const record = records[grantId];
      if (!record) throw new Error(`SENTINEL_UNKNOWN_${grantId}`);
      return record;
    },
  };
}

function factory(records: Record<string, GrantRecord> = {}) {
  return createChildEnvironmentFactory({
    credentialResolver: resolver(records),
    now: () => new Date(NOW),
  });
}

test("prepares a public name-only capability while preserving safe platform variables", () => {
  const prepared = factory().prepare({
    ambient: {
      Path: "C:\\Windows\\System32", TMP: "C:\\Temp", HOME: "C:\\Users\\runner",
      API_KEY: "SENTINEL_AMBIENT_KEY", Access_Token: "SENTINEL_AUTH_TOKEN",
      Authorization: "Bearer SENTINEL_HEADER", RUNNER_STATE_DIR: "C:\\private-state",
      RUNNER_AUTH_TOKEN: "SENTINEL_RUNNER_AUTH", SAFE_FLAG: "inherited",
    },
    explicitOverrides: { SAFE_FLAG: "overridden", api_key: "SENTINEL_HOSTILE_OVERRIDE", Runner_Control_Port: "9999" },
  });

  assert.deepEqual(prepared.audit.inheritedNames, ["HOME", "Path", "SAFE_FLAG", "TMP"]);
  assert.deepEqual(prepared.audit.removedNames, ["Access_Token", "API_KEY", "Authorization", "RUNNER_AUTH_TOKEN", "RUNNER_STATE_DIR"]);
  assert.deepEqual(prepared.audit.explicitSafeNames, ["SAFE_FLAG"]);
  assert.deepEqual(prepared.audit.grantedNames, []);
  assert.deepEqual(Object.keys(prepared).sort(), ["audit", "capability"]);
  assert.doesNotMatch(JSON.stringify(prepared), /SENTINEL_(?:AMBIENT_KEY|AUTH_TOKEN|HEADER|RUNNER_AUTH|HOSTILE_OVERRIDE)/);
});

test("atomically consumes an authoritative opaque grant and exposes values only to the trusted callback once", () => {
  const runner = factory({ grant_1: { grantId: "grant_1", runId: "run_1", invocationId: "call_1", expiresAt: "2026-08-28T12:01:00.000Z", names: ["DEPLOY_TOKEN"], values: { DEPLOY_TOKEN: "SENTINEL_GRANTED_VALUE" } } });
  const prepared = runner.prepare({ ambient: { PATH: "/bin" }, runId: "run_1", invocationId: "call_1", credentialGrantId: "grant_1" });

  assert.deepEqual(prepared.audit.grantedNames, ["DEPLOY_TOKEN"]);
  assert.doesNotMatch(JSON.stringify(prepared), /SENTINEL_GRANTED_VALUE/);
  runner.withChildEnvironment(prepared.capability, (environment) => {
    assert.equal(environment.DEPLOY_TOKEN, "SENTINEL_GRANTED_VALUE");
    assert.equal(environment.PATH, "/bin");
  });
  assert.throws(() => runner.withChildEnvironment(prepared.capability, () => undefined), GENERIC_GRANT_ERROR);
});

test("rejects forged ids, replay, mismatched authoritative bindings, and expiry with generic errors", () => {
  const records = {
    grant_1: { grantId: "grant_1", runId: "run_1", invocationId: "call_1", names: ["DEPLOY_TOKEN"], values: { DEPLOY_TOKEN: "SENTINEL_VALUE" } },
    wrong_run: { grantId: "wrong_run", runId: "run_other", invocationId: "call_1", names: ["DEPLOY_TOKEN"], values: { DEPLOY_TOKEN: "SENTINEL_VALUE" } },
    wrong_call: { grantId: "wrong_call", runId: "run_1", invocationId: "call_other", names: ["DEPLOY_TOKEN"], values: { DEPLOY_TOKEN: "SENTINEL_VALUE" } },
    expired: { grantId: "expired", runId: "run_1", invocationId: "call_1", expiresAt: "2026-08-28T11:59:59.000Z", names: ["DEPLOY_TOKEN"], values: { DEPLOY_TOKEN: "SENTINEL_VALUE" } },
  };
  const runner = factory(records);
  const base = { ambient: { PATH: "/bin" }, runId: "run_1", invocationId: "call_1" };
  for (const credentialGrantId of ["forged", "wrong_run", "wrong_call", "expired"]) assert.throws(() => runner.prepare({ ...base, credentialGrantId }), GENERIC_GRANT_ERROR);
  runner.prepare({ ...base, credentialGrantId: "grant_1" });
  assert.throws(() => runner.prepare({ ...base, credentialGrantId: "grant_1" }), GENERIC_GRANT_ERROR);
  assert.throws(() => runner.withChildEnvironment({} as never, () => undefined), GENERIC_GRANT_ERROR);
});

test("factory atomically blocks non-consuming and reentrant grant redemption attempts", () => {
  const record: GrantRecord = {
    grantId: "grant_atomic", runId: "run_1", invocationId: "call_1",
    names: ["DEPLOY_TOKEN"], values: { DEPLOY_TOKEN: "SENTINEL_ATOMIC_VALUE" },
  };
  let attempts = 0;
  let reentrantError: unknown;
  const runner = createChildEnvironmentFactory({
    credentialResolver: {
      consume: () => {
        attempts += 1;
        if (attempts === 1) {
          try { runner.prepare({ ambient: { PATH: "/bin" }, runId: "run_1", invocationId: "call_1", credentialGrantId: "grant_atomic" }); }
          catch (error) { reentrantError = error; }
        }
        return record;
      },
    },
    now: () => new Date(NOW),
  });
  const input = { ambient: { PATH: "/bin" }, runId: "run_1", invocationId: "call_1", credentialGrantId: "grant_atomic" };
  runner.prepare(input);
  assert.match(reentrantError instanceof Error ? reentrantError.message : "", GENERIC_GRANT_ERROR);
  assert.equal(attempts, 1);
  assert.throws(() => runner.prepare(input), GENERIC_GRANT_ERROR);
  assert.equal(attempts, 1);
});

test("rejects non-credential, Runner, and canonical-colliding authoritative grant names", () => {
  for (const [id, names, values] of [
    ["path", ["PATH"], { PATH: "/other" }], ["runner", ["Runner_Control_Port"], { Runner_Control_Port: "1" }],
    ["duplicate", ["DEPLOY_TOKEN", "deploy_token"], { DEPLOY_TOKEN: "SENTINEL_VALUE" }],
    ["collision", ["DEPLOY_TOKEN"], { DEPLOY_TOKEN: "SENTINEL_VALUE", deploy_token: "SENTINEL_OTHER" }],
  ] as const) {
    const runner = factory({ [id]: { grantId: id, runId: "run_1", invocationId: "call_1", names: [...names], values: { ...values } } });
    assert.throws(() => runner.prepare({ ambient: { PATH: "/bin" }, runId: "run_1", invocationId: "call_1", credentialGrantId: id }), GENERIC_GRANT_ERROR);
  }
});

test("contains resolver and untrusted failures without reflecting sentinel names or values", () => {
  const runner = createChildEnvironmentFactory({ credentialResolver: { consume: () => { throw new Error("SENTINEL_PRIVATE_VALUE_AND_NAME"); } }, now: () => new Date(NOW) });
  let error: unknown;
  try { runner.prepare({ ambient: { PATH: "/bin" }, runId: "run_1", invocationId: "call_1", credentialGrantId: "SENTINEL_FORGED_ID" }); } catch (caught) { error = caught; }
  assert.match(error instanceof Error ? error.message : "", GENERIC_GRANT_ERROR);
  assert.doesNotMatch(error instanceof Error ? error.message : "", /SENTINEL/);
});

test("preserves reserved object-property environment names without adding environment hooks", () => {
  const runner = factory();
  const prepared = runner.prepare({ ambient: { PATH: "/bin", toJSON: "safe-to-json", constructor: "safe-constructor", prototype: "safe-prototype" } });
  runner.withChildEnvironment(prepared.capability, (environment) => {
    assert.equal(Object.getPrototypeOf(environment), null);
    assert.equal(environment.toJSON, "safe-to-json");
    assert.equal(environment.constructor, "safe-constructor");
    assert.equal(environment.prototype, "safe-prototype");
  });
});
