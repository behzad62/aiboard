import { AsyncLocalStorage } from "node:async_hooks";
import type { BigIntStats } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";

import { resolveProtectedLocations, type ProtectedLocation, type ProtectedLocations } from "./protected-locations.js";

/**
 * Last-mile deny guard for remote and local_mcp file tools (ADR-D, D17).
 * It checks the actual target — supplied spelling, every parent, the final
 * canonical object and object identity — never grant text or model input.
 * Commands are deliberately not guarded here; they run as the OS user.
 */

export type RemotePathMode = "read" | "write" | "create" | "delete" | "list" | "search";

export type RemotePathDenialReason =
  | "protected_location"
  | "protected_locations_unavailable"
  | "malformed_path"
  | "alternate_data_stream"
  | "device_namespace"
  | "device_name"
  | "trailing_dot_or_space"
  | "unc_path"
  | "hardlink_alias"
  | "hardlink_confinement_unprovable"
  | "identity_unprovable"
  | "outside_only_here";

export class RemotePathDeniedError extends Error {
  readonly code: "path_denied" | "outside_only_here";
  constructor(
    readonly reason: RemotePathDenialReason,
    /** Protected category, or the denial class when no protected root matched. */
    readonly category: string,
    message: string,
  ) {
    super(message);
    this.name = "RemotePathDeniedError";
    this.code = reason === "outside_only_here" ? "outside_only_here" : "path_denied";
  }
}

/** No secret values and no raw target path: tool, principal, category, reason only. */
export interface RemotePathAuditRecord {
  readonly toolName: string;
  readonly principal: string;
  readonly pathCategory: string;
  readonly reasonCode: RemotePathDenialReason;
  readonly mode: RemotePathMode;
}

export interface RemotePathCheckContext {
  readonly toolName?: string;
  readonly principal?: string;
}

export interface RemotePathGuardOptions {
  readonly onDenied?: (record: RemotePathAuditRecord) => void;
  readonly maxProtectedScanEntries?: number;
  readonly maxTreeEntries?: number;
  /** Tests only, to reach the folder-reuse path: see RACY_WINDOW_MS. Lowering it in production risks a stale scan. */
  readonly scanRacyWindowMs?: number;
}

interface ObjectIdentity { readonly dev: bigint; readonly ino: bigint }
interface ProtectedCanonical {
  readonly location: ProtectedLocation;
  readonly canonical: string;
  /** False when the root could not be canonicalized and `canonical` is only its configured spelling. */
  readonly resolved: boolean;
  readonly identity?: ObjectIdentity;
}
/** Windows: the target's volume serial and the folded drive (path root) of its canonical path. */
interface WindowsVolume { readonly dev: bigint; readonly drive: string }

/** What a scan saw of one object. A folder with the same stamp still holds the same entries. */
interface Stamp { readonly dev: bigint; readonly ino: bigint; readonly mtimeNs: bigint; readonly ctimeNs: bigint }
/** One protected path as the last scan saw it (see `observe`). */
interface ScanNode {
  readonly path: string;
  readonly category: string;
  readonly depth: number;
  /** listed: a folder whose entries were read; skipped: a folder that cannot hold the target's identity. */
  readonly mode: "missing" | "failed" | "file" | "other" | "skipped" | "listed";
  readonly stamp?: Stamp;
  /** A listed folder that changed so recently that it may change again within the same clock tick. */
  readonly relist?: boolean;
  /** Linux: a file whose path was a mount point when it was observed. */
  readonly mountPoint?: boolean;
  readonly children: readonly ScanNode[];
}
interface ScanFailure { readonly path: string; readonly follow: boolean }
interface ScanResult { readonly identities: ReadonlyMap<string, string>; readonly complete: boolean }
interface ScanState {
  roots?: readonly (ScanNode | undefined)[];
  result?: ScanResult;
  /** Paths that made the last scan incomplete; it is refreshed once all of them can be read. */
  failures: readonly ScanFailure[];
  /** Over the entry cap or the depth limit: the result stays a refusal for the guard's lifetime. */
  capped: boolean;
  /** Linux: the mount table changed during the last pass, or could not be read. */
  mountsMoved: boolean;
  running?: { readonly startedAt: number; readonly promise: Promise<ScanResult> };
}
interface ScanPass {
  readonly targetDevice: bigint;
  readonly mounts?: readonly MountEntry[];
  /** Linux: every mount point in the table, files included. */
  readonly mountPoints?: ReadonlySet<string>;
  /**
   * False when no file node may be kept without a syscall: on Linux a file can be a mount point, and
   * a mount moves neither of its folder's times, so files are kept only against a mount table that
   * was readable and did not change during the last pass.
   */
  readonly reuseFiles: boolean;
  seen: number;
  capped: boolean;
  readonly failures: ScanFailure[];
}

/**
 * A folder changed within this long of being listed may change again in the same timestamp tick
 * without moving its times (NTFS ticks are coarse, ext3 and HFS+ keep whole seconds), so it is
 * listed again on the next check.
 */
