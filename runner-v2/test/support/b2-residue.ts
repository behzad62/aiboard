import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const B2_PREFIXES = Object.freeze([
  "aiboard-portable-",
  "aiboard-posix-",
  "aiboard-windows-",
  "aiboard-managed-",
  "aiboard-owned-fence-lock-",
  "runner-job-host-",
] as const);
const DELETION_ROOT_PREFIXES = Object.freeze([
  "aiboard-owned-fence-lock-residue-",
  "aiboard-owned-fence-lock-uncertain-",
  "aiboard-owned-fence-lock-authority-retire-",
  "aiboard-portable-temporal-enumeration-",
  "aiboard-portable-signal-effect-fence-",
  "aiboard-portable-published-stale-input-",
  "aiboard-windows-temporal-reuse-",
  "aiboard-windows-launch-cleanup-",
  "aiboard-windows-semantic-duplex-",
  "aiboard-windows-semantic-cleanup-",
  "aiboard-windows-semantic-corrupt-descendant-stop-",
] as const);
const DELETION_COORDINATION_PREFIXES = Object.freeze(["aiboard-windows-residue-"] as const);
const TEST_INVOCATION_ID = randomUUID();
const MAX_ENTRIES = 4_096;

export interface B2ResidueEntry { readonly path: string; readonly prefix: string }
interface B2ResidueProcess {
  readonly pid: number;
  readonly birth: string;
  readonly parentPid: number;
  readonly executableAccessible: boolean;
  readonly commandLineAccessible: boolean;
  readonly executable: string;
  readonly commandLine: string;
}
export interface B2ResidueCleanupOperations {
  readonly processInventory?: () => readonly B2ResidueProcess[];
}

export function registerCurrentB2TestRoot(root: string): void {
  const resolvedRoot = resolve(root);
  if (!isRegisteredRoot(resolvedRoot) || dirname(resolvedRoot) !== resolve(tmpdir())) throw new Error("B2 test root is not registered for deletion.");
  const status = lstatSync(resolvedRoot);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("B2 test root must be a real directory.");
  writeFileSync(resolve(resolvedRoot, ".b2-test-owner.json"), JSON.stringify({
    protocol: "aiboard-b2-test-root/v1",
    invocationId: TEST_INVOCATION_ID,
    rootName: basename(resolvedRoot),
  }), { mode: 0o600 });
}

