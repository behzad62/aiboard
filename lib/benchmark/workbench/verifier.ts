import type {
  ParsedWorkBenchVerifierResult,
  WorkBenchVerifierAssertion,
  WorkBenchVerifierAssertionInput,
  WorkBenchVerifierFailureClass,
} from "./types";

export function parseVerifierResult(
  stdout: string,
  resultFileContent?: string | null
): ParsedWorkBenchVerifierResult {
  const source =
    typeof resultFileContent === "string" && resultFileContent.trim()
      ? resultFileContent
      : extractVerifierJson(stdout);
  const parsed = parseJsonObject(source, "verifier JSON");

  const passed = getBoolean(parsed, "passed");
  const assertions = normalizeVerifierAssertions(
    Array.isArray(parsed.assertions) ? parsed.assertions : []
  );
  const score =
    parsed.score === undefined
      ? scoreAssertions(assertions, passed)
      : clamp01(getFiniteNumber(parsed, "score"));
  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : passed
        ? "Verifier passed"
        : "Verifier failed";

  return {
    passed,
    score,
    summary,
    assertions,
    rawJson: JSON.stringify({
      passed,
      score,
      summary,
      assertions,
    }),
  };
}

export function normalizeVerifierAssertions(
  assertions: WorkBenchVerifierAssertionInput[]
): WorkBenchVerifierAssertion[] {
  return assertions.map((assertion, index) => {
    if (!isRecord(assertion)) {
      throw new Error(`Verifier assertion ${index + 1} must be an object.`);
    }

    const passed = getBoolean(assertion, "passed", `assertion ${index + 1}`);
    const id =
      typeof assertion.id === "string" && assertion.id.trim()
        ? assertion.id.trim()
        : `assertion-${index + 1}`;
    const label =
      typeof assertion.label === "string" && assertion.label.trim()
        ? assertion.label.trim()
        : `Assertion ${index + 1}`;
    const weight =
      assertion.weight === undefined
        ? 1
        : getNonNegativeNumber(assertion, "weight", `assertion ${index + 1}`);
    const message =
      typeof assertion.message === "string" && assertion.message.trim()
        ? assertion.message.trim()
        : undefined;

    return { id, label, passed, weight, message };
  });
}

export function classifyVerifierFailure(
  resultOrError: ParsedWorkBenchVerifierResult | Error | string
): WorkBenchVerifierFailureClass {
  if (resultOrError instanceof Error || typeof resultOrError === "string") {
    return "failed_verifier";
  }
  return resultOrError.passed ? "passed" : "failed_model";
}

function extractVerifierJson(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("No verifier JSON found in stdout.");
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim()) {
    return fenced[1].trim();
  }

  const balanced = findBalancedJsonObject(trimmed);
  if (balanced) return balanced;

  throw new Error("No verifier JSON found in stdout.");
}

function findBalancedJsonObject(text: string): string | null {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
      } else if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0) {
          return text.slice(start, index + 1);
        }
      }
    }
  }
  return null;
}

function parseJsonObject(source: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(source) as unknown;
    if (!isRecord(parsed) || Array.isArray(parsed)) {
      throw new Error(`${label} must be an object.`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Malformed ${label}: ${error.message}`);
    }
    throw error;
  }
}

function scoreAssertions(
  assertions: WorkBenchVerifierAssertion[],
  fallbackPassed: boolean
): number {
  if (assertions.length === 0) return fallbackPassed ? 1 : 0;
  const totalWeight = assertions.reduce((sum, assertion) => sum + assertion.weight, 0);
  if (totalWeight <= 0) return assertions.every((assertion) => assertion.passed) ? 1 : 0;
  const passedWeight = assertions.reduce(
    (sum, assertion) => sum + (assertion.passed ? assertion.weight : 0),
    0
  );
  return round(clamp01(passedWeight / totalWeight));
}

function getBoolean(
  record: Record<string, unknown>,
  key: string,
  label = "verifier result"
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${label} ${key} must be a boolean.`);
  }
  return value;
}

function getFiniteNumber(
  record: Record<string, unknown>,
  key: string,
  label = "verifier result"
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} ${key} must be a finite number.`);
  }
  return value;
}

function getNonNegativeNumber(
  record: Record<string, unknown>,
  key: string,
  label: string
): number {
  const value = getFiniteNumber(record, key, label);
  if (value < 0) throw new Error(`${label} ${key} must be non-negative.`);
  return value;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
