"use client";

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  deleteRetiredBenchmarkEvidence,
  findRetiredBenchmarkEvidence,
  type RetiredBenchmarkEvidence,
} from "@/lib/benchmark/store";

/**
 * Shown on the Data tab only while storage still holds evidence from the
 * retired GameIQ / Fireworks tracks. That evidence is already hidden from
 * every dashboard; this lets the user reclaim the space.
 */
export function RetiredEvidenceNotice({
  onDeleted,
  setMessage,
}: {
  onDeleted: () => Promise<void>;
  setMessage: (message: string | null) => void;
}) {
  const [evidence, setEvidence] = useState<RetiredBenchmarkEvidence | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void findRetiredBenchmarkEvidence()
      .then((found) => {
        if (!cancelled) setEvidence(found);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!evidence || (evidence.resultSetIds.length === 0 && evidence.runIds.length === 0)) {
    return null;
  }

  const runCount = evidence.runIds.length;
  const setCount = evidence.resultSetIds.length;
  const remove = async () => {
    if (
      !window.confirm(
        "Delete all evidence from the retired GameIQ and Fireworks benchmarks? This cannot be undone."
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      const summary = await deleteRetiredBenchmarkEvidence();
      setEvidence({ resultSetIds: [], runIds: [] });
      setMessage(
        `Deleted retired benchmark evidence: ${summary.resultSets} result sets, ${summary.runs} runs, ${summary.attempts} attempts.`
      );
      await onDeleted();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3"
    >
      <div className="text-sm">
        <p className="font-medium text-foreground">Retired benchmark evidence</p>
        <p className="text-muted-foreground">
          {runCount} run{runCount === 1 ? "" : "s"} and {setCount} result
          set{setCount === 1 ? "" : "s"} from the removed GameIQ and Fireworks
          benchmarks are still stored. They no longer appear in results.
        </p>
      </div>
      <Button variant="outline" size="sm" disabled={deleting} onClick={() => void remove()}>
        <Trash2 className="h-4 w-4" aria-hidden="true" />
        {deleting ? "Deleting…" : "Delete retired evidence"}
      </Button>
    </div>
  );
}
