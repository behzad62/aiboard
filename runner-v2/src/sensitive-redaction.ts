const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /^(?:--?)?(?:token|password|secret|api[_-]?key|authorization)$/i;
const SENSITIVE_ASSIGNMENT = /\b(token|password|secret|api[_-]?key|authorization)\s*(?::|=|\s)\s*(?:Bearer\s+)?[^\s,;]+/gi;
const BEARER_VALUE = /\bBearer\s+[^\s,;]+/gi;
const URL_VALUE = /https?:\/\/[^\s"'<>]+/gi;

export function redactSensitiveText(value: string, maximumLength = Number.MAX_SAFE_INTEGER): string {
  return value
    .replace(URL_VALUE, redactUrl)
    .replace(SENSITIVE_ASSIGNMENT, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(BEARER_VALUE, `Bearer ${REDACTED}`)
    .slice(0, maximumLength);
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
        if (typeof previous === "string" && SENSITIVE_KEY.test(previous.trim())) return REDACTED;
        return visit(item, depth + 1);
      });
    }
    if (typeof candidate === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(candidate as Record<string, unknown>).slice(0, maximumItems)) {
        output[key] = SENSITIVE_KEY.test(key.trim()) ? REDACTED : visit(item, depth + 1);
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
      if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, REDACTED);
    }
    return url.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED);
  } catch {
    return value;
  }
}
