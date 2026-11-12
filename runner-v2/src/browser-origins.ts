/**
 * The browser origins a Runner port answers: loopback origins, AI Board's own site, and the
 * `--allow-origin` list. Shared by the control port and the model proxy port (HM3), so both apply
 * one rule.
 */

const ALLOWED_RUNNER_EXTRA_ORIGINS = new Set<string>([
  "https://aiboard.me",
  "https://www.aiboard.me",
]);

export function normalizeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

export function isLoopbackOrigin(origin: string): boolean {
  const url = new URL(origin);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    url.pathname === "/" &&
    !url.username &&
    !url.password
  );
}

export function isAllowedBrowserOrigin(
  normalizedOrigin: string,
  allowedOrigins: ReadonlySet<string>
): boolean {
  if (isLoopbackOrigin(normalizedOrigin)) {
    return true;
  }
  return allowedOrigins.has(normalizedOrigin);
}

export function buildAllowedOriginSet(allowedOrigins?: string[]): ReadonlySet<string> {
  const resolved = new Set<string>(ALLOWED_RUNNER_EXTRA_ORIGINS);
  if (!allowedOrigins) return resolved;
  for (const origin of allowedOrigins) {
    const normalized = normalizeOrigin(origin);
    if (normalized) {
      resolved.add(normalized);
    }
  }
  return resolved;
}
