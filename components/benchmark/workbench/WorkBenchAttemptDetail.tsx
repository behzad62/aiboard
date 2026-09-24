"use client";

import type { WorkBenchCasePackOption } from "@/lib/benchmark/workbench";
import {
  RECOVERABLE_JOB_SERVICE_CASE_ID,
  RECOVERABLE_JOB_SERVICE_METADATA,
} from "@/lib/benchmark/workbench/recoverable-job-service/fixture";

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
  const firstCase = selectedPack.cases[0]?.case;
  const rjsCase = firstCase?.id === RECOVERABLE_JOB_SERVICE_CASE_ID ? firstCase : null;
  const modelVisibleFileCount = rjsCase
    ? Object.keys(rjsCase.fixtureFiles ?? {}).filter(
        (path) => !rjsCase.trustedPolicy?.hiddenPaths.includes(path)
      ).length
    : 0;

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
            {firstCase?.verifier.command ?? "Verifier unavailable"}
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
      {rjsCase ? (
        <div className="mt-3 space-y-2 rounded-md border bg-muted/20 p-3">
          <div className="font-medium">Published evaluation scope</div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {RECOVERABLE_JOB_SERVICE_METADATA.familyCount} mandatory families · {RECOVERABLE_JOB_SERVICE_METADATA.variantCount} variants · {modelVisibleFileCount} model-visible files · {Math.max(0, rjsCase.allowedCommands.length - 1)} public family or recipe commands
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Binary scoring: every mandatory outcome and measured safety check must pass. Trusted infrastructure failures are excluded.
          </p>
          <dl className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
            <Budget label="Wall clock" value={`${formatNumber(rjsCase.budget.maxWallClockSeconds)} seconds`} />
            <Budget label="Model calls" value={`${formatNumber(rjsCase.budget.maxModelCalls)} model calls`} />
            <Budget label="Tool calls" value={`${formatNumber(rjsCase.budget.maxToolCalls)} tool calls`} />
            <Budget label="Input" value={`${formatNumber(rjsCase.budget.maxInputTokens)} input tokens`} />
            <Budget label="Output" value={`${formatNumber(rjsCase.budget.maxOutputTokens)} output tokens`} />
            <Budget label="Editable source" value={rjsCase.trustedPolicy?.editablePaths.join(", ") ?? "service.js"} />
          </dl>
        </div>
      ) : null}
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

function Budget({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border bg-background/60 px-2 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}

function formatNumber(value: number | undefined): string {
  return value == null ? "Unlimited" : value.toLocaleString("en-US");
}
