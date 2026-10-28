import { lstat, readdir, realpath, stat } from "node:fs/promises";
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
  | "identity_unprovable";

export class RemotePathDeniedError extends Error {
  readonly code = "path_denied";
  constructor(
    readonly reason: RemotePathDenialReason,
    /** Protected category, or the denial class when no protected root matched. */
    readonly category: string,
    message: string,
  ) {
    super(message);
    this.name = "RemotePathDeniedError";
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
}

interface ObjectIdentity { readonly dev: bigint; readonly ino: bigint }
interface ProtectedCanonical { readonly location: ProtectedLocation; readonly canonical: string; readonly identity?: ObjectIdentity }

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
  private protectedCanonicals?: Promise<readonly ProtectedCanonical[]>;
  private protectedFileIdentities?: Promise<{ readonly identities: ReadonlyMap<string, string>; readonly complete: boolean }>;

  constructor(locations: ProtectedLocations, options: RemotePathGuardOptions = {}) {
    this.locations = locations;
    this.paths = locations.platform === "win32" ? win32 : posix;
    this.caseInsensitive = locations.platform === "win32" || locations.platform === "darwin";
    this.onDenied = options.onDenied;
    this.maxProtectedScanEntries = options.maxProtectedScanEntries ?? 20_000;
    this.maxTreeEntries = options.maxTreeEntries ?? 10_000;
  }

  auditRecords(): readonly RemotePathAuditRecord[] {
    return this.audit.map((record) => Object.freeze({ ...record }));
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
        const resolved = await realpath(current);
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
        try { canonical = (await this.canonicalize(this.paths.resolve(location.path))).canonical; }
        catch { /* Unverifiable roots still deny lexically. */ }
        const identity = await identityOf(canonical);
        roots.push({ location, canonical, ...(identity ? { identity } : {}) });
      }
      return Object.freeze(roots);
    })();
    return this.protectedCanonicals;
  }

  private async checkHardLink(canonical: string, identity: ObjectIdentity): Promise<void> {
    this.protectedFileIdentities ??= this.scanProtectedFileIdentities();
    const { identities, complete } = await this.protectedFileIdentities;
    const category = identities.get(`${identity.dev}:${identity.ino}`);
    if (category) {
      throw new RemotePathDeniedError("hardlink_alias", category, "The file is a hard link to a protected file.");
    }
    if (!complete) {
      throw new RemotePathDeniedError("hardlink_confinement_unprovable", "hardlink_confinement_unprovable",
        "A multi-link file cannot be proved not to alias a protected file.");
    }
  }

  private async scanProtectedFileIdentities(): Promise<{ identities: ReadonlyMap<string, string>; complete: boolean }> {
    const identities = new Map<string, string>();
    let seen = 0;
    let complete = true;
    const visit = async (candidate: string, category: string, depth: number): Promise<void> => {
      if (!complete || depth > 32) { if (depth > 32) complete = false; return; }
      let info;
      try { info = await lstat(candidate, { bigint: true }); } catch { return; }
      seen += 1;
      if (seen > this.maxProtectedScanEntries) { complete = false; return; }
      if (info.isFile()) { identities.set(`${info.dev}:${info.ino}`, category); return; }
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      let names: string[];
      try { names = await readdir(candidate); } catch { complete = false; return; }
      for (const name of names) await visit(this.paths.join(candidate, name), category, depth + 1);
    };
    for (const root of await this.canonicalProtectedRoots()) {
      if (root.location.kind === "file") {
        const identity = await identityOf(root.canonical);
        if (identity) identities.set(`${identity.dev}:${identity.ino}`, root.location.category);
      } else {
        await visit(root.canonical, root.location.category, 0);
      }
    }
    return { identities, complete };
  }
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