export function inventoryB2Residue(): readonly B2ResidueEntry[] {
  const temporary = resolve(tmpdir());
  return readdirSync(temporary, { withFileTypes: true })
    .filter((entry) => entry.name !== "aiboard-portable-processes" && B2_PREFIXES.some((prefix) => entry.name.startsWith(prefix)))
    .map((entry) => ({ path: resolve(temporary, entry.name), prefix: B2_PREFIXES.find((prefix) => entry.name.startsWith(prefix))! }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function cleanProvenB2Residue(
  entries: readonly B2ResidueEntry[] = inventoryB2Residue(),
  operations: B2ResidueCleanupOperations = {},
): readonly string[] {
  let processes: readonly B2ResidueProcess[];
  try { processes = validateProcessInventory(operations.processInventory?.() ?? processInventory()); }
  catch { return []; }
  const removed: string[] = [];
  for (const entry of entries) {
    const kind = exactB2EntryKind(entry);
    if (!kind) continue;
    let createdAt: number;
    try { createdAt = Math.floor(lstatSync(entry.path).birthtimeMs); }
    catch { continue; }
    if (!Number.isFinite(createdAt) || createdAt <= 0 || processes.some((process) => unresolvedProcessReference(process, entry.path, createdAt))) continue;
    if (kind === "coordination") {
      if (!isSettledCoordinationDatabase(entry.path)) continue;
      rmSync(entry.path, { force: true, maxRetries: 30, retryDelay: 50 });
      removed.push(entry.path);
      continue;
    }
    const evidence = inspectEvidence(entry.path);
    if (!evidence.valid) continue;
    let uncertain = false;
    for (const owner of evidence.owners) {
      const process = processes.find((candidate) => candidate.pid === owner.pid);
      if (!process) continue;
      if (owner.enumeratedBeforeRoot === true) continue;
      if (!owner.birth && owner.recordedAt && Date.parse(process.birth) > Date.parse(owner.recordedAt)) continue;
      if (!owner.birth || sameBirth(process.birth, owner.birth)) { uncertain = true; break; }
    }
    if (uncertain) continue;
    rmSync(entry.path, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
    removed.push(entry.path);
  }
  return removed;
}

function exactB2EntryKind(entry: B2ResidueEntry): "root" | "coordination" | undefined {
  const path = resolve(entry.path);
  if (dirname(path) !== resolve(tmpdir()) || basename(path) === entry.prefix || basename(path) === "aiboard-portable-processes" || !basename(path).startsWith(entry.prefix)) return undefined;
  if (!B2_PREFIXES.includes(entry.prefix as (typeof B2_PREFIXES)[number])) return undefined;
  try {
    const status = lstatSync(path);
    if (status.isSymbolicLink()) return undefined;
    if (status.isDirectory() && isRegisteredRoot(path)) return "root";
    if (status.isFile() && !status.isSymbolicLink() && status.nlink === 1 && basename(path).endsWith(".fence.lock") &&
        DELETION_COORDINATION_PREFIXES.some((prefix) => basename(path).startsWith(prefix))) return "coordination";
    return undefined;
  } catch { return undefined; }
}

function isSettledCoordinationDatabase(path: string): boolean {
  let database: DatabaseSync | undefined;
  try {
    const initialStatus = lstatSync(path);
    if (!initialStatus.isFile() || initialStatus.isSymbolicLink() || initialStatus.nlink !== 1) return false;
    database = new DatabaseSync(path);
    database.exec("PRAGMA busy_timeout=100; BEGIN IMMEDIATE");
    const names = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')").all().map((row) => String(row.name)));
    for (const required of ["owned_fence_protocol", "owned_fence_acquisition", "owned_fence_holder", "owned_fence_acquisition_immutable"])
      if (!names.has(required)) return false;
    const columns = database.prepare("PRAGMA table_info(owned_fence_protocol)").all().map((row) => String(row.name));
    const bound = columns.length === 3 && columns[0] === "version" && columns[1] === "retired" && columns[2] === "authority_id";
    if (!bound || !names.has("owned_fence_authority_immutable") || !names.has("owned_fence_authority_delete_immutable")) return false;
    const protocol = database.prepare("SELECT * FROM owned_fence_protocol").all() as Array<Record<string, unknown>>;
    if (protocol.length !== 1 || protocol[0]?.version !== 1 || !Number.isSafeInteger(protocol[0].retired) || ![0, 1].includes(Number(protocol[0].retired))) return false;
    if (protocol[0]?.authority_id !== coordinationAuthorityId(path)) return false;
    if (Number(database.prepare("SELECT COUNT(*) AS count FROM owned_fence_acquisition").get()!.count) !== 0) return false;
    if (Number(database.prepare("SELECT COUNT(*) AS count FROM owned_fence_holder").get()!.count) !== 0) return false;
    if (protocol[0].retired === 0) database.prepare("UPDATE owned_fence_protocol SET retired = 1 WHERE retired = 0").run();
    const finalStatus = lstatSync(path);
    if (!finalStatus.isFile() || finalStatus.isSymbolicLink() || finalStatus.nlink !== 1) return false;
    database.exec("COMMIT");
    return true;
  } catch { try { database?.exec("ROLLBACK"); } catch {} return false; }
  finally { database?.close(); }
}

function coordinationAuthorityId(path: string): string {
  const normalized = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return createHash("sha256").update(`aiboard-owned-fence-path/v1\0${normalized}`).digest("hex");
}

interface RecordedOwner { pid: number; birth?: string; recordedAt?: string; enumeratedBeforeRoot?: true }

function inspectEvidence(root: string): { valid: boolean; owners: RecordedOwner[] } {
  const owners: RecordedOwner[] = [];
  const pending = [root];
  let entries = 0;
  let recognizedDocuments = 0;
  try {
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        entries += 1;
        if (entries > MAX_ENTRIES || entry.isSymbolicLink()) return { valid: false, owners: [] };
        const path = resolve(directory, entry.name);
        if (!path.startsWith(`${resolve(root)}\\`) && !path.startsWith(`${resolve(root)}/`)) return { valid: false, owners: [] };
        if (entry.isDirectory()) { pending.push(path); continue; }
        if (!entry.isFile() || (!entry.name.endsWith(".json") && !entry.name.endsWith(".jsonl"))) continue;
        const text = readFileSync(path, "utf8");
        if (text.length > 4 * 1024 * 1024) return { valid: false, owners: [] };
        const documents = entry.name.endsWith(".jsonl") ? text.split(/\r?\n/).filter(Boolean) : [text];
        for (const document of documents) {
          const value = JSON.parse(document);
          if (recognizedOwnershipDocument(entry.name, value, root)) recognizedDocuments += 1;
          collectEvidence(value, owners);
        }
      }
    }
    return { valid: recognizedDocuments > 0, owners };
  } catch { return { valid: false, owners: [] }; }
}

function isRegisteredRoot(root: string): boolean {
  return DELETION_ROOT_PREFIXES.some((prefix) => basename(root).startsWith(prefix));
}

function recognizedOwnershipDocument(name: string, value: unknown, root: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (name === ".b2-test-owner.json")
    return record.protocol === "aiboard-b2-test-root/v1" && record.invocationId === TEST_INVOCATION_ID && record.rootName === basename(root);
  return name === "state.json" && record.protocol === "aiboard-portable-process/v1" &&
    typeof record.nonce === "string" && record.nonce.length > 0 &&
    Number.isSafeInteger(record.supervisorPid) && Number(record.supervisorPid) > 0 &&
    ["started", "not_started", "unknown"].includes(String(record.launchEffect));
}

function collectEvidence(value: unknown, owners: RecordedOwner[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) collectEvidence(item, owners); return; }
  const record = value as Record<string, unknown>;
  if ("nonce" in record && (typeof record.nonce !== "string" || record.nonce.length === 0)) throw new Error("invalid nonce");
  if ("launchEffect" in record && !["prepared", "started", "not_started", "unknown"].includes(String(record.launchEffect))) throw new Error("invalid launch effect");
  const recordedAt = typeof record.updatedAt === "string" && Number.isFinite(Date.parse(record.updatedAt)) ? record.updatedAt : undefined;
  for (const [pidKey, birthKey] of [["supervisorPid", "supervisorBirth"], ["pid", "birth"]] as const) {
    if (!(pidKey in record)) continue;
    if (pidKey === "pid" && record[pidKey] === 0 && record[birthKey] === undefined) continue; // Job record before child assignment.
    if (!Number.isSafeInteger(record[pidKey]) || Number(record[pidKey]) < 1) throw new Error("invalid process identity");
    const birth = record[birthKey];
    if (birth !== undefined && (typeof birth !== "string" || birth.length === 0)) throw new Error("invalid process birth");
    owners.push({ pid: Number(record[pidKey]), ...(typeof birth === "string" ? { birth } : {}), ...(recordedAt ? { recordedAt } : {}) });
  }
  const rootBirth = validProcessRecord(record.rootProcess) ? record.rootProcess.birth : undefined;
  if (Array.isArray(record.knownProcesses)) {
    for (const process of record.knownProcesses) {
      if (!validProcessRecord(process)) throw new Error("invalid known process");
      owners.push({
        pid: process.pid,
        birth: process.birth,
        ...(rootBirth && Date.parse(process.birth) < Date.parse(rootBirth) ? { enumeratedBeforeRoot: true as const } : {}),
        ...(recordedAt ? { recordedAt } : {}),
      });
    }
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === "knownProcesses") continue;
    collectEvidence(child, owners);
  }
}

