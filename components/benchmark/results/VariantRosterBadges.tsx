import { Badge } from "@/components/ui/badge";
import { benchmarkVariantLabel } from "@/lib/benchmark/model-effort";
import type { BenchmarkVariantRosterDetail } from "@/lib/benchmark/model-effort";
import { sanitizeBenchmarkDisplayText } from "@/lib/benchmark/configuration-display";

export function VariantRosterBadges({
  details,
}: {
  details: BenchmarkVariantRosterDetail[] | undefined;
}) {
  if (!details || details.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {details.map((detail, index) => (
        <Badge
          key={`${detail.role}:${detail.effort}:${index}`}
          variant="outline"
          className="max-w-full"
        >
          <span className="truncate">
            {detail.role}:{" "}
            {benchmarkVariantLabel(
              sanitizeBenchmarkDisplayText(detail.displayName),
              detail.effort
            )}
          </span>
        </Badge>
      ))}
    </div>
  );
}

export function variantRosterText(
  details: BenchmarkVariantRosterDetail[] | undefined
): string {
  return (details ?? [])
    .map(
      (detail) =>
        `${detail.role}: ${benchmarkVariantLabel(
          sanitizeBenchmarkDisplayText(detail.displayName),
          detail.effort
        )}`
    )
    .join(", ");
}
