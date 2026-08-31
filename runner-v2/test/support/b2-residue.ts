import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
const MAX_ENTRIES = 4_096;

export interface B2ResidueEntry { readonly path: string; readonly prefix: string }

export function inventoryB2Residue(): readonly B2ResidueEntry[] {
  const temporary = resolve(tmpdir());
  return readdirSync(temporary, { withFileTypes: true })
    .filter((entry) => entry.name !== "aiboard-portable-processes" && B2_PREFIXES.some((prefix) => entry.name.startsWith(prefix)))
    .map((entry) => ({ path: resolve(temporary, entry.name), prefix: B2_PREFIXES.find((prefix) => entry.name.startsWith(prefix))! }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function cleanProvenB2Residue(entries: readonly B2ResidueEntry[] = inventoryB2Residue()): readonly string[] {
  const processes = processInventory();
  const removed: string[] = [];
  for (const entry of entries) {
    const kind = exactB2EntryKind(entry);
    if (!kind) continue;
    if (kind === "coordination") {
      if (!isSettledCoordinationDatabase(entry.path) || processes.some((process) => referencesRoot(process.commandLine, entry.path))) continue;
      rmSync(entry.path, { force: true, maxRetries: 30, retryDelay: 50 });
      removed.push(entry.path);
      continue;
    }
    const evidence = inspectEvidence(entry.path);
    if (!evidence.valid) continue;
    if (processes.some((process) => referencesRoot(process.commandLine, entry.path))) continue;
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
    if (status.isDirectory()) return "root";
    if (status.isFile() && basename(path).endsWith(".fence.lock")) return "coordination";
    return undefined;
  } catch { return undefined; }
}

function isSettledCoordinationDatabase(path: string): boolean {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path);
    database.exec("PRAGMA busy_timeout=100; BEGIN IMMEDIATE");
    const names = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')").all().map((row) => String(row.name)));
    for (const required of ["owned_fence_protocol", "owned_fence_acquisition", "owned_fence_holder", "owned_fence_acquisition_immutable"])
      if (!names.has(required)) return false;
    const protocol = database.prepare("SELECT * FROM owned_fence_protocol").all() as Array<Record<string, unknown>>;
    if (protocol.length !== 1 || protocol[0]?.version !== 1 || !Number.isSafeInteger(protocol[0].retired) || ![0, 1].includes(Number(protocol[0].retired))) return false;
    if (Number(database.prepare("SELECT COUNT(*) AS count FROM owned_fence_acquisition").get()!.count) !== 0) return false;
    if (Number(database.prepare("SELECT COUNT(*) AS count FROM owned_fence_holder").get()!.count) !== 0) return false;
    if (protocol[0].retired === 0) database.prepare("UPDATE owned_fence_protocol SET retired = 1 WHERE retired = 0").run();
    database.exec("COMMIT");
    return true;
  } catch { try { database?.exec("ROLLBACK"); } catch {} return false; }
  finally { database?.close(); }
}

interface RecordedOwner { pid: number; birth?: string; recordedAt?: string; enumeratedBeforeRoot?: true }

function inspectEvidence(root: string): { valid: boolean; owners: RecordedOwner[] } {
  const owners: RecordedOwner[] = [];
  const pending = [root];
  let entries = 0;
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
        for (const document of documents) collectEvidence(JSON.parse(document), owners);
      }
    }
    return { valid: true, owners };
  } catch { return { valid: false, owners: [] }; }
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

function processInventory(): Array<{ pid: number; birth: string; commandLine: string }> {
  if (process.platform === "win32") {
    const encoded = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop';Get-CimInstance Win32_Process|ForEach-Object{$b=if($null-eq$_.CreationDate){''}else{$_.CreationDate.ToUniversalTime().ToString('o')};$c=if($null-eq$_.CommandLine){''}else{$_.CommandLine};$j=@{pid=[int]$_.ProcessId;birth=$b;commandLine=$c}|ConvertTo-Json -Compress;[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))}",
    ], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
    return encoded.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(Buffer.from(line, "base64").toString("utf8")));
  }
  const output = execFileSync("ps", ["-e", "-o", "pid=,lstart=,args="], { encoding: "utf8", timeout: 5_000 });
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(.{24})\s+(.*)$/);
    if (!match) throw new Error("process inventory is malformed");
    return { pid: Number(match[1]), birth: match[2]!.trim(), commandLine: match[3]! };
  });
}

function referencesRoot(commandLine: string, root: string): boolean {
  const normalized = resolve(root).toLowerCase();
  if (commandLine.toLowerCase().includes(normalized)) return true;
  for (const token of commandLine.split(/\s+/)) {
    if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) continue;
    try { if (Buffer.from(token, "base64url").toString("utf8").toLowerCase().includes(normalized)) return true; }
    catch {}
  }
  return false;
}

function sameBirth(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/(\.\d{6})\d+(Z)$/, "$1$2");
  return normalize(left) === normalize(right);
}
