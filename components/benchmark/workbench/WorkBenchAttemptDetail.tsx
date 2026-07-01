"use client";

import type { WorkBenchCasePackOption } from "@/lib/benchmark/workbench";

export function WorkBenchAttemptDetail({
  selectedPack,
}: {
  selectedPack: WorkBenchCasePackOption | null;
}) {
  if (!selectedPack) {
    return (
      <div className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
        Select a WorkBench case pack.
      </div>
    );
  }

  const previewCases = selectedPack.cases.slice(0, 4);
  const remainingCount = Math.max(0, selectedPack.caseCount - previewCases.length);

  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{selectedPack.label}</span>
        <span className="rounded-sm bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {selectedPack.caseCount} cases
        </span>
      </div>
      <p className="mt-2 text-muted-foreground">
        {selectedPack.description}
      </p>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <div>
          <div className="text-xs font-medium uppercase text-muted-foreground">
            Verifier
          </div>
          <div className="mt-1 break-words font-mono text-xs">
            node verifier.mjs
          </div>
        </div>
        <div>
          <div className="text-xs font-medium uppercase text-muted-foreground">
            Pack cases
          </div>
          <div className="mt-1 break-all font-mono text-xs">
            {selectedPack.caseIds.join(", ")}
          </div>
        </div>
      </div>
      <div className="mt-3 grid gap-2">
        {previewCases.map((item) => (
          <div key={item.id} className="rounded-sm bg-muted/50 px-2 py-1">
            <div className="font-medium">{item.case.title}</div>
            <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
              <span>{item.fixtureLanguage}</span>
              <span>{item.challengeKind}</span>
              <span>{item.case.difficulty}</span>
            </div>
          </div>
        ))}
        {remainingCount > 0 && (
          <div className="text-xs text-muted-foreground">
            + {remainingCount} more cases in this pack
          </div>
        )}
      </div>
    </div>
  );
}
