import assert from "node:assert/strict";
import { scenarios } from "../benchmarks/recoverable-job-service/private/scenarios.mjs";

async function expectAccepted(label: string, action: () => Promise<void>) {
  await assert.doesNotReject(action, label);
}

async function expectRejected(label: string, action: () => Promise<void>, pattern: RegExp) {
  await assert.rejects(action, pattern, label);
}

function b06Harness(attachDuringRefusal: 0 | 1 | 2 = 0) {
  let attaches = 0;
  let refusal = 0;
  const grant = { expiresAt: 10_000, token: "before" };
  return {
    jobId: "job-1",
    b: {
      time: 500,
      grant,
      token: () => "renewed",
    },
    async setup() {
      attaches += 1;
    },
    async refuse(_method: string, _input: unknown, allowed: string[]) {
      refusal += 1;
      if (attachDuringRefusal === refusal) attaches += 1;
      assert.ok(allowed.includes(refusal === 1 ? "deadline" : "lease"));
    },
    count(method: string) {
      assert.equal(method, "driver.attach");
      return attaches;
    },
    check(condition: boolean, message: string) {
      if (!condition) throw new Error(message);
    },
    async reopen() {},
  };
}

function a04Harness(input: {
  restoreKind: "blocked" | "ok";
  restoreCode: "integrity" | "gap";
  retainInvalid?: boolean;
}) {
  const job = { ackCount: input.retainInvalid ? 1 : 0 };
  return {
    jobId: "job-1",
    b: { getJob: () => job },
    async setup() {},
    async accepted() {
      return { stream: "stdout", seq: 0, offset: 0, length: 1, digest: "d", artifactId: "a" };
    },
    async delivery() {
      return { receipt: { token: "public" } };
    },
    async ok(method: string) {
      if (method === "exportCapsule") return { checkpoint: { accepted: [{ seq: 1 }] } };
      if (method === "acknowledge") {
        job.ackCount += 1;
        return null;
      }
      throw new Error(`unexpected ok ${method}`);
    },
    async sealed(capsule: unknown) {
      return capsule;
    },
    async refuse(_method: string, _input: unknown, allowed: string[]) {
      if (input.restoreKind === "ok") throw new Error("restore unexpectedly succeeded");
      if (!allowed.includes(input.restoreCode)) {
        throw new Error(`restore categorical blocker ${input.restoreCode} not allowed`);
      }
    },
    async reopen() {},
    check(condition: boolean, message: string) {
      if (!condition) throw new Error(message);
    },
  };
}

await expectAccepted(
  "B06 allows a reader installed during successful setup",
  () => scenarios.B06(b06Harness() as never)
);
await expectRejected(
  "B06 detects a new attach during expired stop",
  () => scenarios.B06(b06Harness(1) as never),
  /expired entry issues no attach/
);
await expectRejected(
  "B06 detects a new attach during insufficient-reserve stop",
  () => scenarios.B06(b06Harness(2) as never),
  /insufficient reserve issues no work/
);

await expectAccepted(
  "A04 accepts a truthful integrity refusal",
  () => scenarios.A04(a04Harness({ restoreKind: "blocked", restoreCode: "integrity" }) as never)
);
await expectAccepted(
  "A04 accepts a truthful gap refusal",
  () => scenarios.A04(a04Harness({ restoreKind: "blocked", restoreCode: "gap" }) as never)
);
await expectRejected(
  "A04 rejects restore success",
  () => scenarios.A04(a04Harness({ restoreKind: "ok", restoreCode: "integrity" }) as never),
  /unexpectedly succeeded/
);
await expectRejected(
  "A04 rejects invalid retained effects",
  () => scenarios.A04(a04Harness({ restoreKind: "blocked", restoreCode: "gap", retainInvalid: true }) as never),
  /legitimate previous epoch receipt retires exactly once/
);

console.log("PASS");