function validProcessRecord(value: unknown): value is { pid: number; birth: string } {
  return !!value && typeof value === "object" && Number.isSafeInteger((value as { pid?: unknown }).pid) && Number((value as { pid: number }).pid) > 0 &&
    typeof (value as { birth?: unknown }).birth === "string" && (value as { birth: string }).birth.length > 0;
}

function processInventory(): B2ResidueProcess[] {
  if (process.platform === "win32") {
    const encoded = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop';$p=@(Get-CimInstance Win32_Process);if($p.Count-lt1-or$p.Count-gt4096){throw 'invalid process count'};foreach($x in $p){$b=if($null-eq$x.CreationDate){''}else{$x.CreationDate.ToUniversalTime().ToString('o')};$ea=$null-ne$x.ExecutablePath;$e=if($ea){[string]$x.ExecutablePath}else{''};$ca=$null-ne$x.CommandLine;$c=if($ca){[string]$x.CommandLine}else{''};$j=@{pid=[int]$x.ProcessId;birth=$b;parentPid=[int]$x.ParentProcessId;executableAccessible=$ea;commandLineAccessible=$ca;executable=$e;commandLine=$c}|ConvertTo-Json -Compress;[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))};'COMPLETE:'+$p.Count",
    ], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
    const lines = encoded.split(/\r?\n/).filter(Boolean);
    const completion = /^COMPLETE:(\d+)$/.exec(lines.pop() ?? "");
    if (!completion || lines.length !== Number(completion[1])) throw new Error("B2 process inventory is incomplete.");
    return validateProcessInventory(lines.map((line) => JSON.parse(Buffer.from(line, "base64").toString("utf8"))));
  }
  const output = execFileSync("ps", ["-e", "-o", "pid=,lstart=,args="], { encoding: "utf8", timeout: 5_000 });
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(.{24})\s+(.*)$/);
    if (!match) throw new Error("process inventory is malformed");
    return {
      pid: Number(match[1]), birth: new Date(match[2]!.trim()).toISOString(), parentPid: 0,
      executableAccessible: true, commandLineAccessible: true, executable: "", commandLine: match[3]!,
    };
  });
}

