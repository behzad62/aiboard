import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withOwnedFenceLockSync } from "./owned-fence-lock.mjs";

const RETIREMENT_PROTOCOL = "aiboard-portable-output-retirement/v1";
const OUTPUT_NAME = /^(stdout|stderr)-(\d{12})\.json$/;
const INPUT_ACK_NAME = /^input-(\d{12})\.json$/;

export class PortableAuthorityUnavailableError extends Error {
  constructor(message, options) { super(message, options); this.name = "PortableAuthorityUnavailableError"; }
}

export class PortableOutputRetirementBlockedError extends Error {
  code = "portable_output_retirement_blocked";
  constructor(message, options) { super(message, options); this.name = "PortableOutputRetirementBlockedError"; }
}

export function runPortableFenceEffectSync(options) {
  let effectStarted = false;
  let effectCompleted = false;
  try {
    return withOwnedFenceLockSync(options.lockPath, () => {
      let current;
      try { current = options.readCurrentFence(); }
      catch (error) {
        throw error instanceof PortableAuthorityUnavailableError
          ? error
          : new PortableAuthorityUnavailableError("Portable authority evidence is unavailable.", { cause: error });
      }
      if (!validFence(current)) throw new PortableAuthorityUnavailableError("Portable authority evidence is invalid.");
      if (!sameFence(current, options.expectedFence)) return { status: "stale" };
      effectStarted = true;
      const value = options.effect();
      effectCompleted = true;
      return { status: "applied", value };
    }, options.lockOptions);
  } catch (error) {
    if (effectStarted || effectCompleted) return { status: "outcome_unknown", error };
    return { status: "unavailable", cause: error instanceof PortableAuthorityUnavailableError ? "authority" : "coordination", error };
  }
}

export function runPortableFenceSnapshotSync(options) {
  try {
    return withOwnedFenceLockSync(options.lockPath, () => {
      let current;
      try { current = options.readCurrentFence(); }
      catch (error) {
        throw error instanceof PortableAuthorityUnavailableError
          ? error
          : new PortableAuthorityUnavailableError("Portable authority evidence is unavailable.", { cause: error });
      }
      if (!validFence(current)) throw new PortableAuthorityUnavailableError("Portable authority evidence is invalid.");
      if (!sameFence(current, options.expectedFence)) return { status: "stale" };
      try { return { status: "applied", value: options.read() }; }
      catch (error) { return { status: "blocked", error }; }
    }, options.lockOptions);
  } catch (error) {
    return { status: "unavailable", cause: error instanceof PortableAuthorityUnavailableError ? "authority" : "coordination", error };
  }
}

export function settlePortableSupervisorCommand(options) {
  const result = options.commit(options.expectedFence, options.apply);
  if (result.status !== "stale") return result;
  let current;
  try { current = options.readCurrentFence(); }
  catch (error) { return { status: "unavailable", cause: "authority", error }; }
  if (!validFence(current)) return { status: "unavailable", cause: "authority", error: new PortableAuthorityUnavailableError("Portable authority evidence is invalid.") };
  const retirement = options.commit(current, options.retireStale);
  if (retirement.status === "applied") return { status: "stale", retirement: retirement.value === false ? "deferred" : "applied" };
  if (retirement.status === "stale" || retirement.status === "unavailable" && retirement.cause === "coordination")
    return { status: "stale", retirement: "deferred" };
  return retirement;
}

