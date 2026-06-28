"use client";

import type { BenchmarkVerifierResult } from "@/lib/benchmark/types";

export function VerifierAssertionTable({
  verifier,
}: {
  verifier: BenchmarkVerifierResult | null;
}) {
  if (!verifier) {
    return <p className="text-sm text-muted-foreground">No verifier selected.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Assertion</th>
            <th className="px-3 py-2 font-medium">Result</th>
            <th className="px-3 py-2 font-medium">Weight</th>
          </tr>
        </thead>
        <tbody>
          {verifier.assertionResults.map((assertion) => (
            <tr key={assertion.id} className="border-b last:border-0">
              <td className="py-2 pr-3">{assertion.label}</td>
              <td className="px-3 py-2">{assertion.passed ? "Passed" : "Failed"}</td>
              <td className="px-3 py-2 tabular-nums">{assertion.weight}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
