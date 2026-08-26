/** The maintained LTS release lines certified by this Runner V2 release. */
export const SUPPORTED_NODE_LTS_LINES = [22, 24] as const;

/** Node 22's first release with unflagged node:sqlite support. */
export const NODE_SQLITE_MINIMUM_VERSION = "22.13.0";

/** Human-readable policy shared by the CLI, client, and published guidance. */
export const NODE_RUNTIME_POLICY_DESCRIPTION =
  "Node.js 22.x or 24.x (Node 22.x requires 22.13.0 or newer for node:sqlite)";

export interface NodeVersionAssessment {
  supported: boolean;
  version: string;
  major?: number;
  reason: "supported" | "malformed" | "unsupported_release_line" | "sqlite_capability_floor";
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (!parts.every((part) => Number.isSafeInteger(part))) return null;
  return parts as [number, number, number];
}

function compareVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number]
): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

export function assessNodeVersion(version: string): NodeVersionAssessment {
  const actual = parseVersion(version);
  if (!actual) return { supported: false, version, reason: "malformed" };
  const [major] = actual;
  if (!(SUPPORTED_NODE_LTS_LINES as readonly number[]).includes(major)) {
    return {
      supported: false,
      version,
      major,
      reason: "unsupported_release_line",
    };
  }
  if (major === 22) {
    const floor = parseVersion(NODE_SQLITE_MINIMUM_VERSION)!;
    if (compareVersion(actual, floor) < 0) {
      return {
        supported: false,
        version,
        major,
        reason: "sqlite_capability_floor",
      };
    }
  }
  return { supported: true, version, major, reason: "supported" };
}

export function supportsNodeVersion(version: string): boolean {
  return assessNodeVersion(version).supported;
}

export function assertSupportedNodeVersion(version: string): void {
  const assessment = assessNodeVersion(version);
  if (assessment.supported) return;
  const detail = assessment.reason === "sqlite_capability_floor"
    ? ` Node 22.x needs ${NODE_SQLITE_MINIMUM_VERSION} or newer for unflagged node:sqlite support.`
    : "";
  throw new Error(
    `node_version_mismatch: Runner V2 supports maintained LTS release lines 22.x and 24.x.${detail} Received ${version}.`
  );
}