export function retirePortableOutputAcknowledgement(options) {
  const atomicWrite = options.atomicWrite ?? defaultWriteAtomic;
  const paths = retirementPaths(options.channelDirectory, options.name);
  let intent = readRetirementIntent(paths.intent, false);
  if (intent) {
    assertRetirementProvenance(intent, options.fence);
    if (intent.nonce !== options.nonce || intent.name !== options.name || !sameJson(intent.metadata, options.metadata))
      throw blocked("Portable output retirement intent is foreign to the requested acknowledgement.");
  } else {
    assertOutputName(options.name, options.metadata);
    const checkpoint = readCheckpoint(paths.checkpoint, options.nonce);
    const before = checkpoint[options.metadata.stream];
    const after = { sequence: options.metadata.sequence, endOffset: options.metadata.endOffset };
    if (before.sequence + 1 !== after.sequence || before.endOffset !== options.metadata.startOffset)
      throw blocked("Portable output retirement checkpoint is not contiguous.");
    assertOutputChunk(paths.output, options.nonce, options.name, options.metadata, true);
    assertOutputAcknowledgement(paths.ack, options.nonce, options.fence, options.metadata, true);
    intent = { protocol: RETIREMENT_PROTOCOL, nonce: options.nonce, ownerId: options.fence.ownerId, fencingToken: options.fence.fencingToken, name: options.name, metadata: options.metadata, before, after };
    atomicWrite(paths.intent, JSON.stringify(intent));
    options.afterBoundary?.("intent");
  }
  resumeRetirement(paths, intent, options.afterBoundary, atomicWrite);
}

export function resumePortableOutputRetirement(options) {
  const intentPath = join(options.channelDirectory, "output-retirement.json");
  const intent = readRetirementIntent(intentPath, false);
  if (!intent) return undefined;
  if (intent.nonce !== options.nonce) throw blocked("Portable output retirement intent is foreign to this channel.");
  assertRetirementProvenance(intent, options.fence);
  const paths = retirementPaths(options.channelDirectory, intent.name);
  resumeRetirement(paths, intent, undefined, options.atomicWrite ?? defaultWriteAtomic);
  return { name: intent.name, metadata: intent.metadata };
}

export function readPortableOutputSnapshot(options) {
  const outputDirectory = join(options.channelDirectory, "output");
  const acknowledgementDirectory = join(options.channelDirectory, "ack");
  const intentPath = join(options.channelDirectory, "output-retirement.json");
  if (existsSync(intentPath)) {
    readRetirementIntent(intentPath, true);
    throw blocked("Portable output retirement is incomplete.");
  }
  const checkpoint = readCheckpoint(join(options.channelDirectory, "output-checkpoint.json"), options.nonce);
  let names;
  try { names = readdirSync(outputDirectory).sort(); }
  catch (error) { throw new Error("Portable output evidence is missing or unreadable.", { cause: error }); }
  const expected = new Map([
    ["stdout", { sequence: checkpoint.stdout.sequence + 1, offset: checkpoint.stdout.endOffset }],
    ["stderr", { sequence: checkpoint.stderr.sequence + 1, offset: checkpoint.stderr.endOffset }],
  ]);
  const output = [];
  for (const name of names) {
    const match = OUTPUT_NAME.exec(name);
    if (!match) {
      const pending = /^(stdout|stderr)-(\d{12})\.json\.(\d+)\.tmp$/.exec(name);
      if (pending && Number(pending[3]) === options.supervisorPid) continue;
      throw new Error("Portable output filename is invalid.");
    }
    let value;
    try { value = JSON.parse(readFileSync(join(outputDirectory, name), "utf8")); }
    catch (error) { throw new Error("Portable output chunk is invalid.", { cause: error }); }
    const bytes = Buffer.from(value.bytes, "base64");
    if (value.nonce !== options.nonce || !validMetadata(value.metadata, bytes) || value.metadata.stream !== match[1] || value.metadata.sequence !== Number(match[2]))
      throw new Error("Portable output chunk is invalid.");
    const cursor = expected.get(value.metadata.stream);
    if (value.metadata.sequence !== cursor.sequence || value.metadata.startOffset !== cursor.offset)
      throw new Error("Portable output retained suffix is not contiguous.");
    cursor.sequence += 1;
    cursor.offset = value.metadata.endOffset;
    output.push({ name, metadata: value.metadata, bytes: new Uint8Array(bytes) });
  }
  const acknowledgements = validatePortableAcknowledgements(acknowledgementDirectory, options.nonce, output);
  return { checkpoint, output, acknowledgements };
}

