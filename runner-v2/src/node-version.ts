export const MINIMUM_NODE_VERSION = "24.18.0";

function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function supportsNodeVersion(version: string): boolean {
  const actual = parseVersion(version);
  const minimum = parseVersion(MINIMUM_NODE_VERSION);
  if (!actual || !minimum) return false;
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

export function assertSupportedNodeVersion(version: string): void {
  if (supportsNodeVersion(version)) return;
  throw new Error(
    `node_version_mismatch: Runner V2 requires Node.js ${MINIMUM_NODE_VERSION} or newer; received ${version}.`
  );
}
