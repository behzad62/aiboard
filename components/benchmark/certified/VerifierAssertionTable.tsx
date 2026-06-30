"use client";

import type {
  BenchmarkVerifierAssertionResult,
  BenchmarkVerifierResult,
} from "@/lib/benchmark/types";
import { listGameIqScenarios } from "@/lib/benchmark/gameiq/packs";

export interface GroupedVerifierAssertion {
  key: string;
  label: string;
  total: number;
  passedCount: number;
  failedCount: number;
  totalWeight: number;
  failedExamples: BenchmarkVerifierAssertionResult[];
}

export function VerifierAssertionTable({
  verifier,
}: {
  verifier: BenchmarkVerifierResult | null;
}) {
  if (!verifier) {
    return <p className="text-sm text-muted-foreground">No verifier selected.</p>;
  }
  const groups = groupVerifierAssertions(verifier.assertionResults);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Assertion group</th>
            <th className="px-3 py-2 font-medium">Passed</th>
            <th className="px-3 py-2 font-medium">Failed</th>
            <th className="px-3 py-2 font-medium">Total</th>
            <th className="px-3 py-2 font-medium">Weight</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.key} className="border-b align-top last:border-0">
              <td className="py-2 pr-3">
                <div className="font-medium">{group.label}</div>
                {group.failedExamples.length > 0 ? (
                  <details className="mt-1 text-xs text-muted-foreground">
                    <summary className="cursor-pointer select-none">
                      Failed examples ({group.failedExamples.length})
                    </summary>
                    <div className="mt-2 space-y-2">
                      {group.failedExamples.map((assertion) => {
                        const details = verifierAssertionDetailsForDisplay(assertion);
                        return (
                          <div key={assertion.id} className="rounded-md border px-2 py-1">
                            <div className="font-medium text-foreground">{assertion.label}</div>
                            {assertion.message ? <div>{assertion.message}</div> : null}
                            {details ? (
                              <details className="mt-2">
                                <summary className="cursor-pointer select-none font-medium">
                                  Details
                                </summary>
                                <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2">
                                  {details}
                                </pre>
                              </details>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </details>
                ) : null}
              </td>
              <td className="px-3 py-2 tabular-nums">{group.passedCount}</td>
              <td className="px-3 py-2 tabular-nums">{group.failedCount}</td>
              <td className="px-3 py-2 tabular-nums">{group.total}</td>
              <td className="px-3 py-2 tabular-nums">{group.totalWeight}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const gameIqExpectedActionsByScenarioId = new Map(
  listGameIqScenarios().map((scenario) => [scenario.id, scenario.expectedActions])
);

export function verifierAssertionDetailsForDisplay(
  assertion: BenchmarkVerifierAssertionResult
): string | undefined {
  const expectedActions = gameIqExpectedActionsByScenarioId.get(assertion.id);
  if (!expectedActions?.length) {
    return assertion.details;
  }
  const expectedDetails = `Expected result\n${previewJsonForDisplay(expectedActions)}`;
  if (!assertion.details) {
    return expectedDetails;
  }
  if (assertion.details.includes("Expected result")) {
    return assertion.details;
  }
  return `${assertion.details}\n\n${expectedDetails}`;
}

export function groupVerifierAssertions(
  assertions: BenchmarkVerifierAssertionResult[]
): GroupedVerifierAssertion[] {
  const groups = new Map<string, GroupedVerifierAssertion>();

  for (const assertion of assertions) {
    const key = assertionGroupKey(assertion);
    const label = assertionGroupLabel(assertion);
    const current =
      groups.get(key) ??
      {
        key,
        label,
        total: 0,
        passedCount: 0,
        failedCount: 0,
        totalWeight: 0,
        failedExamples: [],
      };
    current.total += 1;
    current.totalWeight += assertion.weight;
    if (assertion.passed) {
      current.passedCount += 1;
    } else {
      current.failedCount += 1;
      if (current.failedExamples.length < 3) {
        current.failedExamples.push(assertion);
      }
    }
    groups.set(key, current);
  }

  return Array.from(groups.values()).sort(
    (left, right) =>
      right.failedCount - left.failedCount ||
      right.total - left.total ||
      left.label.localeCompare(right.label)
  );
}

function assertionGroupKey(assertion: BenchmarkVerifierAssertionResult): string {
  return simplifyAssertionText(assertion.label) || simplifyAssertionText(assertion.id);
}

function assertionGroupLabel(assertion: BenchmarkVerifierAssertionResult): string {
  return simplifyAssertionText(assertion.label) || assertion.label;
}

function simplifyAssertionText(value: string): string {
  return value
    .trim()
    .replace(/\s*[-:]\s*case\s+[a-z0-9_-]+$/i, "")
    .replace(/\s+#?\d+$/i, "")
    .replace(/\s*\(\d+\)$/i, "")
    .trim();
}

function previewJsonForDisplay(value: unknown): string {
  const json = JSON.stringify(value);
  const limit = 1_500;
  return json.length <= limit
    ? json
    : `${json.slice(0, limit)}\n[truncated ${json.length - limit} chars]`;
}
