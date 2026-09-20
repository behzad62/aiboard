/** The Node.js LTS release line certified by this Runner V2 release. */
export const SUPPORTED_NODE_LTS_LINES = [24] as const;

/** Human-readable policy shared by the CLI, client, and published guidance. */
export const NODE_RUNTIME_POLICY_DESCRIPTION = "Node.js 24.x";

export interface NodeVersionAssessment {
  supported: boolean;
  version: string;
  major?: number;
  reason: "supported" | "malformed" | "unsupported_release_line";
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (!parts.every((part) => Number.isSafeInteger(part))) return null;
  return parts as [number, number, number];
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
  return { supported: true, version, major, reason: "supported" };
}

export function supportsNodeVersion(version: string): boolean {
  return assessNodeVersion(version).supported;
}

export function assertSupportedNodeVersion(version: string): void {
  const assessment = assessNodeVersion(version);
  if (assessment.supported) return;
  throw new Error(
    `node_version_mismatch: Runner V2 supports the certified Node.js 24.x LTS release line. Received ${version}.`
  );
}
