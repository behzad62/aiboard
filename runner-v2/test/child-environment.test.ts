import assert from "node:assert/strict";
import test from "node:test";

import {
  constructChildEnvironment,
  type ChildEnvironmentCredentialGrantResolver,
} from "../src/child-environment.js";

const NOW = "2026-08-28T12:00:00.000Z";

function privateResolver(): ChildEnvironmentCredentialGrantResolver {
  const consumed = new Set<string>();
  return {
    consume(grant) {
      if (consumed.has(grant.grantId)) throw new Error("Credential grant was already consumed.");
      consumed.add(grant.grantId);
      return { DEPLOY_TOKEN: "TEST_ONLY_GRANTED_VALUE" };
    },
  };
}

test("constructs a scrubbed environment with platform necessities and name-only audit", () => {
  const result = constructChildEnvironment({
    ambient: {
      Path: "C:\\Windows\\System32",
      TMP: "C:\\Temp",
      HOME: "C:\\Users\\runner",
      API_KEY: "TEST_ONLY_AMBIENT_KEY",
      Access_Token: "TEST_ONLY_AUTH_TOKEN",
      Authorization: "Bearer TEST_ONLY_HEADER",
      RUNNER_STATE_DIR: "C:\\private-state",
      RUNNER_AUTH_TOKEN: "TEST_ONLY_RUNNER_AUTH",
      SAFE_FLAG: "inherited",
    },
    explicitOverrides: {
      SAFE_FLAG: "overridden",
      api_key: "TEST_ONLY_HOSTILE_OVERRIDE",
      Runner_Control_Port: "9999",
    },
  });

  assert.deepEqual(result.environment, {
    Path: "C:\\Windows\\System32",
    TMP: "C:\\Temp",
    HOME: "C:\\Users\\runner",
    SAFE_FLAG: "overridden",
  });
  assert.deepEqual(result.audit.inheritedNames, ["HOME", "Path", "SAFE_FLAG", "TMP"]);
  assert.deepEqual(result.audit.removedNames, [
    "Access_Token", "API_KEY", "Authorization", "RUNNER_AUTH_TOKEN", "RUNNER_STATE_DIR",
  ]);
  assert.deepEqual(result.audit.explicitSafeNames, ["SAFE_FLAG"]);
  assert.deepEqual(result.audit.grantedNames, []);
  const audit = JSON.stringify(result.audit);
  assert.doesNotMatch(JSON.stringify(result), /TEST_ONLY_(?:AMBIENT_KEY|AUTH_TOKEN|HEADER|RUNNER_AUTH|HOSTILE_OVERRIDE)/);
  assert.doesNotMatch(audit, /TEST_ONLY_(?:AMBIENT_KEY|AUTH_TOKEN|HEADER|RUNNER_AUTH|HOSTILE_OVERRIDE)/);
  assert.doesNotMatch(audit, /C:\\private-state/);
});

test("restores only a valid named credential grant through the private resolver", () => {
  const result = constructChildEnvironment({
    ambient: { PATH: "/bin" },
    runId: "run_1",
    invocationId: "call_1",
    now: () => new Date(NOW),
    credentialGrant: {
      grantId: "grant_1",
      runId: "run_1",
      invocationId: "call_1",
      expiresAt: "2026-08-28T12:01:00.000Z",
      names: ["DEPLOY_TOKEN"],
    },
    credentialResolver: privateResolver(),
  });

  assert.equal(result.environment.DEPLOY_TOKEN, "TEST_ONLY_GRANTED_VALUE");
  assert.deepEqual(result.audit.grantedNames, ["DEPLOY_TOKEN"]);
  assert.doesNotMatch(JSON.stringify(result), /TEST_ONLY_GRANTED_VALUE/);
  assert.doesNotMatch(JSON.stringify(result.audit), /TEST_ONLY_GRANTED_VALUE/);
});

test("rejects forged, mismatched, expired, and duplicate credential grants", () => {
  const resolver = privateResolver();
  const base = {
    ambient: { PATH: "/bin" },
    runId: "run_1",
    invocationId: "call_1",
    now: () => new Date(NOW),
    credentialResolver: resolver,
  } as const;
  const grant = {
    grantId: "grant_1",
    runId: "run_1",
    invocationId: "call_1",
    expiresAt: "2026-08-28T12:01:00.000Z",
    names: ["DEPLOY_TOKEN"],
  } as const;

  assert.throws(() => constructChildEnvironment({
    ...base,
    credentialGrant: { ...grant, values: { DEPLOY_TOKEN: "TEST_ONLY_FORGED_VALUE" } } as unknown as typeof grant,
  }), /value|unknown/i);
  assert.throws(() => constructChildEnvironment({ ...base, credentialGrant: { ...grant, runId: "run_other" } }), /run/i);
  assert.throws(() => constructChildEnvironment({ ...base, credentialGrant: { ...grant, invocationId: "call_other" } }), /invocation|call/i);
  assert.throws(() => constructChildEnvironment({
    ...base,
    credentialGrant: { ...grant, expiresAt: "2026-08-28T11:59:59.000Z" },
  }), /expired/i);

  constructChildEnvironment({ ...base, credentialGrant: grant });
  assert.throws(() => constructChildEnvironment({ ...base, credentialGrant: grant }), /consumed|duplicate/i);
});

test("rejects resolver values outside the named grant without exposing them in the audit", () => {
  const result = () => constructChildEnvironment({
    ambient: { PATH: "/bin" },
    runId: "run_1",
    invocationId: "call_1",
    credentialGrant: {
      grantId: "grant_1",
      runId: "run_1",
      invocationId: "call_1",
      names: ["DEPLOY_TOKEN"],
    },
    credentialResolver: {
      consume: () => ({ DEPLOY_TOKEN: "TEST_ONLY_GRANTED_VALUE", EXTRA_TOKEN: "TEST_ONLY_EXTRA_VALUE" }),
    },
  });
  assert.throws(result, /named|grant/i);
});
