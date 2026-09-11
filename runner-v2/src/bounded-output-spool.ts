import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { types as nodeTypes } from "node:util";

export type OutputStream = "stdout" | "stderr";
export type OutputLossReasonCode =
  | "spill_cap_exceeded"
  | "private_spill_unavailable"
  | "spill_root_invalid"
  | "spill_open_failed"
  | "spill_write_failed"
  | "spill_close_failed"
  | "spill_identity_failed"
  | "artifact_ingestion_failed"
  | "evidence_continuation_loss";
export type OutputSpillState = "empty" | "discarded" | "artifact_ingested" | "lossy";

export interface OutputLossReason {
  readonly code: OutputLossReasonCode;
  readonly stream: OutputStream;
  readonly lostBytes: number;
}

export interface BoundedOutputStreamResult {
  readonly stream: OutputStream;
  readonly tail: string;
  readonly tailBytesBase64: string;
  readonly tailByteLength: number;
  readonly tailDisplayTruncated: boolean;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly spillState: OutputSpillState;
  readonly spillArtifactId?: string;
  readonly spillBytes: number;
  readonly lossyBytes: number;
  readonly lossyOutput: boolean;
  readonly lossReason?: OutputLossReason;
  readonly lossReasons: readonly OutputLossReason[];
}

export interface BoundedOutputSpoolResult {
  readonly streams: readonly BoundedOutputStreamResult[];
}

export interface OutputSpillFile {
  readonly identity: string;
  write(bytes: Uint8Array): Promise<number>;
  sealAndRead(expectedBytes: number, maximumBytes: number): Promise<Buffer>;
  close(): Promise<void>;
}

export interface OutputSpillStorageAttestation {
  readonly currentPrincipalPrivacy: boolean;
  readonly identityStableDeletion: boolean;
  readonly unlinkedEntries: boolean;
  readonly currentPrincipalIdentity?: string;
}

export interface OutputSpillStorage {
  attest(): Promise<OutputSpillStorageAttestation>;
  prepareRoot(root: string): Promise<void>;
  openExclusive(path: string): Promise<OutputSpillFile>;
  remove(path: string): Promise<void>;
  removeIdentityStable(path: string, expectedIdentity: string): Promise<void>;
  list(root: string): Promise<string[]>;
}

export interface OutputArtifactStore {
  put(bytes: Uint8Array, mediaType: string, label?: string): Promise<{ readonly hash: string }>;
}

export interface BoundedOutputSpoolOptions {
  readonly spillRoot: string;
  readonly projectRoot: string;
  readonly ownershipId: string;
  readonly tailBytes?: number;
  readonly spillBytes?: number;
  readonly artifactStore?: OutputArtifactStore;
  readonly storage?: OutputSpillStorage;
}

interface MutableStreamState {
  readonly stream: OutputStream;
  tail: Buffer;
  totalBytes: number;
  spillBytes: number;
  lossyBytes: number;
  lossReason?: MutableOutputLossReason;
  lossReasons: MutableOutputLossReason[];
  spillUnavailable: boolean;
  spillPath?: string;
  spillProofPath?: string;
  spillFile?: OutputSpillFile;
  spillIdentity?: string;
  spillArtifactId?: string;
  finalized: boolean;
}

interface MutableOutputLossReason {
  code: OutputLossReasonCode;
  stream: OutputStream;
  lostBytes: number;
}

interface OwnedSpillRoot {
  readonly canonicalRoot: string;
  readonly projectRoot: string;
  readonly ownershipId: string;
  readonly rootId: string;
  readonly rootIdentity: string;
  readonly markerIdentity: string;
  readonly entryPrefix: string;
  readonly currentPrincipalIdentity?: string;
}

