import type {
  BenchmarkArtifact,
  BenchmarkFailure,
  BenchmarkModelCallTrace,
  BenchmarkRunEvent,
  BenchmarkToolCallTrace,
  BenchmarkVerifierResult,
} from "./types";

export type BenchmarkSecretFindingKind =
  | "openai_api_key"
  | "anthropic_api_key"
  | "google_api_key"
  | "github_token"
  | "runner_token"
  | "ssh_private_key"
  | "env_secret"
  | "authorization_header";

export interface BenchmarkSecretFinding {
  kind: BenchmarkSecretFindingKind;
  index: number;
  length: number;
  preview: string;
  blocked: boolean;
}

export interface BenchmarkSecretScanResult {
  blocked: boolean;
  findings: BenchmarkSecretFinding[];
}

export interface BenchmarkRedactionSummary {
  scannedArtifacts: number;
  /** Total records scanned across every free-text channel (artifacts + traces
   * + tool-calls + run-events + verifier results + failures). */
  scannedRecords: number;
  redactedSecrets: number;
  warnings: string[];
}

interface BenchmarkBundleWithChannels {
  artifacts: BenchmarkArtifact[];
  traces?: BenchmarkModelCallTrace[];
  toolCallTraces?: BenchmarkToolCallTrace[];
  runEvents?: BenchmarkRunEvent[];
  verifierResults?: BenchmarkVerifierResult[];
  failures?: BenchmarkFailure[];
  redactionSummary?: BenchmarkRedactionSummary;
}

interface SecretPattern {
  kind: BenchmarkSecretFindingKind;
  pattern: RegExp;
  blocked?: boolean;
}

interface RedactionPattern extends SecretPattern {
  replacement: string | ((match: string, ...groups: string[]) => string);
}

const REDACTED_SECRET = "[REDACTED_SECRET]";
const REDACTED_LOCAL_PATH = "[REDACTED_LOCAL_PATH]";

const SECRET_SCAN_PATTERNS: SecretPattern[] = [
  {
    kind: "ssh_private_key",
    pattern:
      /-----BEGIN (?:OPENSSH|RSA|DSA|EC|ED25519) PRIVATE KEY-----(?:[\s\S]*?-----END (?:OPENSSH|RSA|DSA|EC|ED25519) PRIVATE KEY-----)?/g,
    blocked: true,
  },
  {
    kind: "anthropic_api_key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    kind: "openai_api_key",
    pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    kind: "google_api_key",
    pattern: /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    kind: "github_token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  {
    kind: "runner_token",
    pattern:
      /\b(?:aiboard-runner-token-[A-Za-z0-9_-]{12,}|x-runner-token\s*[:=]\s*[A-Za-z0-9._~+/=-]{12,}|runner[-_\s]?token\s*[:=]\s*[A-Za-z0-9._~+/=-]{12,})\b/gi,
  },
  {
    kind: "authorization_header",
    pattern:
      /\bAuthorization\s*[:=]\s*(?:(?:Bearer|Basic|Token)\s+)?[A-Za-z0-9._~+/=-]{8,}/gi,
  },
  {
    kind: "authorization_header",
    pattern:
      /(["']authorization["']\s*:\s*["'])(?:(?:Bearer|Basic|Token)\s+)?[^"'\r\n]+(["'])/gi,
  },
  {
    kind: "env_secret",
    pattern:
      /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET)[A-Z0-9_]*[ \t]*=[ \t]*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n#]*)/gim,
  },
];