export function validatePortableAcknowledgements(acknowledgementDirectory, nonce, output) {
  let names;
  try { names = readdirSync(acknowledgementDirectory).sort(); }
  catch (error) { throw new Error("Portable acknowledgement evidence is missing or unreadable.", { cause: error }); }
  const retained = new Map(output.map((entry) => [entry.name, entry.metadata]));
  for (const name of names) {
    let value;
    try { value = JSON.parse(readFileSync(join(acknowledgementDirectory, name), "utf8")); }
    catch (error) { throw new Error("Portable acknowledgement evidence is invalid.", { cause: error }); }
    if (value.nonce !== nonce || typeof value.ownerId !== "string" || value.ownerId.length === 0 || !Number.isSafeInteger(value.fencingToken) || value.fencingToken < 1)
      throw new Error("Portable acknowledgement evidence is invalid.");
    const outputName = OUTPUT_NAME.exec(name);
    const inputName = INPUT_ACK_NAME.exec(name);
    if (outputName) {
      const metadata = retained.get(name);
      if (!metadata || !sameJson(value.metadata, metadata))
        throw blocked("Portable output acknowledgement has no exact retained chunk or retirement intent.");
    } else if (inputName) {
      if (value.sequence !== Number(inputName[1]) || !["acknowledged", "failed"].includes(value.status))
        throw new Error("Portable acknowledgement evidence is invalid.");
    } else throw new Error("Portable acknowledgement evidence is invalid.");
  }
  return names;
}

function resumeRetirement(paths, intent, afterBoundary, atomicWrite) {
  const checkpoint = readCheckpoint(paths.checkpoint, intent.nonce);
  const cursor = checkpoint[intent.metadata.stream];
  const atBefore = sameJson(cursor, intent.before);
  const atAfter = sameJson(cursor, intent.after);
  if (!atBefore && !atAfter) throw blocked("Portable output retirement checkpoint does not match its exact intent.");
  if (atBefore) {
    assertOutputAcknowledgement(paths.ack, intent.nonce, intent, intent.metadata, true);
    if (existsSync(paths.output)) {
      assertOutputChunk(paths.output, intent.nonce, intent.name, intent.metadata, true);
      unlinkSync(paths.output);
      if (existsSync(paths.output)) throw blocked("Portable output retirement could not remove the exact chunk.");
      afterBoundary?.("output");
    }
    atomicWrite(paths.checkpoint, JSON.stringify({ ...checkpoint, [intent.metadata.stream]: intent.after }));
    afterBoundary?.("checkpoint");
  } else if (existsSync(paths.output)) throw blocked("Portable output chunk exists after its retirement checkpoint advanced.");
  if (existsSync(paths.ack)) {
    assertOutputAcknowledgement(paths.ack, intent.nonce, intent, intent.metadata, true);
    unlinkSync(paths.ack);
    if (existsSync(paths.ack)) throw blocked("Portable output retirement could not remove the exact acknowledgement.");
    afterBoundary?.("ack");
  }
  unlinkSync(paths.intent);
  if (existsSync(paths.intent)) throw blocked("Portable output retirement intent could not be settled.");
}

function readRetirementIntent(path, required) {
  if (!existsSync(path)) {
    if (required) throw blocked("Portable output retirement intent is missing.");
    return undefined;
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    const outputName = OUTPUT_NAME.exec(value.name);
    if (value.protocol !== RETIREMENT_PROTOCOL || typeof value.nonce !== "string" || value.nonce.length === 0 || !validFence(value) || !outputName ||
        !validMetadataShape(value.metadata) || !validCursor(value.before) || !validCursor(value.after) || value.after.sequence !== value.metadata.sequence ||
        value.after.endOffset !== value.metadata.endOffset || value.before.sequence + 1 !== value.after.sequence || value.before.endOffset !== value.metadata.startOffset ||
        outputName[1] !== value.metadata.stream || Number(outputName[2]) !== value.metadata.sequence)
      throw new Error();
    return value;
  } catch (error) {
    if (error instanceof PortableOutputRetirementBlockedError) throw error;
    throw blocked("Portable output retirement intent is corrupt or foreign.", error);
  }
}