const DEFAULT_TAIL_BYTES = 128 * 1024;
const DEFAULT_SPILL_BYTES = 64 * 1024 * 1024;
const SPILL_PREFIX = "output-spill-";
const SPILL_SUFFIX = ".tmp";
const OWNER_MARKER = ".output-spool-owner.json";
const ENTRY_PROOF_SUFFIX = ".owner.json";
const SPILL_ATTESTATION_KEYS = new Set([
  "currentPrincipalPrivacy",
  "identityStableDeletion",
  "unlinkedEntries",
  "currentPrincipalIdentity",
]);

export class BoundedOutputSpool {
  private readonly spillRoot: string;
  private readonly projectRoot: string;
  private readonly ownershipId: string;
  private readonly tailBytes: number;
  private readonly maximumSpillBytes: number;
  private readonly artifactStore?: OutputArtifactStore;
  private readonly storage: OutputSpillStorage;
  private readonly states = new Map<OutputStream, MutableStreamState>([
    ["stdout", freshState("stdout")],
    ["stderr", freshState("stderr")],
  ]);
  private operation = Promise.resolve();
  private result?: BoundedOutputSpoolResult;
  private terminal: "open" | "finalizing" | "cleaning" | "finalized" | "cleaned" = "open";
  private finalizePromise?: Promise<BoundedOutputSpoolResult>;
  private cleanupPromise?: Promise<void>;
  private ownedRoot?: OwnedSpillRoot;
  private storageAttestation?: OutputSpillStorageAttestation;
  private spillCapabilityUnavailable = false;

  constructor(options: BoundedOutputSpoolOptions) {
    this.spillRoot = resolve(requiredText(options.spillRoot, "spillRoot"));
    this.projectRoot = resolve(requiredText(options.projectRoot, "projectRoot"));
    this.ownershipId = ownershipIdentity(options.ownershipId);
    this.tailBytes = positiveInteger(options.tailBytes ?? DEFAULT_TAIL_BYTES, "tailBytes");
    this.maximumSpillBytes = positiveInteger(options.spillBytes ?? DEFAULT_SPILL_BYTES, "spillBytes");
    this.artifactStore = options.artifactStore;
    this.storage = options.storage ?? createNodeOutputSpillStorage();
  }

  write(stream: OutputStream, chunk: Uint8Array): Promise<void> {
    if (this.terminal !== "open") return Promise.reject(new Error("Output spool is sealed."));
    const bytes = Buffer.from(chunk);
    const work = this.operation.then(async () => await this.writeNow(stream, bytes));
    this.operation = work.catch(() => undefined);
    return work;
  }

  finalize(): Promise<BoundedOutputSpoolResult> {
    if (this.finalizePromise) return this.finalizePromise;
    if (this.cleanupPromise) {
      return this.cleanupPromise.then(() => {
        throw new Error("Output spool was sealed by cleanup.");
      });
    }
    if (this.terminal !== "open") return Promise.reject(new Error("Output spool was sealed by cleanup."));
    this.terminal = "finalizing";
    this.finalizePromise = this.operation.then(async () => {
      for (const state of this.states.values()) await this.finalizeStream(state);
      this.result = Object.freeze({
        streams: Object.freeze(
          (["stdout", "stderr"] as const).map((stream) => this.snapshot(this.states.get(stream)!))
        ),
      });
      await this.cleanupNow();
      this.terminal = "finalized";
      return this.result;
    });
    this.operation = this.finalizePromise.then(() => undefined, () => undefined);
    return this.finalizePromise;
  }

  cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    if (this.finalizePromise) return this.finalizePromise.then(() => undefined);
    if (this.terminal !== "open") return Promise.reject(new Error("Output spool is sealed."));
    this.terminal = "cleaning";
    this.cleanupPromise = this.operation.then(async () => {
      await this.cleanupNow();
      this.terminal = "cleaned";
    });
    this.operation = this.cleanupPromise.catch(() => undefined);
    return this.cleanupPromise;
  }

  private async cleanupNow(): Promise<void> {
    let terminalError: unknown;
    for (const state of this.states.values()) {
      if (state.spillFile) {
        try {
          await state.spillFile.close();
        } catch (error) {
          terminalError ??= error;
        }
        state.spillFile = undefined;
      }
      if (state.spillPath) {
        try {
          if (!this.ownedRoot) throw new Error("Output spill root ownership is unavailable.");
          await removeOwnedEntry(
            this.ownedRoot,
            state.spillPath,
            state.spillProofPath,
            state.spillIdentity,
            this.storage
          );
        } catch (error) {
          terminalError ??= error;
        }
        state.spillPath = undefined;
        state.spillProofPath = undefined;
      }
    }
    if (this.ownedRoot) {
      try {
        await removeOwnedRootIfEmpty(this.ownedRoot);
      } catch (error) {
        terminalError ??= error;
      }
    }
    if (terminalError) throw terminalError;
  }

  private async writeNow(stream: OutputStream, bytes: Buffer): Promise<void> {
    const state = this.states.get(stream);
    if (!state) throw new Error(`Unsupported output stream: ${stream as string}.`);
    if (state.finalized) throw new Error("Output spool stream is already finalized.");
    if (bytes.byteLength === 0) return;

    state.totalBytes += bytes.byteLength;
    state.tail = appendTail(state.tail, bytes, this.tailBytes);
    if (state.lossReason && state.lossReason.code !== "spill_cap_exceeded") {
      this.addLoss(state, state.lossReason.code, bytes.byteLength);
      return;
    }

    const remaining = this.maximumSpillBytes - state.spillBytes;
    const spillable = bytes.subarray(0, Math.max(0, remaining));
    const overflow = bytes.byteLength - spillable.byteLength;
    if (spillable.byteLength > 0) {
      if (!(await this.ensureOpen(state))) {
        this.addLoss(state, state.lossReason!.code, bytes.byteLength);
        return;
      }
      try {
        const written = await state.spillFile!.write(spillable);
        if (written !== spillable.byteLength) throw new Error("Short spill write.");
        state.spillBytes += written;
      } catch {
        this.addLoss(state, "spill_write_failed", bytes.byteLength);
        return;
      }
    }
    if (overflow > 0) {
      this.addLoss(state, "spill_cap_exceeded", overflow);
    }
  }

  private async ensureOpen(state: MutableStreamState): Promise<boolean> {
    if (state.spillFile) return true;
    if (!this.storageAttestation && !this.spillCapabilityUnavailable) {
      try {
        const attestation = parseOutputSpillStorageAttestation(await this.storage.attest());
        if (!attestation) {
          this.spillCapabilityUnavailable = true;
        } else {
          this.storageAttestation = attestation;
        }
      } catch {
        this.spillCapabilityUnavailable = true;
      }
    }
    if (this.spillCapabilityUnavailable || !this.storageAttestation) {
      this.addLoss(state, "private_spill_unavailable", 0);
      return false;
    }
    if (!this.ownedRoot) {
      try {
        this.ownedRoot = await prepareOwnedRoot(
          this.spillRoot,
          this.projectRoot,
          this.ownershipId,
          this.storageAttestation.currentPrincipalIdentity
        );
      } catch {
        this.addLoss(state, "spill_root_invalid", 0);
        return false;
      }
    }
    try {
      state.spillPath = resolve(
        this.ownedRoot.canonicalRoot,
        `${this.ownedRoot.entryPrefix}${state.stream}-${randomUUID()}${SPILL_SUFFIX}`
      );
      state.spillFile = await this.storage.openExclusive(state.spillPath);
      state.spillIdentity = state.spillFile.identity;
      if (this.storageAttestation.unlinkedEntries) {
        state.spillPath = undefined;
      } else {
        state.spillProofPath = `${state.spillPath}${ENTRY_PROOF_SUFFIX}`;
        await writeFile(
          state.spillProofPath,
          JSON.stringify({
            version: 1,
            ownershipId: this.ownedRoot.ownershipId,
            rootId: this.ownedRoot.rootId,
            entry: basename(state.spillPath),
            identity: state.spillIdentity,
          }),
          { flag: "wx", mode: 0o600 }
        );
      }
      return true;
    } catch {
      this.addLoss(state, "spill_open_failed", 0);
      if (state.spillFile && state.spillPath && this.ownedRoot) {
        await state.spillFile.close().catch(() => undefined);
        await removeOwnedEntry(
          this.ownedRoot,
          state.spillPath,
          state.spillProofPath,
          state.spillIdentity,
          this.storage,
          true
        ).catch(() => undefined);
      }
      state.spillFile = undefined;
      state.spillPath = undefined;
      state.spillProofPath = undefined;
      return false;
    }
  }

  private async finalizeStream(state: MutableStreamState): Promise<void> {
    if (state.finalized) return;
    state.finalized = true;
    let closeFailed = false;
    let artifactBytes: Buffer | undefined;
    if (state.spillFile && state.spillBytes > 0 && this.artifactStore) {
      try {
        artifactBytes = await state.spillFile.sealAndRead(state.spillBytes, this.maximumSpillBytes);
        if (artifactBytes.byteLength !== state.spillBytes) throw new Error("Spill identity or length changed.");
      } catch {
        artifactBytes = undefined;
        this.addUnavailableSpillLoss(state, "spill_identity_failed");
      }
    }
    if (state.spillFile) {
      try {
        await state.spillFile.close();
      } catch {
        closeFailed = true;
        this.addUnavailableSpillLoss(state, "spill_close_failed");
      } finally {
        state.spillFile = undefined;
      }
    }
    if (state.spillBytes === 0 || closeFailed || !artifactBytes) return;
    if (this.artifactStore) {
      try {
        const artifact = await this.artifactStore.put(
          artifactBytes,
          "application/octet-stream",
          `${state.stream} process output`
        );
        state.spillArtifactId = artifact.hash;
      } catch {
        this.addUnavailableSpillLoss(state, "artifact_ingestion_failed");
      }
    }
  }

  private addLoss(state: MutableStreamState, code: OutputLossReasonCode, bytes: number): void {
    const existing = state.lossReasons.find((reason) => reason.code === code);
    if (existing) {
      existing.lostBytes += bytes;
      state.lossReason = existing;
    } else {
      const reason = { code, stream: state.stream, lostBytes: bytes };
      state.lossReasons.push(reason);
      state.lossReason = reason;
    }
    state.lossyBytes += bytes;
  }

  private addUnavailableSpillLoss(state: MutableStreamState, code: OutputLossReasonCode): void {
    const newlyLost = state.spillUnavailable ? 0 : state.spillBytes;
    state.spillUnavailable = true;
    this.addLoss(state, code, newlyLost);
  }

  private snapshot(state: MutableStreamState): BoundedOutputStreamResult {
    const exactTail = state.tail;
    const markerText = state.lossReasons.length > 0
      ? `[runner output lossy: ${state.lossReasons.map((reason) => reason.code).join(",")}]\n`
      : "";
    const marker = Buffer.from(markerText).subarray(0, this.tailBytes);
    const displaySource = suffix(exactTail, Math.max(0, this.tailBytes - marker.byteLength));
    const display = decodeUtf8Display(displaySource);
    const tail = `${marker.toString("utf8")}${display.text}`;
    const frozenReasons = Object.freeze(
      state.lossReasons.map((reason) => Object.freeze({ ...reason }))
    );
    const frozenPrimary = frozenReasons.at(-1);
    const spillState: OutputSpillState = state.lossReason
      ? "lossy"
      : state.spillArtifactId
        ? "artifact_ingested"
        : state.spillBytes > 0
          ? "discarded"
          : "empty";
    return Object.freeze({
      stream: state.stream,
      tail,
      tailBytesBase64: exactTail.toString("base64"),
      tailByteLength: exactTail.byteLength,
      tailDisplayTruncated: exactTail.byteLength > displaySource.byteLength || display.truncated,
      totalBytes: state.totalBytes,
      truncated: state.totalBytes > exactTail.byteLength,
      spillState,
      ...(state.spillArtifactId ? { spillArtifactId: state.spillArtifactId } : {}),
      spillBytes: state.spillBytes,
      lossyBytes: state.lossyBytes,
      lossyOutput: Boolean(state.lossReason),
      ...(frozenPrimary ? { lossReason: frozenPrimary } : {}),
      lossReasons: frozenReasons,
    });
  }
}

