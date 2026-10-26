import type { AssistantBlock } from "./agent-contracts.js";

/**
 * Readable timeline text for a reviewer's verdict and findings calls. A reviewer that answers only
 * with the tool call (Gemini's delivery verdicts in the tunnel run) otherwise has no transcript turn,
 * so the owner never saw what it decided.
 */
export function verdictTranscriptText(blocks: readonly AssistantBlock[]): string | undefined {
  const lines = blocks.flatMap((block) => {
    if (block.type !== "tool_call" || !isRecord(block.arguments)) return [];
    const text = VERDICT_FORMATTERS[block.name]?.(block.arguments);
    return text ? [text] : [];
  });
  return lines.length > 0 ? lines.join("\n\n") : undefined;
}

const VERDICT_FORMATTERS: Record<string, (args: Record<string, unknown>) => string | undefined> = {
  record_deliverable_findings: (args) => {
    const findings = records(args.findings);
    if (findings.length === 0) return "Findings: none.";
    return [`Findings (${findings.length}):`, ...findings.map((finding) =>
      `- [${text(finding.severity) ?? "finding"}] ${text(finding.claim) ?? "(no claim)"}${text(finding.location) ? ` (${text(finding.location)})` : ""}`)].join("\n");
  },
  submit_deliverable_verdict: (args) => {
    const claims = records(args.claimVerdicts);
    const unverified = claims.filter((claim) => claim.status === "unverified");
    return [
      `Verdict: ${args.satisfied === true ? "satisfied" : args.satisfied === false ? "not satisfied" : "submitted"}` +
        `${claims.length ? ` (${claims.length - unverified.length}/${claims.length} claims verified)` : ""}.`,
      ...(text(args.summary) ? [text(args.summary)!] : []),
      ...unverified.map((claim) => `- Unverified ${text(claim.claimId) ?? "claim"}: ${text(claim.rationale) ?? ""}`.trimEnd()),
    ].join("\n");
  },
  submit_coverage_verdict: (args) => {
    const verdicts = records(args.obligationVerdicts);
    const counts = new Map<string, number>();
    for (const verdict of verdicts) {
      const word = text(verdict.verdict) ?? "unknown";
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    const gaps = verdicts.filter((verdict) => verdict.verdict !== "covered");
    return [
      `Coverage verdict: ${[...counts].map(([word, count]) => `${count} ${word}`).join(", ") || "no obligations"}.`,
      ...gaps.map((verdict) => `- ${text(verdict.obligationId) ?? "obligation"} ${text(verdict.verdict) ?? ""} [${text(verdict.severity) ?? ""}]: ${text(verdict.rationale) ?? ""}`.trimEnd()),
    ].join("\n");
  },
  submit_verifier_verdict: (args) => {
    const criteria = records(args.criterionVerdicts);
    const unsatisfied = criteria.filter((criterion) => criterion.verdict === "unsatisfied");
    return [
      `Verifier verdict: ${criteria.length - unsatisfied.length}/${criteria.length} criteria satisfied.`,
      ...unsatisfied.map((criterion) =>
        `- Unsatisfied ${text(criterion.taskId) ?? ""}/${text(criterion.criterionId) ?? ""}: ${text(criterion.rationale) ?? ""}`.trimEnd()),
    ].join("\n");
  },
};

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
