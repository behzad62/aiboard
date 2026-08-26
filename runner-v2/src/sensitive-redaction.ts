const REDACTED = "[REDACTED]";
const ASSIGNMENT_CANDIDATE = /(?<![A-Za-z0-9_-])((?:--?)?[A-Za-z_][A-Za-z0-9_-]*)(\s*(?::|=)\s*|\s+)(?:Bearer\s+)?([^\s,;&]+)/g;
const BEARER_VALUE = /\bBearer\s+[^\s,;]+/gi;
const URL_VALUE = /https?:\/\/[^\s"'<>]+/gi;
const MAXIMUM_JSON_TEXT_DEPTH = 8;
const MAXIMUM_JSON_CONTAINER_ATTEMPTS = 64;

interface RedactionLimits {
  maximumDepth: number;
  maximumItems: number;
  maximumTextLength: number;
}

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
  return redactSensitiveTextInternal(value, {
    maximumDepth: 16,
    maximumItems: 200,
    maximumTextLength: maximumLength,
  }, 0);
}

function redactSensitiveTextInternal(
  value: string,
  limits: RedactionLimits,
  jsonTextDepth: number,
): string {
  const redactedJson = jsonTextDepth < MAXIMUM_JSON_TEXT_DEPTH
    ? redactJsonContainers(value, limits, jsonTextDepth)
    : value;
  const redactedJsonProperties = redactQuotedJsonProperties(redactedJson);
  const redactedUrls = redactedJsonProperties.replace(URL_VALUE, redactUrl);
  const redactedAssignments = redactAssignments(redactedUrls);
  return redactedAssignments.replace(BEARER_VALUE, `Bearer ${REDACTED}`)
    .slice(0, limits.maximumTextLength);
}

export function redactSensitiveValue(
  value: unknown,
  options: { maximumDepth?: number; maximumItems?: number; maximumTextLength?: number } = {},
): unknown {
  return redactSensitiveValueInternal(value, {
    maximumDepth: options.maximumDepth ?? 16,
    maximumItems: options.maximumItems ?? 200,
    maximumTextLength: options.maximumTextLength ?? Number.MAX_SAFE_INTEGER,
  }, 0);
}

function redactSensitiveValueInternal(
  value: unknown,
  limits: RedactionLimits,
  jsonTextDepth: number,
): unknown {
  const visit = (candidate: unknown, depth: number): unknown => {
    if (depth > limits.maximumDepth) return { truncated: true };
    if (typeof candidate === "string") {
      return redactSensitiveTextInternal(candidate, limits, jsonTextDepth);
    }
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "number") return candidate;
    if (Array.isArray(candidate)) {
      const bounded = candidate.slice(0, limits.maximumItems);
      return bounded.map((item, index) => {
        const previous = index > 0 ? bounded[index - 1] : undefined;
        if (typeof previous === "string" && isSensitiveKey(previous)) return REDACTED;
        return visit(item, depth + 1);
      });
    }
    if (typeof candidate === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(candidate as Record<string, unknown>).slice(0, limits.maximumItems)) {
        output[key] = isSensitiveKey(key) ? REDACTED : visit(item, depth + 1);
      }
      return output;
    }
    return redactSensitiveTextInternal(String(candidate), limits, jsonTextDepth);
  };

  return visit(value, 0);
}

function redactJsonContainers(
  value: string,
  limits: RedactionLimits,
  jsonTextDepth: number,
): string {
  let output = "";
  let copiedThrough = 0;
  let attempts = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "{" && value[index] !== "[") continue;
    attempts += 1;
    if (attempts > MAXIMUM_JSON_CONTAINER_ATTEMPTS) break;
    const end = jsonContainerEnd(value, index);
    if (end === undefined) continue;
    const source = value.slice(index, end);
    let parsed: unknown;
    try { parsed = JSON.parse(source) as unknown; }
    catch { continue; }
    if (!parsed || typeof parsed !== "object") continue;
    const redacted = redactSensitiveValueInternal(parsed, limits, jsonTextDepth + 1);
    output += value.slice(copiedThrough, index) + JSON.stringify(redacted);
    copiedThrough = end;
    index = end - 1;
  }
  return copiedThrough === 0 ? value : output + value.slice(copiedThrough);
}

function jsonContainerEnd(value: string, start: number): number | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push(character);
      continue;
    }
    if (character !== "}" && character !== "]") continue;
    const opening = stack.pop();
    if ((character === "}" && opening !== "{") || (character === "]" && opening !== "[")) {
      return undefined;
    }
    if (stack.length === 0) return index + 1;
  }
  return undefined;
}

function redactQuotedJsonProperties(value: string): string {
  let output = "";
  let copiedThrough = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '"') continue;
    const keyEnd = jsonStringEnd(value, index);
    if (keyEnd === undefined) continue;
    let key: unknown;
    try { key = JSON.parse(value.slice(index, keyEnd)) as unknown; }
    catch {
      index = keyEnd - 1;
      continue;
    }
    let separatorEnd = keyEnd;
    while (/\s/.test(value[separatorEnd] ?? "")) separatorEnd += 1;
    if (value[separatorEnd] !== ":") {
      index = keyEnd - 1;
      continue;
    }
    separatorEnd += 1;
    while (/\s/.test(value[separatorEnd] ?? "")) separatorEnd += 1;
    if (typeof key !== "string" || !isSensitiveKey(key)) {
      index = keyEnd - 1;
      continue;
    }
    const valueEnd = jsonValueEnd(value, separatorEnd);
    output += value.slice(copiedThrough, separatorEnd) + JSON.stringify(REDACTED);
    if (valueEnd === undefined) {
      copiedThrough = value.length;
      break;
    }
    copiedThrough = valueEnd;
    index = valueEnd - 1;
  }
  return copiedThrough === 0 ? value : output + value.slice(copiedThrough);
}

function jsonStringEnd(value: string, start: number): number | undefined {
  if (value[start] !== '"') return undefined;
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') return index + 1;
  }
  return undefined;
}

function jsonValueEnd(value: string, start: number): number | undefined {
  const first = value[start];
  if (first === '"') return jsonStringEnd(value, start);
  if (first === "{" || first === "[") return jsonContainerEnd(value, start);
  const scalar = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(value.slice(start));
  if (!scalar) return undefined;
  const end = start + scalar[0].length;
  return end === value.length || /[\s,}\]]/.test(value[end]!) ? end : undefined;
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
