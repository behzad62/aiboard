const REDACTED = "[REDACTED]";
const ASSIGNMENT_CANDIDATE = /(?<![A-Za-z0-9_-])((?:--?)?[A-Za-z_][A-Za-z0-9_-]*)(\s*(?::|=)\s*|\s+)(?:Bearer\s+)?([^\s,;&]+)/g;
const BEARER_VALUE = /\bBearer\s+[^\s,;]+/gi;
const URL_VALUE = /https?:\/\/[^\s"'<>]+/gi;

export function isSensitiveKey(value: string): boolean {
  const key = value.trim().replace(/^--?/, "");
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) return false;
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
  const parts = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const compact = parts.join("");
  if (parts.some((part) => [
    "token", "password", "passwd", "passphrase", "secret",
    "authorization", "auth", "credential", "credentials",
  ].includes(part))) return true;
  return [
    "apikey", "apitoken", "accesstoken", "refreshtoken", "idtoken",
    "clientsecret", "privatekey", "authtoken", "authcredential", "authcredentials",
  ].includes(compact);
}

export function redactSensitiveText(value: string, maximumLength = Number.MAX_SAFE_INTEGER): string {
  const redactedUrls = value.replace(URL_VALUE, redactUrl);
  const redactedAssignments = redactAssignments(redactedUrls);
  return redactedAssignments.replace(BEARER_VALUE, `Bearer ${REDACTED}`).slice(0, maximumLength);
}

export function redactSensitiveValue(
  value: unknown,
  options: { maximumDepth?: number; maximumItems?: number; maximumTextLength?: number } = {},
): unknown {
  const maximumDepth = options.maximumDepth ?? 16;
  const maximumItems = options.maximumItems ?? 200;
  const maximumTextLength = options.maximumTextLength ?? Number.MAX_SAFE_INTEGER;

  const visit = (candidate: unknown, depth: number): unknown => {
    if (depth > maximumDepth) return { truncated: true };
    if (typeof candidate === "string") return redactSensitiveText(candidate, maximumTextLength);
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "number") return candidate;
    if (Array.isArray(candidate)) {
      const bounded = candidate.slice(0, maximumItems);
      return bounded.map((item, index) => {
        const previous = index > 0 ? bounded[index - 1] : undefined;
        if (typeof previous === "string" && isSensitiveKey(previous)) return REDACTED;
        return visit(item, depth + 1);
      });
    }
    if (typeof candidate === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(candidate as Record<string, unknown>).slice(0, maximumItems)) {
        output[key] = isSensitiveKey(key) ? REDACTED : visit(item, depth + 1);
      }
      return output;
    }
    return redactSensitiveText(String(candidate), maximumTextLength);
  };

  return visit(value, 0);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) url.searchParams.set(key, REDACTED);
    }
    return url.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED);
  } catch {
    return value;
  }
}

function redactAssignments(value: string): string {
  let output = value;
  ASSIGNMENT_CANDIDATE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ASSIGNMENT_CANDIDATE.exec(output)) !== null) {
    const key = match[1]!;
    if (!isSensitiveKey(key)) {
      ASSIGNMENT_CANDIDATE.lastIndex = match.index + key.length;
      continue;
    }
    const replacement = `${key}=${REDACTED}`;
    output = `${output.slice(0, match.index)}${replacement}${output.slice(match.index + match[0].length)}`;
    ASSIGNMENT_CANDIDATE.lastIndex = match.index + replacement.length;
  }
  return output;
}