const RACY_WINDOW_MS = 10_000;
export interface RemotePathScope {
  readonly workspace: string;
  readonly restricted: () => boolean;
  lastDenied?: RemotePathAuditRecord;
}

// Win32 also treats the superscript digits ¹ ² ³ as COM/LPT device suffixes.
const DEVICE_SUFFIXES = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"];
const DEVICE_NAMES = new Set(["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
  ...DEVICE_SUFFIXES.map((suffix) => `COM${suffix}`), ...DEVICE_SUFFIXES.map((suffix) => `LPT${suffix}`)]);

export class RemotePathGuard {
  readonly locations: ProtectedLocations;
  private readonly paths: typeof win32 | typeof posix;
  private readonly caseInsensitive: boolean;
  private readonly audit: RemotePathAuditRecord[] = [];
  private readonly onDenied?: (record: RemotePathAuditRecord) => void;
  private readonly maxProtectedScanEntries: number;
  private readonly maxTreeEntries: number;
  private readonly racyWindowNs: bigint;
  private protectedCanonicals?: Promise<readonly ProtectedCanonical[]>;
  private readonly protectedScans = new Map<string, ScanState>();
  private scanSequence = 0;
  private readonly scopes = new AsyncLocalStorage<RemotePathScope>();

  constructor(locations: ProtectedLocations, options: RemotePathGuardOptions = {}) {
    this.locations = locations;
    this.paths = locations.platform === "win32" ? win32 : posix;
    this.caseInsensitive = locations.platform === "win32" || locations.platform === "darwin";
    this.onDenied = options.onDenied;
    this.maxProtectedScanEntries = options.maxProtectedScanEntries ?? 20_000;
    this.maxTreeEntries = options.maxTreeEntries ?? 10_000;
    this.racyWindowNs = BigInt(Math.max(0, Math.floor(options.scanRacyWindowMs ?? RACY_WINDOW_MS))) * 1_000_000n;
  }

  auditRecords(): readonly RemotePathAuditRecord[] {
    return this.audit.map((record) => Object.freeze({ ...record }));
  }

  withWorkspaceScope<T>(workspace: string, restricted: () => boolean, action: (scope: RemotePathScope) => Promise<T>): Promise<T> {
    const scope: RemotePathScope = { workspace, restricted };
    return this.scopes.run(scope, () => action(scope));
  }

  /** Check a process cwd without applying the file-tool exclusion list to commands. */
  async assertWithinWorkspace(target: string, workspace: string, context: RemotePathCheckContext = {}): Promise<void> {
    try {
      this.checkSyntax(target);
      const resolved = await this.canonicalize(this.paths.resolve(target));
      await this.assertCanonicalWithinWorkspace(resolved.canonical, resolved.exists, workspace);
    } catch (error) {
      if (error instanceof RemotePathDeniedError) this.record(context, "read", error);
      throw error;
    }
  }

  async assertAllowed(target: string, mode: RemotePathMode, context: RemotePathCheckContext = {}): Promise<string> {
    try {
      return await this.check(target, mode);
    } catch (error) {
      if (error instanceof RemotePathDeniedError) this.record(context, mode, error);
      throw error;
    }
  }

  /** Post-create re-check: the object now exists, so identity checks see it. */
  async assertAllowedAfterCreate(target: string, mode: RemotePathMode, context: RemotePathCheckContext = {}): Promise<string> {
    return await this.assertAllowed(target, mode, context);
  }

  async isDenied(target: string): Promise<boolean> {
    try { await this.check(target, "read"); return false; } catch { return true; }
  }

