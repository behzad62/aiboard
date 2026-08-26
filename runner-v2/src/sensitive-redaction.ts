const REDACTED = "[REDACTED]";
const ASSIGNMENT_CANDIDATE = /(?<![A-Za-z0-9_-])((?:--?)?[A-Za-z_][A-Za-z0-9_-]*)(\s*(?::|=)\s*|\s+)(?:Bearer\s+)?([^\s,;&]+)/g;
const BEARER_VALUE = /\bBearer\s+[^\s,;]+/gi;
const URL_VALUE = /https?:\/\/[^\s"'<>]+/gi;
const MAXIMUM_JSON_TEXT_DEPTH = 8;
const MAXIMUM_JSON_CONTAINER_ATTEMPTS = 64;
const MAXIMUM_JSON_STRING_BOUND_INSPECTIONS = 64;

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
  const redactedJsonStrings = jsonTextDepth < MAXIMUM_JSON_TEXT_DEPTH
    ? redactJsonStringLiterals(redactedJson, limits, jsonTextDepth)
    : redactedJson;
  const redactedRawJson = jsonTextDepth < MAXIMUM_JSON_TEXT_DEPTH
    ? redactRawJsonStringContent(redactedJsonStrings, limits, jsonTextDepth)
    : redactedJsonStrings;
  const redactedJsonProperties = redactQuotedJsonProperties(redactedRawJson);
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
  let candidateStart: number | undefined;
  let backslashRun = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "\\") {
      backslashRun += 1;
      continue;
    }
    if (character !== '"') {
      backslashRun = 0;
      continue;
    }
    const escaped = backslashRun % 2 === 1;
    backslashRun = 0;
    if (escaped) continue;
    if (candidateStart === undefined) {
      candidateStart = index;
      continue;
    }
    const keyEnd = index + 1;
    let key: unknown;
    try { key = JSON.parse(value.slice(candidateStart, keyEnd)) as unknown; }
    catch {
      candidateStart = index;
      continue;
    }
    let separatorEnd = keyEnd;
    while (/\s/.test(value[separatorEnd] ?? "")) separatorEnd += 1;
    if (value[separatorEnd] !== ":") {
      candidateStart = index;
      continue;
    }
    separatorEnd += 1;
    while (/\s/.test(value[separatorEnd] ?? "")) separatorEnd += 1;
    if (typeof key !== "string" || !isSensitiveKey(key)) {
      candidateStart = index;
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
    candidateStart = undefined;
    backslashRun = 0;
  }
  return copiedThrough === 0 ? value : output + value.slice(copiedThrough);
}

function redactJsonStringLiterals(
  value: string,
  limits: RedactionLimits,
  jsonTextDepth: number,
): string {
  let output = "";
  let copiedThrough = 0;
  let candidateStart: number | undefined;
  let backslashRun = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "\\") {
      backslashRun += 1;
      continue;
    }
    if (character !== '"') {
      backslashRun = 0;
      continue;
    }
    const escaped = backslashRun % 2 === 1;
    backslashRun = 0;
    if (escaped) continue;
    if (candidateStart === undefined) {
      candidateStart = index;
      continue;
    }
    const end = index + 1;
    let decoded: unknown;
    try { decoded = JSON.parse(value.slice(candidateStart, end)) as unknown; }
    catch {
      candidateStart = index;
      continue;
    }
    if (typeof decoded !== "string") {
      candidateStart = index;
      continue;
    }
    let redacted = redactSensitiveTextInternal(decoded, limits, jsonTextDepth + 1);
    if (
      redacted === decoded
      && jsonTextDepth + 1 >= MAXIMUM_JSON_TEXT_DEPTH
      && nestedJsonStringRequiresRedaction(decoded, limits)
    ) redacted = REDACTED;
    if (redacted !== decoded) {
      output += value.slice(copiedThrough, candidateStart) + JSON.stringify(redacted);
      copiedThrough = end;
      candidateStart = undefined;
      continue;
    }
    candidateStart = index;
  }
  return copiedThrough === 0 ? value : output + value.slice(copiedThrough);
}

