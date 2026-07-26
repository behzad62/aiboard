import { Badge } from "@/components/ui/badge";
import { benchmarkVariantLabel } from "@/lib/benchmark/model-effort";
import type { CertifiedLeaderboardRow } from "@/lib/benchmark/certified/dashboard-selectors";

export function VariantRosterBadges({
  details,
}: {
  details: CertifiedLeaderboardRow["reasoningEffortDetails"];
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
            {benchmarkVariantLabel(detail.displayName, detail.effort)}
          </span>
        </Badge>
      ))}
    </div>
  );
}
