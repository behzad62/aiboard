import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { BenchmarkFailure } from "@/lib/benchmark/types";
import {
  classifyBenchmarkFailure,
  groupFailureClassifications,
  type CertifiedFailureClassification,
  type CertifiedFailureGroup,
} from "@/lib/benchmark/certified/classify-failure";

export interface FailureTaxonomyPanelProps {
  failures?: BenchmarkFailure[];
  classifications?: CertifiedFailureClassification[];
  title?: string;
  description?: string;
}

const GROUP_LABELS: Record<CertifiedFailureGroup, string> = {
  model: "Model",
  tool: "Tool",
  harness: "Harness",
  environment: "Environment",
  case: "Case",
  provider: "Provider",
  user: "User",
};

const EXAMPLES = [
  "malformed_tool_call -> tool / failed_tool_use",
  "patch_failed -> tool / failed_tool_use",
  "verification_failed -> model / failed_verifier",
  "runner_crash -> environment / invalid_environment",
  "parser_bug -> harness / invalid_harness",
  "provider_429_before_output -> provider / provider_unavailable",
  "aborted_user -> user / aborted_user",
];

export function FailureTaxonomyPanel({
  failures = [],
  classifications,
  title = "Failure taxonomy",
  description = "Certified failures are separated by accountability so invalid harness, environment, case, provider, and user-aborted runs do not count as model failures.",
}: FailureTaxonomyPanelProps) {
  const classified =
    classifications ?? failures.map((failure) => classifyBenchmarkFailure(failure));
  const rows = groupFailureClassifications(classified);
  const invalidRuns = classified.filter((item) => item.invalidRun).length;
  const modelAccountable = classified.filter((item) => item.modelAccountable).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <TaxonomyStat label="Classified failures" value={classified.length} />
          <TaxonomyStat label="Invalid runs" value={invalidRuns} />
          <TaxonomyStat label="Model accountable" value={modelAccountable} />
        </div>

        {rows.length === 0 ? (
          <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No certified failures recorded.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Group</th>
                  <th className="px-3 py-2 text-right font-medium">Failures</th>
                  <th className="px-3 py-2 text-right font-medium">Invalid runs</th>
                  <th className="px-3 py-2 text-right font-medium">Model accountable</th>
                  <th className="py-2 pl-3 font-medium">Statuses</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.group} className="border-b last:border-0">
                    <td className="py-3 pr-3 font-medium">
                      {GROUP_LABELS[row.group]}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {row.count}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {row.invalidRuns}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {row.modelAccountable}
                    </td>
                    <td className="py-3 pl-3 text-muted-foreground">
                      {formatStatuses(row.statuses)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
          {EXAMPLES.map((example) => (
            <div key={example} className="rounded-md bg-muted px-3 py-2 font-mono">
              {example}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function TaxonomyStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function formatStatuses(statuses: CertifiedFailureClassification extends {
  status: infer T;
}
  ? Partial<Record<Extract<T, string>, number>>
  : Record<string, number>): string {
  const parts = Object.entries(statuses)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status}: ${count}`);
  return parts.length > 0 ? parts.join(", ") : "n/a";
}
