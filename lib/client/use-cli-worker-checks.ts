"use client";

/**
 * The CLI workers' free checks in this tab (CW9), shared by Settings and the crew picker so a page asks the Runner
 * once. The Runner caches each check for 60 s itself; Refresh asks it to check again. The answer belongs to one
 * Runner connection: a different launcher session (another Runner, or the same one after `aiboard update`) starts
 * over, so an older Runner's "unsupported" never outlives it.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  CliWorkersUnsupportedError,
  cliWorkerCrewOptions,
  fetchCliWorkerChecks,
  type CliWorkerChecksView,
  type CliWorkerCrewOption,
} from "./cli-workers";
import { getLauncherConnection } from "./local-runner-handoff";
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
/** After a failed read, ask again on this schedule while a page still shows the checks. */
const RETRY_MS = [5_000, 15_000, 30_000, 60_000] as const;

const IDLE: CliWorkerChecksState = { status: "idle" };

let state: CliWorkerChecksState = IDLE;
/** The Runner connection `state` came from; kept in memory only. */
let stateKey: string | null = null;
let loadedAt = 0;
let pending: { key: string | null; run: Promise<void> } | null = null;
let failures = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of Array.from(listeners)) listener();
}

function setState(key: string | null, next: CliWorkerChecksState): void {
  stateKey = key;
  state = next;
  notify();
}

/** Which Runner the page talks to now (the launcher session); null with none. */
function connectionKey(): string | null {
  try {
    const connection = getLauncherConnection();
    return connection ? `${connection.url}#${connection.token}` : null;
  } catch {
    return null;
  }
}

/** The state for the current connection: another connection's answer reads as not checked yet. */
function currentState(key: string | null = connectionKey()): CliWorkerChecksState {
  return key === stateKey ? state : IDLE;
}

function checksOf(value: CliWorkerChecksState): CliWorkerChecksView | null {
  return value.status === "ready" || value.status === "loading" || value.status === "error" ? value.checks : null;
}

function clearRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function scheduleRetry(): void {
  clearRetry();
  const delay = RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)];
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (listeners.size > 0 && state.status === "error") void loadCliWorkerChecks();
  }, delay);
}

/** Reads the free checks; `refresh` makes the Runner check again instead of answering from its cache. */
export function loadCliWorkerChecks(options: { refresh?: boolean } = {}): Promise<void> {
  const key = connectionKey();
  if (pending && pending.key === key && !options.refresh) return pending.run;
  clearRetry();
  const previous = checksOf(currentState(key));
  setState(key, { status: "loading", checks: previous });
  const run = (async () => {
    try {
      const connection = modelProxyClient.launcher();
      const checks = await fetchCliWorkerChecks(connection, { refresh: options.refresh === true });
      if (connectionKey() !== key) return;
      loadedAt = Date.now();
      failures = 0;
      setState(key, { status: "ready", checks });
    } catch (error) {
      if (connectionKey() !== key) return;
      loadedAt = Date.now();
      if (error instanceof CliWorkersUnsupportedError) {
        failures = 0;
        setState(key, { status: "unsupported", message: error.message });
      } else {
        failures += 1;
        setState(key, { status: "error", message: error instanceof Error ? error.message : String(error), checks: previous });
        scheduleRetry();
      }
    }
  })().finally(() => {
    if (pending?.run === run) pending = null;
  });
  pending = { key, run };
  return run;
}

/** Whether a page showing the checks should ask the Runner now. */
function needsLoad(value: CliWorkerChecksState): boolean {
  if (value.status === "idle" || value.status === "error") return true;
  return (value.status === "ready" || value.status === "unsupported") && Date.now() - loadedAt > STALE_MS;
}

const SERVER_STATE: CliWorkerChecksState = IDLE;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) clearRetry();
  };
}

export function useCliWorkerChecks(options: { enabled?: boolean } = {}): {
  state: CliWorkerChecksState;
  checks: CliWorkerChecksView | null;
  refresh: () => Promise<void>;
} {
  const enabled = options.enabled !== false;
  const current = useSyncExternalStore(subscribe, () => currentState(), () => SERVER_STATE);
  // On mount and when the page talks to another Runner; a failed read is retried by its own timer.
  const key = typeof window === "undefined" ? null : connectionKey();
  useEffect(() => {
    if (!enabled) return;
    const value = currentState();
    if (value.status === "loading" || (value.status === "error" && retryTimer)) return;
    if (needsLoad(value)) void loadCliWorkerChecks();
  }, [enabled, key]);
  const refresh = useCallback(() => loadCliWorkerChecks({ refresh: true }), []);
  return { state: current, checks: checksOf(current), refresh };
}

export type CliWorkerCrewStatus = "off" | "loading" | "ready" | "error" | "unsupported";

export interface CliWorkerCrewOptions {
  /** One row per model of every CLI turned on in Settings; none can be picked until its check is in. */
  options: CliWorkerCrewOption[];
  status: CliWorkerCrewStatus;
}

/**
 * The crew picker's CLI rows (CW9). None with a Runner whose home has no `cliWorkers` section or that has no
 * `/v2/cli-workers` (a Runner from before CW1 or CW3), so an older Runner is never sent a CLI worker. A row can be
 * picked only once the Runner has checked its CLI (`cliWorkerHealth`).
 */
export function useCliWorkerCrewOptions(
  access: "ask" | "project" | "full" | null | undefined,
  options: { enabled?: boolean } = {},
): CliWorkerCrewOptions {
  const home = useHomeState();
  const supported = home.status === "ready" && home.view.capabilities?.cliWorkers === true;
  // The free checks start each CLI's version and login probes on the Runner: ask only for a Build crew, and only
  // when a CLI is turned on in Settings.
  const anyTurnedOn = home.status === "ready" && Object.values(home.view.config.cliWorkers ?? {}).some((entry) => entry?.enabled);
  const wanted = supported && anyTurnedOn && options.enabled !== false;
  const { state: checksState, checks } = useCliWorkerChecks({ enabled: wanted });
  if (home.status !== "ready" || !wanted) return { options: [], status: "off" };
  if (checksState.status === "unsupported") return { options: [], status: "unsupported" };
  const status: CliWorkerCrewStatus = checksState.status === "idle" ? "loading" : checksState.status;
  return { options: cliWorkerCrewOptions(home.view.config.cliWorkers ?? {}, checks, access), status };
}
