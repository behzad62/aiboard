"use client";

import type { WorkBenchCasePickerOption } from "./WorkBenchCasePicker";

export function WorkBenchAttemptDetail({
  selectedCase,
}: {
  selectedCase: WorkBenchCasePickerOption | null;
}) {
  if (!selectedCase) {
    return (
      <div className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
        Select a WorkBench fixture case.
      </div>
    );
  }

  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{selectedCase.case.title}</span>
        <span className="rounded-sm bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {selectedCase.fixtureLanguage}
        </span>
        <span className="rounded-sm bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {selectedCase.case.caseVersion.startsWith("2") ? "v2" : "v1"}
        </span>
        <span className="rounded-sm bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {selectedCase.case.difficulty}
        </span>
      </div>
      <p className="mt-2 text-muted-foreground">
        {selectedCase.case.description}
      </p>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <div>
          <div className="text-xs font-medium uppercase text-muted-foreground">
            Verifier
          </div>
          <div className="mt-1 break-words font-mono text-xs">
            {selectedCase.case.verifier.publicCommand ??
              selectedCase.case.verifier.command}
          </div>
        </div>
        <div>
          <div className="text-xs font-medium uppercase text-muted-foreground">
            Case hash
          </div>
          <div className="mt-1 break-all font-mono text-xs">
            {selectedCase.caseHash}
          </div>
        </div>
      </div>
    </div>
  );
}