export function createNodeOutputSpillStorage(): OutputSpillStorage {
  return {
    attest: async () => {
      const currentPrincipalIdentity = process.getuid?.();
      const available = process.platform !== "win32" && currentPrincipalIdentity !== undefined;
      return {
        currentPrincipalPrivacy: available,
        identityStableDeletion: available,
        unlinkedEntries: available,
        ...(currentPrincipalIdentity === undefined
          ? {}
          : { currentPrincipalIdentity: currentPrincipalIdentity.toString() }),
      };
    },
    prepareRoot: async (root) => await mkdir(root, { recursive: true, mode: 0o700 }).then(() => undefined),
    openExclusive: async (path) => {
      const handle = await open(path, "wx+", 0o600);
      try {
        const entry = await handle.stat();
        const currentPrincipalIdentity = process.getuid?.();
        if (
          currentPrincipalIdentity !== undefined &&
          !attestPrivateDirectoryForPrincipal(
            { ownerIdentity: entry.uid.toString(), mode: entry.mode },
            currentPrincipalIdentity.toString()
          )
        ) {
          throw new Error("Output spill entry is not private to the current principal.");
        }
        if (process.platform !== "win32" && currentPrincipalIdentity !== undefined) await unlink(path);
        return nodeSpillFile(handle, fileIdentity(entry));
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        throw error;
      }
    },
    remove: async (path) => await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    }),
    removeIdentityStable: async () => {
      throw new Error("Identity-stable linked-entry deletion is unavailable.");
    },
    list: async (root) => await readdir(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    }),
  };
}

