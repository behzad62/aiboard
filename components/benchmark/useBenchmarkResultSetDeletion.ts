"use client";

import { useRef, useState } from "react";
import { deleteBenchmarkResultSetCascade } from "@/lib/benchmark/store";
import type { BenchmarkResultSet } from "@/lib/benchmark/types";

export function useBenchmarkResultSetDeletion(input: {
  onRefresh: () => Promise<void>;
  setMessage: (message: string | null) => void;
  latestResultSetIds?: ReadonlySet<string>;
}): {
  deletingIds: ReadonlySet<string>;
  deleteInFlight: boolean;
  requestDelete(resultSet: BenchmarkResultSet, label: string): Promise<void>;
} {
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());
  const [deleteInFlight, setDeleteInFlight] = useState(false);
  const inFlight = useRef(false);

  async function requestDelete(
    resultSet: BenchmarkResultSet,
    label: string
  ): Promise<void> {
    if (inFlight.current) return;
    const invokingControl =
      typeof document === "undefined"
        ? null
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    if (
      typeof window !== "undefined" &&
      !window.confirm(benchmarkResultSetDeleteConfirmation(resultSet, label))
    ) {
      return;
    }
    const promoted = input.latestResultSetIds?.has(resultSet.id) === true;
    inFlight.current = true;
    setDeleteInFlight(true);
    setDeletingIds((current) => new Set(current).add(resultSet.id));
    let deleted = false;
    try {
      await deleteBenchmarkResultSetCascade(resultSet.id);
      deleted = true;
      await input.onRefresh();
      input.setMessage(
        promoted
          ? "Deleted the snapshot. The previous completed run is now latest."
          : "Deleted the snapshot."
      );
    } catch (error) {
      if (deleted) {
        input.setMessage(
          `Deleted the snapshot, but could not refresh: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      } else {
        input.setMessage(
          `Could not delete benchmark snapshot: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    } finally {
      setDeletingIds((current) => {
        const next = new Set(current);
        next.delete(resultSet.id);
        return next;
      });
      inFlight.current = false;
      setDeleteInFlight(false);
      restoreDeletionFocus(invokingControl);
    }
  }

  return { deletingIds, deleteInFlight, requestDelete };
}

export function benchmarkResultSetDeleteConfirmation(
  resultSet: BenchmarkResultSet,
  label: string
): string {
  const completed = resultSet.completedAt ?? resultSet.terminalAt ?? resultSet.createdAt;
  const timestamp = Number.isFinite(Date.parse(completed))
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(completed))
    : "an unknown time";
  return `Delete the benchmark snapshot for ${label} completed ${timestamp}?\n\nThis removes its attempts, traces, verifier evidence, and artifacts. Older snapshots are not affected.`;
}

function restoreDeletionFocus(invokingControl: HTMLElement | null): void {
  if (!invokingControl || typeof document === "undefined") return;
  const focusKey = invokingControl.dataset.focusReturn;
  requestAnimationFrame(() => {
    if (invokingControl.isConnected) {
      invokingControl.focus();
      return;
    }
    if (!focusKey) return;
    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(focusKey)
        : focusKey.replace(/["\\]/g, "\\$&");
    document
      .querySelector<HTMLElement>(`[data-focus-return="${escaped}"]`)
      ?.focus();
  });
}
