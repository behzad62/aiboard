"use client";

/**
 * The CLI workers' free checks in this tab (CW9), shared by Settings and the crew picker so a page asks the Runner
 * once. The Runner caches each check for 60 s itself; Refresh asks it to check again.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  CliWorkersUnsupportedError,
  cliWorkerCrewOptions,
  fetchCliWorkerChecks,
  type CliWorkerChecksView,
  type CliWorkerCrewOption,
} from "./cli-workers";
import { modelProxyClient } from "./model-proxy-client";
import { useHomeState } from "./use-home-state";

export type CliWorkerChecksState =
  | { status: "idle" }
  | { status: "loading"; checks: CliWorkerChecksView | null }
  | { status: "ready"; checks: CliWorkerChecksView }
  /** A Runner from before CW3: no `/v2/cli-workers`. */
  | { status: "unsupported"; message: string }
  | { status: "error"; message: string; checks: CliWorkerChecksView | null };

/** Re-read on mount when the last answer is older than this (the Runner's own cache window). */
const STALE_MS = 60_000;

let state: CliWorkerChecksState = { status: "idle" };
let loadedAt = 0;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setState(next: CliWorkerChecksState): void {
  state = next;
  for (const listener of Array.from(listeners)) listener();
}

function lastChecks(): CliWorkerChecksView | null {
  return state.status === "ready" ? state.checks : state.status === "loading" || state.status === "error" ? state.checks : null;
}

/** Reads the free checks; `refresh` makes the Runner check again instead of answering from its cache. */
export function loadCliWorkerChecks(options: { refresh?: boolean } = {}): Promise<void> {
  if (pending && !options.refresh) return pending;
  const previous = lastChecks();
  setState({ status: "loading", checks: previous });
  const run = (async () => {
    try {
      const connection = modelProxyClient.launcher();
      const checks = await fetchCliWorkerChecks(connection, { refresh: options.refresh === true });
      loadedAt = Date.now();
      setState({ status: "ready", checks });
    } catch (error) {
      if (error instanceof CliWorkersUnsupportedError) setState({ status: "unsupported", message: error.message });
      else setState({ status: "error", message: error instanceof Error ? error.message : String(error), checks: previous });
    }
  })().finally(() => {
    if (pending === run) pending = null;
  });
  pending = run;
  return run;
}

const SERVER_STATE: CliWorkerChecksState = { status: "idle" };

export function useCliWorkerChecks(options: { enabled?: boolean } = {}): {
  state: CliWorkerChecksState;
  checks: CliWorkerChecksView | null;
  refresh: () => Promise<void>;
} {
  const enabled = options.enabled !== false;
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => SERVER_STATE,
  );
  useEffect(() => {
    if (!enabled) return;
    if (state.status === "idle" || (state.status === "ready" && Date.now() - loadedAt > STALE_MS)) void loadCliWorkerChecks();
  }, [enabled]);
  const refresh = useCallback(() => loadCliWorkerChecks({ refresh: true }), []);
  const checks = current.status === "ready" ? current.checks : current.status === "loading" || current.status === "error" ? current.checks : null;
  return { state: current, checks, refresh };
}

/**
 * The crew picker's CLI rows (CW9). None with a Runner whose home has no `cliWorkers` section or that has no
 * `/v2/cli-workers` (a Runner from before CW1 or CW3), so an older Runner is never sent a CLI worker.
 */
export function useCliWorkerCrewOptions(
  access: "ask" | "project" | "full" | null | undefined,
  options: { enabled?: boolean } = {},
): CliWorkerCrewOption[] {
  const home = useHomeState();
  const supported = home.status === "ready" && home.view.capabilities?.cliWorkers === true;
  // The free checks start each CLI's version and login probes on the Runner: ask only for a Build crew, and only
  // when a CLI is turned on in Settings.
  const anyTurnedOn = home.status === "ready" && Object.values(home.view.config.cliWorkers ?? {}).some((entry) => entry?.enabled);
  const wanted = supported && anyTurnedOn && options.enabled !== false;
  const { state: checksState, checks } = useCliWorkerChecks({ enabled: wanted });
  if (home.status !== "ready" || !wanted || checksState.status === "unsupported" || checksState.status === "idle") return [];
  return cliWorkerCrewOptions(home.view.config.cliWorkers ?? {}, checks, access);
}