const SECRET_REDACTION_PATTERNS: RedactionPattern[] = [
  {
    kind: "ssh_private_key",
    pattern:
      /-----BEGIN (?:OPENSSH|RSA|DSA|EC|ED25519) PRIVATE KEY-----(?:[\s\S]*?-----END (?:OPENSSH|RSA|DSA|EC|ED25519) PRIVATE KEY-----)?/g,
    blocked: true,
    replacement: REDACTED_SECRET,
  },
  {
    kind: "authorization_header",
    pattern:
      /(\bAuthorization\s*[:=]\s*(?:(?:Bearer|Basic|Token)\s+)?)[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: (_match, prefix: string) => `${prefix}${REDACTED_SECRET}`,
  },
  {
    kind: "authorization_header",
    pattern:
      /(["']authorization["']\s*:\s*["'])(?:(?:Bearer|Basic|Token)\s+)?[^"'\r\n]+(["'])/gi,
    replacement: (_match, prefix: string, suffix: string) =>
      `${prefix}${REDACTED_SECRET}${suffix}`,
  },
  {
    kind: "env_secret",
    pattern:
      /^([ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET)[A-Z0-9_]*[ \t]*=[ \t]*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n#]*)/gim,
    replacement: (_match, prefix: string) => `${prefix}${REDACTED_SECRET}`,
  },
  {
    kind: "anthropic_api_key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replacement: REDACTED_SECRET,
  },
  {
    kind: "openai_api_key",
    pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g,
    replacement: REDACTED_SECRET,
  },
  {
    kind: "google_api_key",
    pattern: /\bAIza[A-Za-z0-9_-]{20,}\b/g,
    replacement: REDACTED_SECRET,
  },
  {
    kind: "github_token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    replacement: REDACTED_SECRET,
  },
  {
    kind: "runner_token",
    pattern:
      /\b(aiboard-runner-token-)[A-Za-z0-9_-]{12,}\b/gi,
    replacement: REDACTED_SECRET,
  },
  {
    kind: "runner_token",
    pattern:
      /\b((?:x-runner-token|runner[-_\s]?token)\s*[:=]\s*)[A-Za-z0-9._~+/=-]{12,}\b/gi,
    replacement: (_match, prefix: string) => `${prefix}${REDACTED_SECRET}`,
  },
];

const LOCAL_PATH_PATTERNS = [
  /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>|]+(?:[\\/]+[^\s"'<>|]+)*/g,
  /\/Users\/[^/\s"'<>|]+(?:\/[^\s"'<>|]+)*/g,
];

interface RedactionState {
  redactedSecrets: number;
  warnings: string[];
}

/**
 * Redact one free-text field: push a warning for any blocked finding, strip
 * known secrets (counted) and absolute local paths. Returns the original value
 * unchanged when it is not a non-empty string.
 */
function redactField<V>(
  value: V,
  state: RedactionState,
  describe: (kind: BenchmarkSecretFindingKind) => string
): V {
  if (typeof value !== "string" || value.length === 0) return value;
  const scan = scanArtifactForSecrets(value);
  for (const finding of scan.findings) {
    if (finding.blocked) state.warnings.push(describe(finding.kind));
  }
  const secretRedaction = redactKnownSecretsWithCount(value);
  state.redactedSecrets += secretRedaction.count;
  return redactAbsoluteLocalPathsWithCount(secretRedaction.content)
    .content as unknown as V;
}

export function redactBenchmarkBundle<T extends BenchmarkBundleWithChannels>(
  bundle: T
): T & { redactionSummary: BenchmarkRedactionSummary } {
  const state: RedactionState = { redactedSecrets: 0, warnings: [] };

  const artifacts = bundle.artifacts.map((artifact) => ({
    ...artifact,
    content: redactField(
      artifact.content,
      state,
      (kind) => `Artifact ${artifact.id} contains blocked ${kind} content.`
    ),
  }));

  const traces = bundle.traces?.map((trace) => ({
    ...trace,
    rawResponse: redactField(trace.rawResponse, state, traceLabel(trace.id)),
    parsedResponseJson: redactField(
      trace.parsedResponseJson,
      state,
      traceLabel(trace.id)
    ),
    fallbackReason: redactField(trace.fallbackReason, state, traceLabel(trace.id)),
    error: redactField(trace.error, state, traceLabel(trace.id)),
    retryHistory: trace.retryHistory.map((retry) => ({
      ...retry,
      message: redactField(retry.message, state, traceLabel(trace.id)),
      rawResponse: redactField(retry.rawResponse, state, traceLabel(trace.id)),
      parsedJson: redactField(retry.parsedJson, state, traceLabel(trace.id)),
    })),
  }));

  const toolCallTraces = bundle.toolCallTraces?.map((tool) => ({
    ...tool,
    command: redactField(tool.command, state, toolLabel(tool.id)),
    inputJson: redactField(tool.inputJson, state, toolLabel(tool.id)),
    outputPreview: redactField(tool.outputPreview, state, toolLabel(tool.id)),
    error: redactField(tool.error, state, toolLabel(tool.id)),
  }));

  const runEvents = bundle.runEvents?.map((event) => ({
    ...event,
    message: redactField(event.message, state, eventLabel(event.id)),
    detailsJson: redactField(event.detailsJson, state, eventLabel(event.id)),
  }));

  const verifierResults = bundle.verifierResults?.map((result) => ({
    ...result,
    command: redactField(result.command, state, verifierLabel(result.id)),
    stdoutPreview: redactField(
      result.stdoutPreview,
      state,
      verifierLabel(result.id)
    ),
    stderrPreview: redactField(
      result.stderrPreview,
      state,
      verifierLabel(result.id)
    ),
    resultJson: redactField(result.resultJson, state, verifierLabel(result.id)),
  }));

  const failures = bundle.failures?.map((failure) => ({
    ...failure,
    message: redactField(failure.message, state, failureLabel(failure.id)),
    details: redactField(failure.details, state, failureLabel(failure.id)),
  }));

  const scannedRecords =
    bundle.artifacts.length +
    (bundle.traces?.length ?? 0) +
    (bundle.toolCallTraces?.length ?? 0) +
    (bundle.runEvents?.length ?? 0) +
    (bundle.verifierResults?.length ?? 0) +
    (bundle.failures?.length ?? 0);

  return {
    ...bundle,
    artifacts,
    ...(traces ? { traces } : {}),
    ...(toolCallTraces ? { toolCallTraces } : {}),
    ...(runEvents ? { runEvents } : {}),
    ...(verifierResults ? { verifierResults } : {}),
    ...(failures ? { failures } : {}),
    redactionSummary: {
      scannedArtifacts: bundle.artifacts.length,
      scannedRecords,
      redactedSecrets: state.redactedSecrets,
      warnings: state.warnings,
    },
  };
}

function traceLabel(id: string) {
  return (kind: BenchmarkSecretFindingKind) =>
    `Model-call trace ${id} contains blocked ${kind} content.`;
}
function toolLabel(id: string) {
  return (kind: BenchmarkSecretFindingKind) =>
    `Tool-call trace ${id} contains blocked ${kind} content.`;
}
function eventLabel(id: string) {
  return (kind: BenchmarkSecretFindingKind) =>
    `Run event ${id} contains blocked ${kind} content.`;
}
function verifierLabel(id: string) {
  return (kind: BenchmarkSecretFindingKind) =>
    `Verifier result ${id} contains blocked ${kind} content.`;
}
function failureLabel(id: string) {
  return (kind: BenchmarkSecretFindingKind) =>
    `Failure ${id} contains blocked ${kind} content.`;
}

export function scanArtifactForSecrets(
  artifactOrContent: Pick<BenchmarkArtifact, "content"> | string
): BenchmarkSecretScanResult {
  const content =
    typeof artifactOrContent === "string"
      ? artifactOrContent
      : artifactOrContent.content;
  const findings: BenchmarkSecretFinding[] = [];

  for (const detector of SECRET_SCAN_PATTERNS) {
    detector.pattern.lastIndex = 0;
    for (const match of content.matchAll(detector.pattern)) {
      findings.push({
        kind: detector.kind,
        index: match.index ?? 0,
        length: match[0].length,
        preview: previewSecret(match[0]),
        blocked: detector.blocked === true,
      });
    }
  }

  return {
    blocked: findings.some((finding) => finding.blocked),
    findings: findings.sort((a, b) => a.index - b.index),
  };
}

export function redactKnownSecrets(content: string): string {
  return redactKnownSecretsWithCount(content).content;
}

export function redactAbsoluteLocalPaths(content: string): string {
  return redactAbsoluteLocalPathsWithCount(content).content;
}

function redactKnownSecretsWithCount(content: string): {
  content: string;
  count: number;
} {
  let redacted = content;
  let count = 0;

  for (const redactor of SECRET_REDACTION_PATTERNS) {
    redactor.pattern.lastIndex = 0;
    redacted = redacted.replace(redactor.pattern, (...args: string[]) => {
      count++;
      if (typeof redactor.replacement === "string") {
        return redactor.replacement;
      }
      return redactor.replacement(args[0], ...args.slice(1, -2));
    });
  }

  return { content: redacted, count };
}

function redactAbsoluteLocalPathsWithCount(content: string): {
  content: string;
  count: number;
} {
  let redacted = content;
  let count = 0;

  for (const pattern of LOCAL_PATH_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, () => {
      count++;
      return REDACTED_LOCAL_PATH;
    });
  }

  return { content: redacted, count };
}

function previewSecret(value: string): string {
  const compact = value.replace(/\s+/g, " ");
  if (compact.length <= 12) return REDACTED_SECRET;
  return `${compact.slice(0, 4)}...${compact.slice(-4)}`;
}
