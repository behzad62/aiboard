"use client";

import { CheckCircle2, CircleHelp, XCircle } from "lucide-react";
import { environmentInventoryView, type NativeBuildProjection } from "@/lib/client/runner-v2";

const STATUS_LABEL = { found: "Found", missing: "Missing", unknown: "Not checked" } as const;

/**
 * VF1: the tools the Runner found on this machine before planning (or on the
 * latest resume). Facts only: a missing tool means its checks are recorded as
 * not run, never failed. Renders nothing for runs recorded before VF1.
 */
export function EnvironmentInventoryPanel({
  projection,
}: {
  projection: Pick<NativeBuildProjection, "environmentInventory"> | null | undefined;
}) {
  const view = environmentInventoryView(projection);
  if (!view) return null;
  return (
    <section aria-labelledby="details-inventory-title" className="space-y-2 text-sm">
      <h3 id="details-inventory-title" className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Tools on this machine
      </h3>
      <p className="text-xs text-muted-foreground">{view.heading}</p>
      <ul className="space-y-1.5">
        {view.tools.map((tool) => {
          const Icon = tool.status === "found" ? CheckCircle2 : tool.status === "missing" ? XCircle : CircleHelp;
          return (
            <li key={tool.name} className="flex items-start gap-2">
              <Icon
                className={
                  tool.status === "found"
                    ? "mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600"
                    : tool.status === "missing"
                      ? "mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600"
                      : "mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                }
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span className="font-medium">{tool.name}</span>
                <span className="sr-only">: {STATUS_LABEL[tool.status]}.</span>{" "}
                <span className="break-words text-muted-foreground">{tool.detail}</span>
                {tool.usedBy && (
                  <span className="block break-words text-xs text-muted-foreground">Used by {tool.usedBy}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {view.omitted && <p className="text-xs text-muted-foreground">{view.omitted}</p>}
      <p className="text-xs">
        <span className="text-muted-foreground">Browser for the Playwright CLI: </span>
        {view.browser}
      </p>
      {view.notes.map((note) => (
        <p key={note} className="break-words text-xs text-muted-foreground">
          {note}
        </p>
      ))}
    </section>
  );
}