export async function cleanupOutputSpillRoot(
  options: Pick<BoundedOutputSpoolOptions, "spillRoot" | "projectRoot" | "ownershipId"> & {
    readonly storage?: OutputSpillStorage;
  }
): Promise<void> {
  const storage = options.storage ?? createNodeOutputSpillStorage();
  let attestation: OutputSpillStorageAttestation | undefined;
  try {
    attestation = parseOutputSpillStorageAttestation(await storage.attest());
  } catch {
    return;
  }
  if (!attestation) return;
  const root = resolve(requiredText(options.spillRoot, "spillRoot"));
  try {
    await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const lease = await validateOwnedRoot(
    root,
    resolve(requiredText(options.projectRoot, "projectRoot")),
    ownershipIdentity(options.ownershipId),
    false,
    attestation.currentPrincipalIdentity
  );
  if (!attestation.unlinkedEntries) {
    for (const name of await readdir(lease.canonicalRoot)) {
      if (!name.startsWith(lease.entryPrefix) || !name.endsWith(`${SPILL_SUFFIX}${ENTRY_PROOF_SUFFIX}`)) continue;
      const proofPath = join(lease.canonicalRoot, name);
      const path = proofPath.slice(0, -ENTRY_PROOF_SUFFIX.length);
      const proof = await readEntryProof(lease, path, proofPath).catch(() => undefined);
      if (proof) {
        await removeOwnedEntry(lease, path, proofPath, proof.identity, storage).catch(() => undefined);
      }
    }
  }
  await removeOwnedRootIfEmpty(lease);
}

async function prepareOwnedRoot(
  root: string,
  projectRoot: string,
  ownershipId: string,
  currentPrincipalIdentity?: string
): Promise<OwnedSpillRoot> {
  const projectReal = await realpath(projectRoot);
  let created = false;
  try {
    await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parentReal = await realpath(dirname(root));
    const candidate = join(parentReal, basename(root));
    assertExternal(candidate, projectReal);
    await mkdir(candidate, { mode: 0o700 });
    created = true;
    const marker = {
      version: 1,
      ownershipId,
      rootId: randomUUID(),
    };
    try {
      await writeFile(join(candidate, OWNER_MARKER), JSON.stringify(marker), { flag: "wx", mode: 0o600 });
    } catch (error) {
      await rmdir(candidate).catch(() => undefined);
      throw error;
    }
  }
  try {
    return await validateOwnedRoot(root, projectReal, ownershipId, true, currentPrincipalIdentity);
  } catch (error) {
    if (created) {
      await unlink(join(root, OWNER_MARKER)).catch(() => undefined);
      await rmdir(root).catch(() => undefined);
    }
    throw error;
  }
}

async function validateOwnedRoot(
  root: string,
  projectRoot: string,
  ownershipId: string,
  projectAlreadyReal = false,
  currentPrincipalIdentity?: string
): Promise<OwnedSpillRoot> {
  const rootEntry = await lstat(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) throw new Error("Output spill root is not a private directory.");
  if (process.platform !== "win32" && (rootEntry.mode & 0o077) !== 0) {
    throw new Error("Output spill root permissions are not restrictive.");
  }
  if (
    currentPrincipalIdentity !== undefined &&
    !attestPrivateDirectoryForPrincipal(
      { ownerIdentity: rootEntry.uid.toString(), mode: rootEntry.mode },
      currentPrincipalIdentity
    )
  ) {
    throw new Error("Output spill root is not private to the current principal.");
  }
  const [rootReal, projectReal] = await Promise.all([
    realpath(root),
    projectAlreadyReal ? Promise.resolve(projectRoot) : realpath(projectRoot),
  ]);
  if (!samePath(rootReal, root)) throw new Error("Output spill root aliases another path.");
  assertExternal(rootReal, projectReal);

  const markerPath = join(rootReal, OWNER_MARKER);
  const markerEntry = await lstat(markerPath);
  if (!markerEntry.isFile() || markerEntry.isSymbolicLink()) throw new Error("Output spill ownership marker is invalid.");
  if (process.platform !== "win32" && (markerEntry.mode & 0o077) !== 0) {
    throw new Error("Output spill ownership marker permissions are not restrictive.");
  }
  if (
    currentPrincipalIdentity !== undefined &&
    !attestPrivateDirectoryForPrincipal(
      { ownerIdentity: markerEntry.uid.toString(), mode: markerEntry.mode },
      currentPrincipalIdentity
    )
  ) {
    throw new Error("Output spill ownership marker is not private to the current principal.");
  }
  const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
  if (
    marker.version !== 1 ||
    marker.ownershipId !== ownershipId ||
    typeof marker.rootId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(marker.rootId)
  ) {
    throw new Error("Output spill ownership marker does not match.");
  }
  const rootId = marker.rootId;
  return {
    canonicalRoot: rootReal,
    projectRoot: projectReal,
    ownershipId,
    rootId,
    rootIdentity: fileIdentity(rootEntry),
    markerIdentity: fileIdentity(markerEntry),
    entryPrefix: `${SPILL_PREFIX}${createHash("sha256").update(`${ownershipId}\0${rootId}`).digest("hex").slice(0, 20)}-`,
    ...(currentPrincipalIdentity === undefined ? {} : { currentPrincipalIdentity }),
  };
}

export function attestPrivateDirectoryForPrincipal(
  directory: { readonly ownerIdentity: string; readonly mode: number },
  currentPrincipalIdentity: string
): boolean {
  return directory.ownerIdentity === currentPrincipalIdentity && (directory.mode & 0o077) === 0;
}

function parseOutputSpillStorageAttestation(value: unknown): OutputSpillStorageAttestation | undefined {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) return undefined;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return undefined;
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !SPILL_ATTESTATION_KEYS.has(key))) return undefined;

  const dataValue = (key: string): unknown => {
    const descriptor = descriptors[key];
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  };
  const currentPrincipalPrivacy = dataValue("currentPrincipalPrivacy");
  const identityStableDeletion = dataValue("identityStableDeletion");
  const unlinkedEntries = dataValue("unlinkedEntries");
  if (currentPrincipalPrivacy !== true || identityStableDeletion !== true || typeof unlinkedEntries !== "boolean") {
    return undefined;
  }
  const principalDescriptor = descriptors.currentPrincipalIdentity;
  const currentPrincipalIdentity = dataValue("currentPrincipalIdentity");
  let normalizedPrincipalIdentity: string | undefined;
  if (principalDescriptor !== undefined) {
    if (typeof currentPrincipalIdentity !== "string" || currentPrincipalIdentity.length === 0) return undefined;
    normalizedPrincipalIdentity = currentPrincipalIdentity;
  }
  return Object.freeze({
    currentPrincipalPrivacy: true,
    identityStableDeletion: true,
    unlinkedEntries,
    ...(normalizedPrincipalIdentity === undefined
      ? {}
      : { currentPrincipalIdentity: normalizedPrincipalIdentity }),
  });
}