function validateProcessInventory(processes: readonly Partial<B2ResidueProcess>[]): B2ResidueProcess[] {
  if (processes.length < 1 || processes.length > MAX_ENTRIES || processes.some((process) =>
    !Number.isSafeInteger(process.pid) || Number(process.pid) < 0 ||
    !Number.isSafeInteger(process.parentPid) || Number(process.parentPid) < 0 ||
    typeof process.birth !== "string" || !Number.isFinite(Date.parse(process.birth)) ||
    typeof process.executableAccessible !== "boolean" || typeof process.commandLineAccessible !== "boolean" ||
    typeof process.executable !== "string" || typeof process.commandLine !== "string" ||
    !process.executableAccessible && process.executable !== "" || !process.commandLineAccessible && process.commandLine !== ""))
    throw new Error("B2 process inventory is invalid.");
  return processes as B2ResidueProcess[];
}

function unresolvedProcessReference(process: B2ResidueProcess, root: string, rootCreatedAt: number): boolean {
  if (process.executableAccessible && referencesRoot(process.executable, root) ||
      process.commandLineAccessible && referencesRoot(process.commandLine, root)) return true;
  return (!process.executableAccessible || !process.commandLineAccessible) && !(Date.parse(process.birth) < rootCreatedAt);
}

function referencesRoot(value: string, root: string): boolean {
  try {
    if (value.length > 64 * 1024) return true;
    const normalized = resolve(root).toLowerCase();
    const jsonEscaped = JSON.stringify(resolve(root)).slice(1, -1).toLowerCase();
    if (value.toLowerCase().includes(normalized)) return true;
    const candidates = [...value.matchAll(/[A-Za-z0-9+\/_-]{40,}={0,2}/g)].map((match) => match[0]);
    if (candidates.length > 256) return true;
    for (const candidate of candidates) {
      for (const decoded of decodeBase64Phases(candidate)) {
        if (decoded.byteLength > 64 * 1024) return true;
        const text = decoded.toString("utf8");
        const normalizedText = text.toLowerCase();
        if (normalizedText.includes(normalized) || normalizedText.includes(jsonEscaped)) return true;
        try { if (decodedPayloadReferencesRoot(JSON.parse(text), normalized)) return true; } catch {}
      }
    }
    return false;
  } catch { return true; }
}

function decodeBase64Phases(value: string): readonly Buffer[] {
  const unpadded = value.replace(/=+$/, "");
  if (unpadded.length < 40) return [];
  const encodings: BufferEncoding[] = ["base64url", "base64"];
  const decoded: Buffer[] = [];
  const seen = new Set<string>();
  for (const encoding of encodings) {
    for (let offset = 0; offset < 4; offset += 1) {
      for (let trim = 0; trim < 4; trim += 1) {
        const phase = unpadded.slice(offset, trim === 0 ? undefined : -trim);
        if (phase.length < 40 || phase.length % 4 === 1) continue;
        const bytes = Buffer.from(phase, encoding);
        const key = bytes.toString("base64");
        if (!seen.has(key)) { seen.add(key); decoded.push(bytes); }
      }
    }
  }
  return decoded;
}

function decodedPayloadReferencesRoot(value: unknown, normalizedRoot: string, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof value === "string") {
    try { return resolve(value).toLowerCase().startsWith(normalizedRoot); }
    catch { return false; }
  }
  if (Array.isArray(value)) return value.length <= 256 && value.some((item) => decodedPayloadReferencesRoot(item, normalizedRoot, depth + 1));
  if (!value || typeof value !== "object") return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 256 && entries.some(([, item]) => decodedPayloadReferencesRoot(item, normalizedRoot, depth + 1));
}

function sameBirth(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/(\.\d{6})\d+(Z)$/, "$1$2");
  return normalize(left) === normalize(right);
}
