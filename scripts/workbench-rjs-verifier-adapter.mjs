import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  createReplayInput,
  evaluateFileBounded as evaluateFrozenFileBounded,
  replayInputFromRecord,
  toVerifierResult,
  validateReplayInput,
} from "../benchmarks/recoverable-job-service/private/runtime.mjs";

const STATE_SCHEMA_VERSION = 1;
const STATE_ENV = "AIBOARD_RJS_REPLAY_STATE_FILE";

export { toVerifierResult };

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseEnvelope(stateFile, expectedIdentity) {
  let value;
  try {
    value = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Trusted replay state is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== STATE_SCHEMA_VERSION ||
    !isRecord(value.identity) ||
    value.identity.contractHash !== expectedIdentity.contractHash ||
    value.identity.suiteHash !== expectedIdentity.suiteHash
  ) {
    throw new Error("Trusted replay state identity is invalid or mismatched.");
  }
  const replayInput = value.replayRecord
    ? replayInputFromRecord(value.replayRecord)
    : validateReplayInput(value.replayInput);
  return { ...value, replayInput: validateReplayInput(replayInput) };
}

function atomicWrite(stateFile, value) {
  mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, stateFile);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function prepareReplayState(stateFile, identity) {
  if (typeof stateFile !== "string" || !stateFile) {
    throw new Error("Trusted replay state file is required.");
  }
  if (
    !isRecord(identity) ||
    !/^[a-f0-9]{64}$/.test(identity.contractHash ?? "") ||
    !/^[a-f0-9]{64}$/.test(identity.suiteHash ?? "")
  ) {
    throw new Error("Trusted replay score identity is invalid.");
  }
  const existing = parseEnvelope(stateFile, identity);
  if (existing) return existing.replayInput;
  const replayInput = validateReplayInput(createReplayInput());
  atomicWrite(stateFile, {
    schemaVersion: STATE_SCHEMA_VERSION,
    identity,
    replayInput,
  });
  return replayInput;
}

export async function evaluateFileBounded(path) {
  const stateFile = process.env[STATE_ENV];
  if (!stateFile) throw new Error(`${STATE_ENV} is required for trusted verification.`);
  const raw = JSON.parse(readFileSync(stateFile, "utf8"));
  if (!isRecord(raw?.identity)) throw new Error("Trusted replay state lacks score identity.");
  const replayInput = prepareReplayState(stateFile, raw.identity);
  let callbackCount = 0;
  const diagnostics = await evaluateFrozenFileBounded(path, {
    replayInput,
    onReplayRecord(record) {
      callbackCount += 1;
      if (callbackCount !== 1) throw new Error("Trusted evaluator produced duplicate final replay records.");
      const recordedInput = validateReplayInput(replayInputFromRecord(record));
      if (recordedInput.commitment !== replayInput.commitment) {
        throw new Error("Trusted evaluator replay record does not match its input.");
      }
      atomicWrite(stateFile, {
        schemaVersion: STATE_SCHEMA_VERSION,
        identity: raw.identity,
        replayInput,
        replayRecord: record,
      });
    },
  });
  if (callbackCount !== 1) {
    throw new Error("Trusted evaluator returned without one final replay record.");
  }
  return diagnostics;
}