async function removeOwnedEntry(
  lease: OwnedSpillRoot,
  path: string,
  proofPath: string | undefined,
  expectedIdentity?: string,
  storage?: OutputSpillStorage,
  allowMissingProof = false
): Promise<void> {
  const current = await validateOwnedRoot(
    lease.canonicalRoot,
    lease.projectRoot,
    lease.ownershipId,
    true,
    lease.currentPrincipalIdentity
  );
  assertSameOwnedRoot(lease, current);
  const name = basename(path);
  if (!name.startsWith(lease.entryPrefix) || !name.endsWith(SPILL_SUFFIX)) {
    throw new Error("Output spill entry is not owned by this spool.");
  }
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Output spill entry identity changed.");
  if (
    lease.currentPrincipalIdentity !== undefined &&
    !attestPrivateDirectoryForPrincipal(
      { ownerIdentity: entry.uid.toString(), mode: entry.mode },
      lease.currentPrincipalIdentity
    )
  ) {
    throw new Error("Output spill entry is not private to the current principal.");
  }
  if (!expectedIdentity || fileIdentity(entry) !== expectedIdentity) {
    throw new Error("Output spill entry identity changed.");
  }
  if (!allowMissingProof) {
    if (!proofPath) throw new Error("Output spill entry ownership proof is missing.");
    await readEntryProof(lease, path, proofPath, expectedIdentity);
  }
  if (!storage || !expectedIdentity) throw new Error("Identity-stable spill deletion is unavailable.");
  await storage.removeIdentityStable(path, expectedIdentity);
  if (proofPath && !allowMissingProof) await unlink(proofPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function readEntryProof(
  lease: OwnedSpillRoot,
  path: string,
  proofPath: string,
  expectedIdentity?: string
): Promise<{ identity: string }> {
  const proofEntry = await lstat(proofPath);
  if (!proofEntry.isFile() || proofEntry.isSymbolicLink()) throw new Error("Output spill entry proof is invalid.");
  if (
    lease.currentPrincipalIdentity !== undefined &&
    !attestPrivateDirectoryForPrincipal(
      { ownerIdentity: proofEntry.uid.toString(), mode: proofEntry.mode },
      lease.currentPrincipalIdentity
    )
  ) {
    throw new Error("Output spill entry proof is not private to the current principal.");
  }
  const proof = JSON.parse(await readFile(proofPath, "utf8")) as Record<string, unknown>;
  if (
    proof.version !== 1 ||
    proof.ownershipId !== lease.ownershipId ||
    proof.rootId !== lease.rootId ||
    proof.entry !== basename(path) ||
    typeof proof.identity !== "string" ||
    (expectedIdentity !== undefined && proof.identity !== expectedIdentity)
  ) {
    throw new Error("Output spill entry proof does not match.");
  }
  return { identity: proof.identity };
}

async function removeOwnedRootIfEmpty(lease: OwnedSpillRoot): Promise<void> {
  try {
    await lstat(lease.canonicalRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const current = await validateOwnedRoot(
    lease.canonicalRoot,
    lease.projectRoot,
    lease.ownershipId,
    true,
    lease.currentPrincipalIdentity
  );
  assertSameOwnedRoot(lease, current);
  const entries = await readdir(lease.canonicalRoot);
  if (entries.some((entry) => entry !== OWNER_MARKER)) return;
  await unlink(join(lease.canonicalRoot, OWNER_MARKER));
  await rmdir(lease.canonicalRoot);
}

function assertSameOwnedRoot(expected: OwnedSpillRoot, current: OwnedSpillRoot): void {
  if (
    current.rootId !== expected.rootId ||
    current.rootIdentity !== expected.rootIdentity ||
    current.markerIdentity !== expected.markerIdentity
  ) {
    throw new Error("Output spill root identity changed.");
  }
}

function assertExternal(root: string, projectRoot: string): void {
  if (samePath(root, projectRoot) || isWithin(root, projectRoot)) {
    throw new Error("Output spill root must be outside the project.");
  }
}

function isWithin(candidate: string, parent: string): boolean {
  const rel = relative(normalizePath(parent), normalizePath(candidate));
  return !isAbsolute(rel) && rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function ownershipIdentity(value: string): string {
  const identity = requiredText(value, "ownershipId");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(identity)) throw new Error("ownershipId is invalid.");
  return identity;
}

function nodeSpillFile(handle: FileHandle, identity: string): OutputSpillFile {
  return {
    identity,
    write: async (bytes) => (await handle.write(bytes)).bytesWritten,
    sealAndRead: async (expectedBytes, maximumBytes) => {
      if (expectedBytes > maximumBytes) throw new Error("Output spill exceeds its bound.");
      await handle.sync();
      const current = await handle.stat();
      if (identity !== fileIdentity(current) || current.size !== expectedBytes) {
        throw new Error("Output spill identity or length changed.");
      }
      const bytes = Buffer.alloc(expectedBytes);
      let offset = 0;
      while (offset < expectedBytes) {
        const read = await handle.read(bytes, offset, expectedBytes - offset, offset);
        if (read.bytesRead === 0) throw new Error("Output spill ended early.");
        offset += read.bytesRead;
      }
      return bytes;
    },
    close: async () => await handle.close(),
  };
}

function freshState(stream: OutputStream): MutableStreamState {
  return {
    stream,
    tail: Buffer.alloc(0),
    totalBytes: 0,
    spillBytes: 0,
    lossyBytes: 0,
    lossReasons: [],
    spillUnavailable: false,
    finalized: false,
  };
}

function fileIdentity(value: { dev: number | bigint; ino: number | bigint }): string {
  return `${value.dev.toString()}:${value.ino.toString()}`;
}

function appendTail(current: Buffer, incoming: Buffer, maximum: number): Buffer {
  if (incoming.byteLength >= maximum) return Buffer.from(incoming.subarray(incoming.byteLength - maximum));
  const retained = Math.min(current.byteLength, maximum - incoming.byteLength);
  return Buffer.concat([current.subarray(current.byteLength - retained), incoming], retained + incoming.byteLength);
}

function suffix(bytes: Buffer, maximum: number): Buffer {
  return bytes.byteLength <= maximum ? bytes : bytes.subarray(bytes.byteLength - maximum);
}

function decodeUtf8Display(bytes: Buffer): { text: string; truncated: boolean } {
  let start = 0;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  for (let trim = 0; trim <= Math.min(3, bytes.byteLength - start); trim += 1) {
    const candidate = bytes.subarray(start, bytes.byteLength - trim);
    try {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(candidate),
        truncated: start > 0 || trim > 0,
      };
    } catch {
      // An incomplete trailing scalar can require dropping up to three bytes.
    }
  }
  return { text: "", truncated: true };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function requiredText(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required.`);
  return value;
}
