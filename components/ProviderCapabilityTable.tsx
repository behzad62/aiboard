"use client";

import { Badge } from "@/components/ui/badge";
import type { ProviderCapabilityStatusRow } from "@/lib/providers/capability-status";

function capabilityLabel(id: string): string {
  return id
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function statusVariant(label: ProviderCapabilityStatusRow["statusLabel"]) {
  if (label === "Available now") return "success" as const;
  if (label === "Unsupported") return "destructive" as const;
  if (label === "Supported — setup required") return "secondary" as const;
  return "outline" as const;
}

export function ProviderCapabilityTable({
  rows,
  loading = false,
  error,
  title = "Tool support & readiness",
}: {
  rows: ProviderCapabilityStatusRow[];
  loading?: boolean;
  error?: string | null;
  title?: string;
}) {
  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">
          Resolved for the selected model from provider evidence and runtime readiness. Model discovery alone does not verify tool support.
        </p>
      </div>
      {loading ? (
        <p className="text-xs text-muted-foreground">Resolving capability status…</p>
      ) : error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No tool capabilities are declared for this provider.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.capabilityId} className="rounded-md border bg-background p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">{capabilityLabel(row.capabilityId)}</p>
                  <p className="text-[0.7rem] text-muted-foreground">
                    {row.execution} · {row.transports.join(", ")} · {row.supportSource}
                  </p>
                </div>
                <Badge variant={statusVariant(row.statusLabel)}>{row.statusLabel}</Badge>
              </div>
              {row.detail && (
                <p className="mt-2 text-xs text-muted-foreground">{row.detail}</p>
              )}
              {row.missingPrerequisites.length > 0 && (
                <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {row.missingPrerequisites.map((item) => (
                    <p key={item.id}>
                      Missing: {item.label}
                      {item.configurationPath
                        ? ` · configuration: ${item.configurationPath}`
                        : item.kind === "runtime"
                          ? " · runtime setup is required; no in-app setup is available yet"
                          : ""}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