function nestedJsonStringRequiresRedaction(value: string, limits: RedactionLimits): boolean {
  let decoded: unknown = value;
  for (let depth = 0; depth < MAXIMUM_JSON_STRING_BOUND_INSPECTIONS; depth += 1) {
    if (typeof decoded !== "string") {
      return JSON.stringify(redactSensitiveValueInternal(decoded, limits, MAXIMUM_JSON_TEXT_DEPTH))
        !== JSON.stringify(decoded);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(decoded) as unknown; }
    catch {
      return redactSensitiveTextInternal(decoded, limits, MAXIMUM_JSON_TEXT_DEPTH) !== decoded;
    }
    decoded = parsed;
  }
  return true;
}

function redactRawJsonStringContent(
  value: string,
  limits: RedactionLimits,
  jsonTextDepth: number,
): string {
  if (!containsEscapedSensitiveKey(value)) return value;
  const layer = decodeRawJsonStringContentLayer(value);
  if (layer.status === "none") return value;
  if (layer.status === "invalid") {
    return REDACTED;
  }
  let redacted = redactSensitiveTextInternal(layer.value, limits, jsonTextDepth + 1);
  if (
    redacted === layer.value
    && jsonTextDepth + 1 >= MAXIMUM_JSON_TEXT_DEPTH
    && nestedRawJsonStringContentRequiresRedaction(layer.value, limits)
  ) redacted = REDACTED;
  return redacted === layer.value
    ? value
    : JSON.stringify(redacted).slice(1, -1);
}

type RawJsonStringContentLayer =
  | { status: "none" }
  | { status: "invalid" }
  | { status: "decoded"; value: string };

function decodeRawJsonStringContentLayer(value: string): RawJsonStringContentLayer {
  if (!value.includes("\\\"")) return { status: "none" };
  let output = "";
  let segmentStart = 0;
  let backslashRun = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "\\") {
      backslashRun += 1;
      continue;
    }
    if (character !== '"') {
      backslashRun = 0;
      continue;
    }
    const escaped = backslashRun % 2 === 1;
    backslashRun = 0;
    if (escaped) continue;
    const segment = decodeJsonStringContentSegment(value.slice(segmentStart, index));
    if (segment === undefined) return { status: "invalid" };
    output += segment + '"';
    segmentStart = index + 1;
  }
  const tail = decodeJsonStringContentSegment(value.slice(segmentStart));
  return tail === undefined
    ? { status: "invalid" }
    : { status: "decoded", value: output + tail };
}

function decodeJsonStringContentSegment(value: string): string | undefined {
  try {
    const decoded = JSON.parse(`"${value}"`) as unknown;
    return typeof decoded === "string" ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function containsEscapedSensitiveKey(value: string): boolean {
  const candidate = /(\\+)"([A-Za-z_][A-Za-z0-9_-]*)(\\+)"/g;
  let match: RegExpExecArray | null;
  while ((match = candidate.exec(value)) !== null) {
    if (isSensitiveKey(match[2]!)) return true;
  }
  return false;
}

function nestedRawJsonStringContentRequiresRedaction(
  value: string,
  limits: RedactionLimits,
): boolean {
  let current = value;
  for (let depth = 0; depth < MAXIMUM_JSON_STRING_BOUND_INSPECTIONS; depth += 1) {
    const layer = decodeRawJsonStringContentLayer(current);
    if (layer.status === "invalid") return containsEscapedSensitiveKey(current);
    if (layer.status === "none") {
      return redactSensitiveTextInternal(current, limits, MAXIMUM_JSON_TEXT_DEPTH) !== current;
    }
    const directlyRedacted = redactSensitiveTextInternal(
      layer.value,
      limits,
      MAXIMUM_JSON_TEXT_DEPTH,
    );
    if (directlyRedacted !== layer.value) return true;
    current = layer.value;
  }
  return true;
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