function assertOutputChunk(path, nonce, name, metadata, required) {
  if (!existsSync(path)) {
    if (required) throw blocked("Portable output chunk is missing without recoverable retirement progress.");
    return;
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    const bytes = Buffer.from(value.bytes, "base64");
    if (value.nonce !== nonce || !sameJson(value.metadata, metadata) || !validMetadata(value.metadata, bytes)) throw new Error();
    assertOutputName(name, value.metadata);
  } catch (error) { throw blocked("Portable output chunk does not match its retirement intent.", error); }
}

function assertOutputAcknowledgement(path, nonce, fence, metadata, required) {
  if (!existsSync(path)) {
    if (required) throw blocked("Portable output acknowledgement is missing before checkpoint settlement.");
    return;
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value.nonce !== nonce || !sameFence(value, fence) || !sameJson(value.metadata, metadata)) throw new Error();
  } catch (error) { throw blocked("Portable output acknowledgement does not match its retirement intent.", error); }
}

function readCheckpoint(path, nonce) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value.nonce !== nonce || !validCursor(value.stdout) || !validCursor(value.stderr)) throw new Error();
    return value;
  } catch (error) { throw blocked("Portable output checkpoint is missing, corrupt, or foreign.", error); }
}

function retirementPaths(channelDirectory, name) {
  return { checkpoint: join(channelDirectory, "output-checkpoint.json"), output: join(channelDirectory, "output", name), ack: join(channelDirectory, "ack", name), intent: join(channelDirectory, "output-retirement.json") };
}
function assertOutputName(name, metadata) {
  const match = OUTPUT_NAME.exec(name);
  if (!match || match[1] !== metadata.stream || Number(match[2]) !== metadata.sequence) throw blocked("Portable output filename does not match acknowledgement metadata.");
}
function assertRetirementProvenance(intent, currentFence) {
  if (!validFence(currentFence) || intent.fencingToken > currentFence.fencingToken ||
      (intent.fencingToken === currentFence.fencingToken && intent.ownerId !== currentFence.ownerId))
    throw blocked("Portable output retirement intent has impossible fence provenance.");
}
function validFence(value) { return value && typeof value.ownerId === "string" && value.ownerId.length > 0 && Number.isSafeInteger(value.fencingToken) && value.fencingToken > 0; }
function sameFence(left, right) { return left.ownerId === right.ownerId && left.fencingToken === right.fencingToken; }
function validCursor(value) { return value && Number.isSafeInteger(value.sequence) && value.sequence >= 0 && Number.isSafeInteger(value.endOffset) && value.endOffset >= 0; }
function validMetadataShape(metadata) {
  return metadata && (metadata.stream === "stdout" || metadata.stream === "stderr") && Number.isSafeInteger(metadata.sequence) && metadata.sequence > 0 &&
    Number.isSafeInteger(metadata.startOffset) && metadata.startOffset >= 0 && Number.isSafeInteger(metadata.endOffset) && metadata.endOffset >= metadata.startOffset &&
    Number.isSafeInteger(metadata.byteLength) && metadata.byteLength >= 0 && metadata.endOffset === metadata.startOffset + metadata.byteLength &&
    typeof metadata.digest === "string" && /^[0-9a-f]{64}$/.test(metadata.digest);
}
function validMetadata(metadata, bytes) { return validMetadataShape(metadata) && metadata.byteLength === bytes.byteLength && metadata.digest === createHash("sha256").update(bytes).digest("hex"); }
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function blocked(message, cause) { return new PortableOutputRetirementBlockedError(message, cause === undefined ? undefined : { cause }); }
function defaultWriteAtomic(path, value) { const temporary = `${path}.${randomUUID()}.tmp`; writeFileSync(temporary, value, { mode: 0o600 }); renameSync(temporary, path); }
