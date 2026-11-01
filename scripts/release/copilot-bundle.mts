// Pin the exact lockfile-resolved Copilot platform package for each release target.
// Bundles do not carry the package (~270 MB, and its license allows only unmodified redistribution); they carry
// this pin as app/runner-v2/copilot-runtime.json, and the Runner downloads and verifies the package on first use
// (runner-v2/src/copilot-runtime.ts). npm only installs the build host's platform package, so the pin is read
// from package-lock.json, independently of the host.
import { parseCopilotRuntimePin, type CopilotRuntimePin } from "../../runner-v2/src/copilot-runtime.js";
import type { ReleaseTarget } from "../../runner-v2/src/release-manifest.js";

interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  os?: string[];
  cpu?: string[];
}
export interface CopilotLock { packages: Record<string, LockEntry> }

/** Bundle path of the pin; the Runner reads it beside its src/ folder. */
export const COPILOT_PIN_PATH = "app/runner-v2/copilot-runtime.json";

export function copilotRuntimePin(lock: CopilotLock, target: ReleaseTarget): CopilotRuntimePin {
  const [platform, arch] = target.split("-");
  const os = platform === "win" ? "win32" : platform;
  const name = `@github/copilot-${os}-${arch}`;
  const sdk = "node_modules/@github/copilot-sdk";
  if (!lock.packages[sdk]?.dependencies?.["@github/copilot"] ||
      lock.packages[`${sdk}/node_modules/@github/copilot`] || lock.packages[`${sdk}/node_modules/${name}`]) {
    throw new Error("The Copilot SDK uses an unsupported nested dependency layout; review the lockfile before building.");
  }
  const entry = lock.packages[`node_modules/${name}`];
  const declared = lock.packages["node_modules/@github/copilot"]?.optionalDependencies?.[name];
  if (!entry || !declared || entry.version !== declared || !entry.os?.includes(os!) || !entry.cpu?.includes(arch!)) {
    throw new Error(`The lockfile has no matching Copilot platform package for ${target}.`);
  }
  if (!entry.resolved || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity ?? "")) {
    throw new Error(`The lockfile does not pin a SHA-512 package archive for ${name}.`);
  }
  try {
    return parseCopilotRuntimePin({ schemaVersion: 1, name, version: entry.version, url: entry.resolved, integrity: entry.integrity });
  } catch {
    throw new Error(`The Copilot package ${name} does not use the approved npm registry.`);
  }
}

export function copilotPinFile(lock: CopilotLock, target: ReleaseTarget): { path: string; data: Buffer; mode: number } {
  return { path: COPILOT_PIN_PATH, data: Buffer.from(`${JSON.stringify(copilotRuntimePin(lock, target), null, 2)}\n`), mode: 0o644 };
}
