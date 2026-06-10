export interface JudgeResult {
  answer: string;
  confidence: number;
  dissent: string[];
}

const DEFAULT_CONFIDENCE = 7;

/**
 * Parse the judge model's response into a clean {answer, confidence, dissent}.
 *
 * The judge is asked to reply with a single JSON object, but the response is
 * frequently truncated when it hits the model's max-token budget — leaving an
 * unterminated JSON string. A naive `JSON.parse` then fails and callers used to
 * surface the raw `{"answer": "...` envelope to the user. This extractor:
 *   1. tries strict JSON first (the happy path),
 *   2. falls back to a tolerant scan that recovers the `answer` field even when
 *      the closing quote/brace never arrived,
 *   3. is idempotent for already-clean markdown, so it is safe to run again at
 *      read time against answers stored by older versions of the engine.
 */
export function extractJudgeResult(raw: string): JudgeResult {
  const text = (raw ?? "").trim();
  if (!text) {
    return { answer: "", confidence: DEFAULT_CONFIDENCE, dissent: [] };
  }

  // Preferred format: clean markdown answer + an HTML-comment metadata footer.
  const metaFooter = extractMetaFooter(text);
  if (metaFooter) return metaFooter;

  // Legacy format: a single JSON envelope (possibly truncated).
  const strict = tryStrictJson(text);
  if (strict) return strict;

  const answer = extractJsonStringField(text, "answer");
  // No JSON envelope detected — treat the whole thing as the answer (markdown).
  if (answer === null) {
    return { answer: text, confidence: DEFAULT_CONFIDENCE, dissent: [] };
  }

  return {
    answer: answer.trim() || text,
    confidence: extractNumberField(text, "confidence") ?? DEFAULT_CONFIDENCE,
    dissent: extractStringArrayField(text, "dissent"),
  };
}

/**
 * Parse `...markdown...\n---\n<!--meta\nconfidence: 8\ndissent:\n- x\n-->`.
 * Returns null when no meta comment is present.
 */
function extractMetaFooter(text: string): JudgeResult | null {
  const match = /<!--\s*meta([\s\S]*?)-->/i.exec(text);
  if (!match || match.index === undefined) return null;

  const meta = match[1];
  let answer = text.slice(0, match.index).trim();
  // Drop a trailing horizontal rule that separated the answer from the footer.
  answer = answer.replace(/\n-{3,}\s*$/, "").trim();

  const confidenceMatch = /confidence\s*[:=]\s*(-?\d+(?:\.\d+)?)/i.exec(meta);
  const confidence = confidenceMatch
    ? Number(confidenceMatch[1])
    : DEFAULT_CONFIDENCE;

  return {
    answer: answer || text.trim(),
    confidence,
    dissent: parseDissentLines(meta),
  };
}

function parseDissentLines(meta: string): string[] {
  const idx = meta.search(/dissent\s*[:=]/i);
  if (idx === -1) return [];
  const lines = meta.slice(idx).split("\n").slice(1);
  const out: string[] = [];
  for (const line of lines) {
    const item = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (item) out.push(item[1].trim());
  }
  return out;
}

function tryStrictJson(text: string): JudgeResult | null {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last <= first) return null;

  try {
    const obj = JSON.parse(text.slice(first, last + 1)) as Record<string, unknown>;
    if (typeof obj.answer !== "string") return null;
    return {
      answer: obj.answer,
      confidence:
        typeof obj.confidence === "number" ? obj.confidence : DEFAULT_CONFIDENCE,
      dissent: Array.isArray(obj.dissent)
        ? obj.dissent.filter((d): d is string => typeof d === "string")
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * Recover a JSON string field by scanning from its opening quote, honoring
 * escape sequences, and stopping at the first unescaped quote OR end-of-input
 * (the truncated case). Returns null when the key is absent.
 */
function extractJsonStringField(text: string, key: string): string | null {
  const opener = new RegExp(`"${key}"\\s*:\\s*"`).exec(text);
  if (!opener || opener.index === undefined) return null;

  let i = opener.index + opener[0].length;
  let out = "";

  while (i < text.length) {
    const ch = text[i];

    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) break; // dangling escape from truncation
      switch (next) {
        case "n": out += "\n"; break;
        case "t": out += "\t"; break;
        case "r": out += "\r"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case '"': out += '"'; break;
        case "\\": out += "\\"; break;
        case "/": out += "/"; break;
        case "u": {
          const hex = text.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else {
            out += next;
          }
          break;
        }
        default:
          out += next;
      }
      i += 2;
      continue;
    }

    if (ch === '"') return out; // closing quote reached
    out += ch;
    i += 1;
  }

  return out; // truncated: return whatever was recovered
}

function extractNumberField(text: string, key: string): number | null {
  const match = new RegExp(`"${key}"\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)`).exec(text);
  return match ? Number(match[1]) : null;
}

function extractStringArrayField(text: string, key: string): string[] {
  const opener = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(text);
  if (!opener || opener.index === undefined) return [];

  const start = opener.index + opener[0].length - 1; // position of '['
  const end = text.indexOf("]", start);
  if (end === -1) return []; // truncated array — skip rather than guess

  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown[];
    return arr.filter((d): d is string => typeof d === "string");
  } catch {
    return [];
  }
}