  /** Refuse a move/delete whose tree contains any denied descendant (ADR-D). */
  async assertTreeAllowed(root: string, mode: RemotePathMode, context: RemotePathCheckContext = {}): Promise<void> {
    try {
      let seen = 0;
      const visit = async (candidate: string): Promise<void> => {
        seen += 1;
        if (seen > this.maxTreeEntries) throw new RemotePathDeniedError("identity_unprovable", "identity_unprovable", "The tree is too large to prove it contains no protected object.");
        await this.check(candidate, mode);
        let info;
        try { info = await lstat(candidate); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        if (!info.isDirectory() || info.isSymbolicLink()) return;
        for (const name of await readdir(candidate)) await visit(this.paths.join(candidate, name));
      };
      await visit(root);
    } catch (error) {
      if (error instanceof RemotePathDeniedError) this.record(context, mode, error);
      throw error;
    }
  }

  private record(context: RemotePathCheckContext, mode: RemotePathMode, error: RemotePathDeniedError): void {
    const record: RemotePathAuditRecord = Object.freeze({
      toolName: context.toolName ?? "unknown",
      principal: context.principal ?? "unknown",
      pathCategory: error.category,
      reasonCode: error.reason,
      mode,
    });
    this.audit.push(record);
    const scope = this.scopes.getStore();
    if (scope) scope.lastDenied = record;
    this.onDenied?.(record);
  }

  private async check(target: string, _mode: RemotePathMode): Promise<string> {
    if (this.locations.failClosed) {
      throw new RemotePathDeniedError("protected_locations_unavailable", "protected_locations_unavailable",
        `Protected locations could not be determined (${this.locations.failures.join("; ")}); remote file tools refuse.`);
    }
    this.checkSyntax(target);
    const absolute = this.paths.resolve(target);
    this.checkSyntax(absolute);
    const lexicalHit = this.matchProtected(absolute);
    if (lexicalHit) throw denied(lexicalHit);

    const { canonical, exists } = await this.canonicalize(absolute);
    const scope = this.scopes.getStore();
    if (scope?.restricted()) await this.assertCanonicalWithinWorkspace(canonical, exists, scope.workspace);
    const canonicalHit = this.matchProtected(canonical);
    if (canonicalHit) throw denied(canonicalHit);

    const protectedRoots = await this.canonicalProtectedRoots();
    // A root configured through an alias (symlinked home, /var vs /private/var)
    // must also deny its canonical spelling, even before the root exists.
    for (const root of protectedRoots) {
      if (this.isWithin(canonical, root.canonical, root.location.kind)) throw denied(root.location);
    }
    // Object identity catches mount/8.3/volume aliases the spelling hides:
    // the target and each existing ancestor are compared with denied roots.
    for (const prefix of this.prefixes(canonical)) {
      const identity = await identityOf(prefix);
      if (!identity) continue;
      for (const root of protectedRoots) {
        if (root.identity && root.identity.dev === identity.dev && root.identity.ino === identity.ino) throw denied(root.location);
      }
    }
    if (exists) {
      let info;
      try { info = await lstat(canonical, { bigint: true }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return canonical;
        throw new RemotePathDeniedError("identity_unprovable", "identity_unprovable", "The target identity could not be established.");
      }
      if (info.isFile() && info.nlink > 1n) await this.checkHardLink(canonical, { dev: info.dev, ino: info.ino });
    }
    return canonical;
  }

  private checkSyntax(target: string): void {
    if (typeof target !== "string" || target.length === 0 || target.includes("\0")) {
      throw new RemotePathDeniedError("malformed_path", "malformed_path", "The path is empty or contains a NUL byte.");
    }
    if (this.locations.platform !== "win32") return;
    const slashed = target.replaceAll("/", "\\");
    if (slashed.startsWith("\\\\")) {
      if (/^\\\\[.?]\\/.test(slashed) || /GLOBALROOT/i.test(slashed)) {
        throw new RemotePathDeniedError("device_namespace", "device_namespace", "Device namespaces are not available to remote file tools.");
      }
      if (slashed.startsWith("\\\\?\\")) {
        throw new RemotePathDeniedError("device_namespace", "device_namespace", "Extended-length and volume aliases cannot be proved safe for remote file tools.");
      }
      throw new RemotePathDeniedError("unc_path", "unc_path", "UNC paths are not supported by remote file tools.");
    }
    if (/^[a-zA-Z]:(?![\\/])/.test(target)) {
      throw new RemotePathDeniedError("malformed_path", "malformed_path", "Drive-relative paths are ambiguous for remote file tools.");
    }
    for (const segment of target.split(/[\\/]+/)) {
      if (!segment || segment === "." || segment === "..") continue;
      if (/^[a-zA-Z]:$/.test(segment)) continue;
      if (segment.includes(":")) {
        throw new RemotePathDeniedError("alternate_data_stream", "alternate_data_stream", "Alternate data streams are not available to remote file tools.");
      }
      if (segment.endsWith(".") || segment.endsWith(" ")) {
        throw new RemotePathDeniedError("trailing_dot_or_space", "trailing_dot_or_space", "Path segments ending in a dot or space are ambiguous for remote file tools.");
      }
      if (DEVICE_NAMES.has(segment.split(".")[0]!.toUpperCase())) {
        throw new RemotePathDeniedError("device_name", "device_name", "Device names are not available to remote file tools.");
      }
    }
  }

  private fold(value: string): string {
    const normalized = value.replaceAll("/", this.paths.sep).replaceAll("\\", this.paths.sep);
    // macOS volumes are normalization-insensitive: compare one Unicode form.
    const unicode = this.locations.platform === "darwin" ? normalized.normalize("NFC") : normalized;
    return this.caseInsensitive ? unicode.toLowerCase() : unicode;
  }

  private isWithin(candidate: string, rootPath: string, kind: ProtectedLocation["kind"]): boolean {
    const folded = this.fold(this.paths.resolve(candidate));
    const root = this.fold(this.paths.resolve(rootPath));
    if (folded === root) return true;
    const prefix = root.endsWith(this.paths.sep) ? root : `${root}${this.paths.sep}`;
    return kind === "directory" && folded.startsWith(prefix);
  }

  private matchProtected(candidate: string): ProtectedLocation | undefined {
    return this.locations.locations.find((location) => this.isWithin(candidate, location.path, location.kind));
  }

  private async canonicalize(absolute: string): Promise<{ canonical: string; exists: boolean }> {
    let current = absolute;
    const missing: string[] = [];
    for (;;) {
      try {
        await lstat(current);
        let resolved: string;
        try { resolved = await realpath(current); }
        catch { throw new RemotePathDeniedError("identity_unprovable", "identity_unprovable", "An existing path could not be resolved."); }
        if (!this.rootedPath(resolved)) {
          throw new RemotePathDeniedError("identity_unprovable", "identity_unprovable", "An existing path resolved to a location with no drive or share.");
        }
        return { canonical: this.paths.resolve(resolved, ...missing.reverse()), exists: missing.length === 0 };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          throw new RemotePathDeniedError("identity_unprovable", "identity_unprovable", "A parent path could not be verified for the remote file tool.");
        }
        const parent = this.paths.dirname(current);
        if (parent === current) {
          throw new RemotePathDeniedError("identity_unprovable", "identity_unprovable", "No existing parent could be verified for the remote file tool.");
        }
        missing.push(this.paths.basename(current));
        current = parent;
      }
    }
  }

  /**
   * A canonical path must name its volume: a drive or a share on Windows. libuv strips `\\?\` from
   * GetFinalPathNameByHandleW, so a volume with no DOS name would come back as `Volume{GUID}\…`,
   * which `resolve` would silently place under the current directory.
   */
  private rootedPath(resolved: string): boolean {
    // realpath's spelling is the host's, whatever platform the locations were classified for.
    if (process.platform !== "win32") return resolved.startsWith("/");
    return /^[a-zA-Z]:[\\/]/.test(resolved) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(resolved);
  }

  private async assertCanonicalWithinWorkspace(canonical: string, exists: boolean, workspace: string): Promise<void> {
    const root = await this.canonicalize(this.paths.resolve(workspace));
    const rootIdentity = root.exists ? await identityOf(root.canonical) : undefined;
    if (!rootIdentity) throw new RemotePathDeniedError("identity_unprovable", "identity_unprovable", "The workspace identity could not be verified.");
    let found = false;
    if (this.isWithin(canonical, root.canonical, "directory")) {
      for (const prefix of this.prefixes(canonical)) {
        const identity = await identityOf(prefix);
        if (identity && identity.dev === rootIdentity.dev && identity.ino === rootIdentity.ino) { found = true; break; }
      }
    }
    if (!found) throw new RemotePathDeniedError("outside_only_here", "outside_only_here", "The target is outside the only-here workspace.");
    if (exists) {
      const info = await lstat(canonical, { bigint: true });
      if (info.isFile() && info.nlink > 1n) throw new RemotePathDeniedError("hardlink_confinement_unprovable", "hardlink_confinement_unprovable", "A multi-link file cannot be confined to the workspace.");
    }
  }

  private prefixes(canonical: string): string[] {
    const result: string[] = [];
    let current = canonical;
    for (;;) {
      result.push(current);
      const parent = this.paths.dirname(current);
      if (parent === current) return result;
      current = parent;
    }
  }

  private canonicalProtectedRoots(): Promise<readonly ProtectedCanonical[]> {
    this.protectedCanonicals ??= (async () => {
      const roots: ProtectedCanonical[] = [];
      for (const location of this.locations.locations) {
        // A missing root is canonicalized through its nearest existing parent,
        // so creating it later through an aliased parent is still denied.
        let canonical = location.path;
        let resolved = false;
        try { canonical = (await this.canonicalize(this.paths.resolve(location.path))).canonical; resolved = true; }
        catch { /* Unverifiable roots still deny lexically. */ }
        const identity = await identityOf(canonical);
        roots.push({ location, canonical, resolved, ...(identity ? { identity } : {}) });
      }
      return Object.freeze(roots);
    })();
    return this.protectedCanonicals;
  }

  private async checkHardLink(canonical: string, identity: ObjectIdentity): Promise<void> {
    // Object identity is (device, inode), so only protected files on the target's device can alias it.
    // On Windows the scan also depends on the target's drive, so two volumes sharing a serial never share a scan.
    const volume = this.windowsVolume(canonical, identity.dev);
    const key = volume ? `${identity.dev}|${volume.drive}` : String(identity.dev);
    const { identities, complete } = await this.currentProtectedScan(key, identity.dev, volume);
    const category = identities.get(`${identity.dev}:${identity.ino}`);
    if (category) {
      throw new RemotePathDeniedError("hardlink_alias", category, "The file is a hard link to a protected file.");
    }
    if (!complete) {
      throw new RemotePathDeniedError("hardlink_confinement_unprovable", "hardlink_confinement_unprovable",
        "A multi-link file cannot be proved not to alias a protected file.");
    }
  }

  /**
   * The protected-file scan as it stands now. A check uses only a scan that started after the check
   * did, or one it has just brought up to date (`refreshProtectedScan`), so a protected file created
   * after an earlier check is still found. An incomplete scan only ever refuses, so it is kept until
   * every path that made it incomplete can be read again; one over the entry cap is kept for good.
   */
  private async currentProtectedScan(key: string, targetDevice: bigint, volume: WindowsVolume | undefined): Promise<ScanResult> {
    const begun = ++this.scanSequence;
    let state = this.protectedScans.get(key);
    if (!state) {
      state = { failures: [], capped: false, mountsMoved: false };
      this.protectedScans.set(key, state);
    }
    for (;;) {
      const running = state.running;
      if (running) {
        const result = await running.promise;
        if (running.startedAt > begun) return result;
        continue;
      }
      const last = state.result;
      if (last && !last.complete && (state.capped || await stillUnreadable(state.failures))) return last;
      if (state.running) continue;
      const entry = { startedAt: ++this.scanSequence, promise: this.refreshProtectedScan(state, targetDevice, volume) };
      state.running = entry;
      try { return await entry.promise; } finally { if (state.running === entry) state.running = undefined; }
    }
  }

  /**
   * Brings the scan up to date and collects the identities of protected files that could share
   * `targetDevice`. `complete` is false whenever part of a protected tree could not be enumerated: an
   * unreadable folder, an entry that cannot be stat'ed, or the entry cap. On Linux a subtree is skipped
   * only when the kernel mount table proves it holds nothing on the target's device (see
   * `skippableSubtree`); /proc and /sys can never be enumerated, so without that proof no multi-link
   * file could ever be allowed there. On Windows a whole protected folder on another volume is skipped
   * (see `onAnotherWindowsVolume`); the browser profiles and the AIBoard data root far exceed the cap.
   */
  private async refreshProtectedScan(state: ScanState, targetDevice: bigint, volume: WindowsVolume | undefined): Promise<ScanResult> {
    const linux = this.locations.platform === "linux" && process.platform === "linux";
    const mountText = linux ? await readMountText() : undefined;
    const mounts = mountText === undefined ? undefined : parseMountInfo(mountText);
    const pass: ScanPass = {
      targetDevice,
      ...(mounts ? { mounts, mountPoints: new Set(mounts.map((mount) => mount.mountPoint)) } : {}),
      reuseFiles: !linux || (mounts !== undefined && !state.mountsMoved),
      seen: 0, capped: false, failures: [],
    };
    const identities = new Map<string, string>();
    const roots: (ScanNode | undefined)[] = [];
    for (const [index, root] of (await this.canonicalProtectedRoots()).entries()) {
      if (root.location.kind === "file") {
        roots.push(undefined);
        try {
          const info = await stat(root.canonical, { bigint: true });
          if (info.ino === 0n) pass.failures.push({ path: root.canonical, follow: true });
          else identities.set(`${info.dev}:${info.ino}`, root.location.category);
        } catch (error) {
          if (!isMissing(error)) pass.failures.push({ path: root.canonical, follow: true });
        }
        continue;
      }
      const onAnotherVolume = volume ? (info: BigIntStats) => this.onAnotherWindowsVolume(root, info, volume) : undefined;
      roots.push(await this.observe(root.canonical, root.location.category, 0, state.roots?.[index], pass, onAnotherVolume));
    }
    if (pass.seen > this.maxProtectedScanEntries) pass.capped = true;
    // A mount made during this pass may have been seen by some lstat and not by the table read above.
    if (linux) state.mountsMoved = mounts === undefined || await readMountText() !== mountText;
    for (const node of roots) if (node) collectIdentities(node, identities);
    state.roots = pass.capped ? undefined : roots;
    state.failures = pass.failures;
    state.capped = pass.capped;
    state.result = { identities, complete: !pass.capped && pass.failures.length === 0 };
    return state.result;
  }

  /**
   * Looks at one protected path, reusing what the last scan saw there wherever that still provably
   * holds. A listed folder whose identity, modification time and change time are all unchanged still
   * holds the same entries: creating, linking, renaming or deleting an entry moves both times, and a
   * file keeps its identity while it keeps its name. So its files are kept without a syscall, while
   * its folders and links, which can change without touching it (a mount, a junction retargeted in
   * place), are looked at again, and so is any file that is or was a mount point (Linux can bind-mount
   * over a file; see `ScanPass.reuseFiles`). A folder that changed within RACY_WINDOW_MS of being
   * listed is listed again next time, since a second change in the same timestamp tick would not
   * move its times.
   */
  private async observe(path: string, category: string, depth: number, previous: ScanNode | undefined, pass: ScanPass,
    onAnotherVolume?: (info: BigIntStats) => boolean): Promise<ScanNode> {
    if (pass.capped || depth > 32 || pass.seen >= this.maxProtectedScanEntries) {
      pass.capped = true;
      return { path, category, depth, mode: "failed", children: [] };
    }
    const observedAt = BigInt(Date.now()) * 1_000_000n;
    let info: BigIntStats;
    try { info = await lstat(path, { bigint: true }); } catch (error) {
      // Only a missing entry is benign; anything else hides an object the scan cannot identify.
      if (isMissing(error)) return { path, category, depth, mode: "missing", children: [] };
      pass.failures.push({ path, follow: false });
      return { path, category, depth, mode: "failed", children: [] };
    }
    pass.seen += 1;
    const stamp: Stamp = { dev: info.dev, ino: info.ino, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs };
    if (info.isFile()) {
      return { path, category, depth, mode: "file", stamp, ...(pass.mountPoints?.has(path) ? { mountPoint: true } : {}), children: [] };
    }
    if (!info.isDirectory() || info.isSymbolicLink()) return { path, category, depth, mode: "other", stamp, children: [] };
    const earlier = new Map((previous?.children ?? []).map((child) => [child.path, child]));
    if (pass.mounts && info.dev !== pass.targetDevice && skippableSubtree(pass.mounts, path, info.dev)) {
      // Nothing on this filesystem can share the target's identity; filesystems mounted below it still can.
      const children: ScanNode[] = [];
      for (const mountPoint of topSubmounts(pass.mounts, path)) {
        children.push(await this.observe(mountPoint, category, depth + 1, earlier.get(mountPoint), pass));
      }
      return { path, category, depth, mode: "skipped", stamp, children };
    }
    if (onAnotherVolume?.(info)) return { path, category, depth, mode: "skipped", stamp, children: [] };
    if (previous?.mode === "listed" && !previous.relist && sameStamp(previous.stamp, stamp)) {
      const children = await Promise.all(previous.children.map(async (child) => {
        if (child.mode !== "file" || !pass.reuseFiles || child.mountPoint || pass.mountPoints?.has(child.path)) {
          return await this.observe(child.path, category, depth + 1, child, pass);
        }
        pass.seen += 1;
        return child;
      }));
      return { path, category, depth, mode: "listed", stamp, relist: false, children };
    }
    let names: string[];
    try { names = await readdir(path); } catch {
      pass.failures.push({ path, follow: false });
      return { path, category, depth, mode: "failed", stamp, children: [] };
    }
    const children: ScanNode[] = [];
    for (const name of names) {
      const child = this.paths.join(path, name);
      children.push(await this.observe(child, category, depth + 1, earlier.get(child), pass));
    }
    const newest = info.mtimeNs > info.ctimeNs ? info.mtimeNs : info.ctimeNs;
    return { path, category, depth, mode: "listed", stamp, relist: newest >= observedAt - this.racyWindowNs, children };
  }

  /** Windows only: the target's volume serial and drive, or undefined when the drive proof cannot apply. */
  private windowsVolume(canonical: string, dev: bigint): WindowsVolume | undefined {
    if (this.locations.platform !== "win32" || process.platform !== "win32" || dev === 0n) return undefined;
    const drive = win32.parse(canonical).root;
    return drive ? { dev, drive: this.fold(drive) } : undefined;
  }

  /**
   * True when a protected folder provably holds no other name of the target. NTFS and ReFS hard links
   * never cross volumes, so every name of the target is on its volume. Windows `realpath`
   * (GetFinalPathNameByHandleW) spells a file as its volume's DOS name plus its path on that volume,
   * so every name of the target canonicalizes onto the target's drive. A folder whose canonical path
   * is on another drive and whose volume serial differs therefore cannot hold one by location. What it
   * shows through a volume mount point or a volume junction canonicalizes onto its own volume, where
   * the guard allows it even as a single-link file; drive-letter junctions and symlinks are never
   * followed. Both the serial and the drive must differ (several shares of one server volume have one
   * serial but different drives), the folder must exist and report a serial (0 means unknown), and an
   * unresolved root keeps its configured spelling, which may be a junction, so it is always scanned.
   * ReFS's 64-bit file IDs are not unique, which can only add false aliases, never hide one.
   */
  private onAnotherWindowsVolume(root: ProtectedCanonical, info: BigIntStats, volume: WindowsVolume): boolean {
    // `observe` asks only about a root that lstat shows as a real directory.
    if (!root.resolved || info.dev === 0n || info.dev === volume.dev) return false;
    const drive = win32.parse(root.canonical).root;
    return drive !== "" && this.fold(drive) !== volume.drive;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function sameStamp(left: Stamp | undefined, right: Stamp): boolean {
  return left !== undefined && left.dev === right.dev && left.ino === right.ino &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function collectIdentities(node: ScanNode, identities: Map<string, string>): void {
  if (node.mode === "file" && node.stamp) identities.set(`${node.stamp.dev}:${node.stamp.ino}`, node.category);
  for (const child of node.children) collectIdentities(child, identities);
}

/** True while any path that made the last scan incomplete still cannot be read. */
async function stillUnreadable(failures: readonly ScanFailure[]): Promise<boolean> {
  for (const failure of failures) {
    try {
      if (failure.follow) {
        if ((await stat(failure.path, { bigint: true })).ino === 0n) return true;
      } else if ((await lstat(failure.path)).isDirectory()) {
        await readdir(failure.path);
      }
    } catch (error) {
      if (!isMissing(error)) return true;
    }
  }
  return false;
}

/** One row of /proc/self/mountinfo: where a filesystem is mounted, its device and its type. */
export interface MountEntry {
  readonly mountPoint: string;
  readonly device: bigint;
  readonly fsType: string;
}

/**
 * Filesystems on which every object reports the superblock's own device number. Overlayfs (whose
 * non-directories can report a lower layer's device), btrfs (whose subvolumes have their own device
 * numbers without a mount), network, FUSE and automount filesystems are deliberately absent: a
 * subtree on them is always scanned.
 */
const UNIFORM_DEVICE_FILESYSTEMS = new Set([
  "ext2", "ext3", "ext4", "xfs", "tmpfs", "ramfs", "devtmpfs", "proc", "sysfs", "devpts", "mqueue",
  "cgroup", "cgroup2", "securityfs", "debugfs", "tracefs", "pstore", "bpf", "configfs", "binfmt_misc",
  "hugetlbfs", "efivarfs", "fusectl", "nsfs", "rpc_pipefs",
]);

async function readMountText(): Promise<string | undefined> {
  try { return await readFile("/proc/self/mountinfo", "utf8"); } catch { return undefined; }
}

/** Parses /proc/self/mountinfo; any malformed row makes the whole table unusable (undefined). */
export function parseMountInfo(text: string): MountEntry[] | undefined {
  const entries: MountEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split(" ");
    const separator = fields.indexOf("-", 6);
    const numbers = /^(\d+):(\d+)$/.exec(fields[2] ?? "");
    if (separator < 0 || !numbers || fields.length < separator + 2) return undefined;
    const mountPoint = fields[4]!.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    if (!mountPoint.startsWith("/")) return undefined;
    entries.push({ mountPoint, device: linuxDeviceNumber(BigInt(numbers[1]!), BigInt(numbers[2]!)), fsType: fields[separator + 1]! });
  }
  return entries.length > 0 ? entries : undefined;
}

/** glibc/musl `makedev`, which libuv uses for `st_dev`; every use is cross-checked against lstat. */
function linuxDeviceNumber(major: bigint, minor: bigint): bigint {
  return ((major & 0xfffff000n) << 32n) | ((major & 0xfffn) << 8n) | ((minor & 0xffffff00n) << 12n) | (minor & 0xffn);
}

function mountWithin(child: string, parent: string): boolean {
  return parent === "/" ? child !== "/" && child.startsWith("/") : child.startsWith(`${parent}/`);
}

/**
 * A directory's subtree holds only its own filesystem plus whatever is mounted below it. The subtree
 * can be skipped (apart from those mounts) only when the mount that holds the directory is a
 * uniform-device filesystem whose table device matches what lstat reports. A mismatch means the
 * table cannot be trusted for this path, so the subtree is scanned.
 */
function skippableSubtree(mounts: readonly MountEntry[], directory: string, device: bigint): boolean {
  let holder: MountEntry | undefined;
  for (const mount of mounts) {
    if (mount.mountPoint !== directory && !mountWithin(directory, mount.mountPoint)) continue;
    // The deepest mount point wins; of several at one point, the last listed is the visible one.
    if (!holder || mount.mountPoint.length >= holder.mountPoint.length) holder = mount;
  }
  return holder !== undefined && holder.device === device && UNIFORM_DEVICE_FILESYSTEMS.has(holder.fsType);
}

/** Mount points strictly below `directory` that are not themselves below another such mount point. */
function topSubmounts(mounts: readonly MountEntry[], directory: string): string[] {
  const below = [...new Set(mounts.map((mount) => mount.mountPoint).filter((point) => mountWithin(point, directory)))];
  return below.filter((point) => !below.some((other) => other !== point && mountWithin(point, other)));
}

function denied(location: ProtectedLocation): RemotePathDeniedError {
  return new RemotePathDeniedError("protected_location", location.category,
    `Remote file tools cannot access ${location.category} locations.`);
}

async function identityOf(path: string): Promise<ObjectIdentity | undefined> {
  try {
    const info = await stat(path, { bigint: true });
    return info.ino === 0n ? undefined : { dev: info.dev, ino: info.ino };
  } catch { return undefined; }
}

export function createRemotePathGuard(
  locations: ProtectedLocations = resolveProtectedLocations(),
  options: RemotePathGuardOptions = {},
): RemotePathGuard {
  return new RemotePathGuard(locations, options);
}

/** Guard entry point: `assertRemotePathAllowed(target, mode, guard?)`. */
export async function assertRemotePathAllowed(
  target: string,
  mode: RemotePathMode = "read",
  guard?: RemotePathGuard | ProtectedLocations,
  context: RemotePathCheckContext = {},
): Promise<string> {
  const resolved = guard instanceof RemotePathGuard ? guard : createRemotePathGuard(guard);
  return await resolved.assertAllowed(target, mode, context);
}

/**
 * A fixed deny that every tool broker applies to every actor at every level, independent of the
 * remote/local_mcp guard above (Simple Build plan §5.8: the AIBoard home's credentials, write lock
 * and key, and writes to its config). It resolves the target the way the guard does: the supplied
 * spelling, the canonical path through symlinks and junctions (the nearest existing parent for a
 * missing leaf), and object identity, so a hard link, an 8.3 name or a junction to a denied file or
 * to one of its parent folders is refused too. On Windows an alternate-data-stream suffix and
 * trailing dots or spaces are stripped first, since Win32 opens the same file through them.
 */
export interface FixedDenyEntry {
  readonly path: string;
  /** "all" refuses read, write and delete; "mutate" refuses write and delete only. */
  readonly modes: "all" | "mutate";
  readonly category: string;
  /** "prefix": also any sibling whose name starts with the entry's name (temporary files of a key). */
  readonly match?: "exact" | "prefix";
}

export interface FixedDenyHit {
  readonly category: string;
  readonly message: string;
}

export type FixedDenyAccess = "read" | "write" | "delete";

export class FixedPathDeny {
  private readonly paths: typeof win32 | typeof posix;
  private readonly caseInsensitive: boolean;

  constructor(readonly entries: readonly FixedDenyEntry[], readonly platform: NodeJS.Platform = process.platform) {
    this.paths = platform === "win32" ? win32 : posix;
    this.caseInsensitive = platform === "win32" || platform === "darwin";
  }

  /**
   * `tree` covers operations that act on a folder's contents (delete, move, search): they are refused
   * when the folder holds a denied entry, even though the folder itself is not denied.
   */
  async check(target: string, access: FixedDenyAccess, options: { tree?: boolean } = {}): Promise<FixedDenyHit | undefined> {
    if (this.entries.length === 0) return undefined;
    if (typeof target !== "string" || target.length === 0 || target.includes("\0")) {
      return { category: "malformed_path", message: "The path is empty or contains a NUL byte." };
    }
    const tree = options.tree === true || access === "delete";
    const absolute = this.stripAliases(this.paths.resolve(target));
    const canonical = await this.canonical(absolute);
    const targetIdentity = await identityOf(canonical);
    for (const entry of this.entries) {
      if (entry.modes === "mutate" && access === "read") continue;
      const entryPath = this.paths.resolve(entry.path);
      const entryCanonical = await this.canonical(entryPath);
      const hit: FixedDenyHit = { category: entry.category, message: `Tools cannot ${access === "read" ? "read" : "change"} ${entry.category} files; they change only through AI Board's settings routes and commands.` };
      for (const spelling of [absolute, canonical]) {
        for (const denied of [entryPath, entryCanonical]) {
          if (this.same(spelling, denied) || (entry.match === "prefix" && this.siblingPrefix(spelling, denied))) return hit;
          if (tree && this.within(denied, spelling)) return hit;
        }
      }
      if (!targetIdentity) continue;
      const entryIdentity = await identityOf(entryCanonical);
      if (entryIdentity && entryIdentity.dev === targetIdentity.dev && entryIdentity.ino === targetIdentity.ino) return hit;
      if (tree) {
        let current = this.paths.dirname(entryCanonical);
        for (;;) {
          const identity = await identityOf(current);
          if (identity && identity.dev === targetIdentity.dev && identity.ino === targetIdentity.ino) return hit;
          const parent = this.paths.dirname(current);
          if (parent === current) break;
          current = parent;
        }
      }
    }
    return undefined;
  }

  private stripAliases(absolute: string): string {
    // UNC and device-namespace spellings keep their prefix; canonical and identity checks still apply.
    if (this.platform !== "win32" || /^[\\/]{2}/.test(absolute)) return absolute;
    const [root, ...segments] = absolute.split(/[\\/]+/);
    const cleaned = segments.map((segment) => {
      const stream = segment.indexOf(":");
      const base = stream >= 0 ? segment.slice(0, stream) : segment;
      return base.replace(/[. ]+$/, "") || base;
    });
    return this.paths.resolve([root, ...cleaned].join("\\") || absolute);
  }

  private async canonical(absolute: string): Promise<string> {
    let current = absolute;
    const missing: string[] = [];
    for (;;) {
      try {
        const resolved = await realpath(current);
        return this.paths.resolve(resolved, ...[...missing].reverse());
      } catch {
        const parent = this.paths.dirname(current);
        if (parent === current) return absolute;
        missing.push(this.paths.basename(current));
        current = parent;
      }
    }
  }

  private fold(value: string): string {
    const normalized = this.paths.resolve(value).replaceAll("/", this.paths.sep).replaceAll("\\", this.paths.sep);
    const unicode = this.platform === "darwin" ? normalized.normalize("NFC") : normalized;
    return this.caseInsensitive ? unicode.toLowerCase() : unicode;
  }

  private same(left: string, right: string): boolean {
    return this.fold(left) === this.fold(right);
  }

  private siblingPrefix(candidate: string, denied: string): boolean {
    return this.same(this.paths.dirname(candidate), this.paths.dirname(denied)) &&
      this.fold(this.paths.basename(candidate)).startsWith(this.fold(this.paths.basename(denied)));
  }

  /** True when `inner` is inside the folder `outer`. */
  private within(inner: string, outer: string): boolean {
    const folded = this.fold(inner);
    const root = this.fold(outer);
    const prefix = root.endsWith(this.paths.sep) ? root : `${root}${this.paths.sep}`;
    return folded !== root && folded.startsWith(prefix);
  }
}
