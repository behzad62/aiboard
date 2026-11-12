/**
 * The page's side of the AIBoard home (HM4b, plan §5.8, §6.1 and §9 "Old Runners").
 *
 * Settings and keys live in the AIBoard home, which the page reads and writes
 * only through the connected Runner (`getLauncherConnection`): GET `/v2/home`
 * and POST `/v2/home` batches of ops. The page keeps what it read in memory
 * only: the store shows it as a mirror that is never persisted
 * (`applyHomeMirror`, lib/client/store.ts).
 *
 * - Until the first GET returns, `homeReady` is false and every writer refuses,
 *   so defaults are never written over the home.
 * - After the first GET from a home-capable Runner, the old secrets are removed
 *   from this browser's store (provider rows, custom-model keys, the remote MCP
 *   token). Before it, nothing is deleted.
 * - Every settings writer is an awaited batch through `saveHome`. A failed batch
 *   reverts the change it showed and throws; on `home_conflict` the writer's
 *   change is rebuilt on the fresh copy and retried once.
 *
 * This is the only module that changes a settings field of the store
 * (scripts/test-settings-home.mts).
 */

import type { CustomModel, ProviderKey, UserSettings } from "@/lib/db/schema";
import { maskApiKey } from "@/lib/utils";
import {
  CONNECT_AI_BOARD_MESSAGE,
  UPDATE_AI_BOARD_MESSAGE,
  isModelConnectionError,
  modelProxyClient,
} from "./model-proxy-client";
import {
  applyHomeMirror,
  getUserSettings,
  isInitialized,
  onStoreReady,
  removeOldBrowserSecrets,
  type HomeMirror,
} from "./store";

// ------------------------------------------------------------------ the home's shapes

export type HomeOpKind = "set" | "merge" | "remove";
export interface HomeOp {
  path: string;
  op: HomeOpKind;
  value?: unknown;
}

export interface HomeProviderEntry {
  enabled: boolean;
  baseUrl: string | null;
  models: string[] | null;
  enabledModelIds: string[] | null;
  defaultModel: string | null;
  lastValidationSucceeded: boolean | null;
  lastValidatedAt: string | null;
  [unknown: string]: unknown;
}

export interface HomeCustomModelEntry {
  id: string;
  label: string;
  baseURL: string;
  model: string;
  createdAt: string;
  [field: string]: unknown;
}

export interface HomeConfig {
  contractVersion: string;
  revision: number;
  pathRevisions: Record<string, number>;
  updatedAt: string;
  providers: Record<string, HomeProviderEntry>;
  openAIConnectionMode: "api" | "subscription";
  customModels: HomeCustomModelEntry[];
  settings: Record<string, unknown>;
  [unknown: string]: unknown;
}

export interface HomeKeyStatus {
  hasKey: boolean;
  keyHint: string;
}

/** GET `/v2/home`: the config (never a secret), "has a key" and hints, and where the home is. */
export interface HomeView {
  home: string;
  homeSource?: string;
  keyPath?: string;
  exists?: boolean;
  writable?: boolean;
  revision: number;
  pathRevisions?: Record<string, number>;
  config: HomeConfig;
  credentials: {
    providers: Record<string, HomeKeyStatus>;
    customModels: Record<string, HomeKeyStatus>;
    remoteMcpAuthorizationToken?: HomeKeyStatus;
  } | null;
  keysError?: { code: string; message: string };
  catalogVersion?: string;
}

/** The map-valued settings whose single entries are their own sections (§5.8 "Ops"). */
export const HOME_SETTINGS_MAP_FIELDS = [
  "modelPricingOverrides", "modelContextOverrides", "discoveredModelMetadata", "modelCapabilityProfiles",
] as const;

/** The UserSettings fields under `settings` in config.json (openAIConnectionMode is top level). */
export const HOME_SETTINGS_FIELDS = [
  "defaultEffort", "defaultMode", "judgeModelId", "defaultVerbosity", "defaultStyleNote",
  "defaultReasoningEffort", "defaultBuildRunPolicy", "defaultBuildSkillMode", "defaultBuildBudgetUsd",
  "defaultBuildTimeLimitMinutes", "defaultBuildAlwaysRequireIndependentVerifier",
  "modelPricingOverrides", "modelContextOverrides", "discoveredModelMetadata", "providerToolCapabilityEvidence",
  "modelCapabilityProfiles", "toolRuntime",
] as const;

/** ChatGPT and Copilot sign in through the account peer: their rows live in the home, never a credential (OD-32). */
export const ACCOUNT_BACKED_PROVIDER_IDS: ReadonlySet<string> = new Set(["chatgpt", "github-copilot"]);

export const HOME_LOADING_MESSAGE = "AI Board settings are still loading. Try again in a moment.";
export const KEYS_NOT_IMPORTED_MESSAGE =
  "Keys are never imported. Set them on the Providers tab, or in a terminal with `aiboard keys set <provider>`.";

// ------------------------------------------------------------------ state

export type HomeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "not_connected"; message: string }
  | { status: "update_required"; message: string }
  | { status: "error"; message: string; code?: string }
  | { status: "ready"; view: HomeView };

export class HomeSaveError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HomeSaveError";
  }
}

let state: HomeState = { status: "idle" };
/** The last view the Runner returned; the mirror reverts to it when a save fails. */
let serverView: HomeView | null = null;
let loading: Promise<HomeState> | null = null;
let settled: Promise<HomeState> | null = null;
let resolveSettled: ((value: HomeState) => void) | null = null;
let secretsRemoved = false;
let saveQueue: Promise<unknown> = Promise.resolve();
const listeners = new Set<(state: HomeState) => void>();

function setState(next: HomeState): void {
  state = next;
  for (const listener of Array.from(listeners)) {
    try {
      listener(next);
    } catch {
      // A listener must not break the home client.
    }
  }
}

export function getHomeState(): HomeState {
  return state;
}

/** True once the first GET `/v2/home` has returned in this tab. */
export function isHomeReady(): boolean {
  return state.status === "ready";
}

export function onHomeStateChange(listener: (state: HomeState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Resolves once the first home read in this tab has finished, whatever its outcome. */
export function homeSettled(): Promise<HomeState> {
  if (state.status !== "idle" && state.status !== "loading") return Promise.resolve(state);
  if (!settled) settled = new Promise((resolve) => { resolveSettled = resolve; });
  return settled;
}

function settle(next: HomeState): void {
  resolveSettled?.(next);
  resolveSettled = null;
  settled = null;
}

// ------------------------------------------------------------------ the mirror

function settingsFromConfig(config: HomeConfig): Partial<UserSettings> {
  const settings: Record<string, unknown> = {};
  for (const field of HOME_SETTINGS_FIELDS) {
    const value = config.settings?.[field];
    if (value !== undefined && value !== null) settings[field] = structuredClone(value);
    else if (field === "judgeModelId" && value === null) settings[field] = null;
  }
  settings.openAIConnectionMode = config.openAIConnectionMode ?? "api";
  return settings as Partial<UserSettings>;
}

/** The home in the store's shapes. No secret ever appears in a view, so none reaches the store. */
export function mirrorFromView(view: HomeView): HomeMirror {
  const config = view.config;
  const credentials = view.credentials;
  const providerKeys: ProviderKey[] = Object.entries(config.providers ?? {}).map(([providerId, entry]) => ({
    providerId,
    baseURL: entry.baseUrl ?? null,
    models: entry.models ?? [],
    enabledModelIds: entry.enabledModelIds ?? null,
    defaultModel: entry.defaultModel ?? null,
    enabled: entry.enabled === true,
    keyHint: credentials?.providers?.[providerId]?.keyHint ?? null,
    runnerToken: null,
    runnerTokenHint: null,
    lastValidationSucceeded: entry.lastValidationSucceeded ?? null,
    lastValidatedAt: entry.lastValidatedAt ?? null,
    updatedAt: config.updatedAt,
  }));
  const customModels: CustomModel[] = (config.customModels ?? []).map((entry) => ({
    ...(entry as unknown as CustomModel),
    hasKey: Boolean(credentials?.customModels?.[entry.id]?.hasKey),
  }));
  return { providerKeys, customModels, settings: settingsFromConfig(config) };
}

/** Whether a provider has a key saved in the home (account-backed providers never do: they sign in). */
export function homeProviderHasKey(providerId: string): boolean {
  return state.status === "ready" && Boolean(state.view.credentials?.providers?.[providerId]?.hasKey);
}

/** The remote MCP token's hint, when the home holds one. */
export function homeRemoteMcpTokenHint(): string | null {
  return state.status === "ready" ? state.view.credentials?.remoteMcpAuthorizationToken?.keyHint ?? null : null;
}

function showView(view: HomeView): void {
  if (!isInitialized()) return;
  applyHomeMirror(mirrorFromView(view));
}

// ------------------------------------------------------------------ reading

async function launcherRequest(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  const connection = modelProxyClient.launcher();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${connection.token}`);
  return fetch(`${connection.url}${path}`, { ...init, headers, signal });
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

async function fetchHomeView(signal?: AbortSignal): Promise<HomeView> {
  let response: Response;
  try {
    response = await launcherRequest("/v2/home", {}, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new HomeSaveError("not_connected", CONNECT_AI_BOARD_MESSAGE);
  }
  const body = await readBody(response);
  if (response.status === 404 && body.code !== "home_unavailable") throw new HomeSaveError("update_required", UPDATE_AI_BOARD_MESSAGE);
  if (response.status === 401 || response.status === 403) throw new HomeSaveError("not_connected", CONNECT_AI_BOARD_MESSAGE);
  if (!response.ok || typeof body.revision !== "number" || !body.config || typeof body.config !== "object") {
    throw new HomeSaveError(
      typeof body.code === "string" ? body.code : "home_unreadable",
      typeof body.error === "string" ? body.error : `AI Board could not read your settings (HTTP ${response.status}).`,
    );
  }
  return body as unknown as HomeView;
}

/**
 * Reads the home through the connected Runner and shows it in the store. The
 * first successful read in this tab also removes the old browser secrets.
 * A Runner without `capabilities.home` gets the update message; no Runner,
 * the connect message.
 */
export function loadHome(options: { signal?: AbortSignal } = {}): Promise<HomeState> {
  if (loading) return loading;
  if (state.status === "idle") setState({ status: "loading" });
  const run = (async (): Promise<HomeState> => {
    try {
      await modelProxyClient.assertCapable(options.signal);
      const view = await fetchHomeView(options.signal);
      serverView = view;
      showView(view);
      if (!secretsRemoved && isInitialized()) {
        removeOldBrowserSecrets();
        secretsRemoved = true;
      }
      setState({ status: "ready", view });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const code = isModelConnectionError(error) || error instanceof HomeSaveError ? error.code : "home_unreadable";
      const message = error instanceof Error ? error.message : "AI Board could not read your settings.";
      if (code === "not_connected") setState({ status: "not_connected", message: CONNECT_AI_BOARD_MESSAGE });
      else if (code === "update_required") setState({ status: "update_required", message: UPDATE_AI_BOARD_MESSAGE });
      else setState({ status: "error", code, message });
    }
    settle(state);
    return state;
  })().finally(() => {
    loading = null;
  });
  loading = run;
  return run;
}

/** Loads the home once the store is ready (the app calls this after `ensureReady`). */
export function startHomeSync(): void {
  if (state.status !== "idle") return;
  const begin = () => {
    void loadHome();
  };
  if (isInitialized()) begin();
  else {
    const stop = onStoreReady(() => {
      stop();
      begin();
    });
  }
}

// ------------------------------------------------------------------ writing

function pathAfter(path: string, prefix: string): string | undefined {
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

function mergeRecord(current: unknown, patch: unknown): Record<string, unknown> {
  const next: Record<string, unknown> = current && typeof current === "object" && !Array.isArray(current)
    ? { ...(current as Record<string, unknown>) }
    : {};
  for (const [key, value] of Object.entries((patch ?? {}) as Record<string, unknown>)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function secretHint(value: unknown): HomeKeyStatus {
  const secret = value && typeof value === "object" ? (value as { secret?: unknown }).secret : undefined;
  return { hasKey: true, keyHint: typeof secret === "string" ? maskApiKey(secret) : "saved" };
}

/** The view after `ops`, as the page shows it until the Runner answers (the Runner's re-read is what stays). */
export function applyOpsToView(view: HomeView, ops: readonly HomeOp[]): HomeView {
  const next = structuredClone(view);
  const config = next.config;
  const credentials = next.credentials ?? { providers: {}, customModels: {} };
  for (const op of ops) {
    let rest: string | undefined;
    if ((rest = pathAfter(op.path, "credentials.providers.")) !== undefined) {
      if (op.op === "remove") delete credentials.providers[rest];
      else credentials.providers[rest] = secretHint(op.value);
    } else if ((rest = pathAfter(op.path, "credentials.customModels.")) !== undefined) {
      if (op.op === "remove") delete credentials.customModels[rest];
      else credentials.customModels[rest] = secretHint(op.value);
    } else if (op.path === "credentials.remoteMcpAuthorizationToken") {
      if (op.op === "remove") delete credentials.remoteMcpAuthorizationToken;
      else credentials.remoteMcpAuthorizationToken = secretHint(op.value);
    } else if ((rest = pathAfter(op.path, "providers.")) !== undefined) {
      if (op.op === "remove") delete config.providers[rest];
      else {
        const base = op.op === "merge" && config.providers[rest] ? config.providers[rest] : {
          enabled: false, baseUrl: null, models: null, enabledModelIds: null, defaultModel: null,
          lastValidationSucceeded: null, lastValidatedAt: null,
        };
        config.providers[rest] = { ...base, ...(op.value as Record<string, unknown>) } as HomeProviderEntry;
      }
    } else if ((rest = pathAfter(op.path, "customModels.")) !== undefined) {
      const id = rest;
      const index = config.customModels.findIndex((entry) => entry.id === id);
      if (op.op === "remove") {
        if (index >= 0) config.customModels.splice(index, 1);
      } else {
        const base = op.op === "merge" && index >= 0 ? config.customModels[index] : {};
        const entry = { createdAt: new Date().toISOString(), ...base, ...(op.value as Record<string, unknown>), id } as HomeCustomModelEntry;
        if (index >= 0) config.customModels[index] = entry;
        else config.customModels.push(entry);
      }
    } else if (op.path === "openAIConnectionMode") {
      config.openAIConnectionMode = op.op === "remove" ? "api" : (op.value as "api" | "subscription");
    } else if ((rest = pathAfter(op.path, "settings.")) !== undefined) {
      const map = HOME_SETTINGS_MAP_FIELDS.find((field) => rest!.startsWith(`${field}.`));
      if (map) {
        const entry = rest.slice(map.length + 1);
        const current = { ...((config.settings[map] as Record<string, unknown> | undefined) ?? {}) };
        if (op.op === "remove" || op.value === null) delete current[entry];
        else if (op.op === "set") current[entry] = structuredClone(op.value);
        else current[entry] = mergeRecord(current[entry], op.value);
        config.settings[map] = current;
      } else if (op.op === "remove" || (op.op === "set" && op.value === null && rest !== "judgeModelId")) {
        delete config.settings[rest];
      } else if (op.op === "set") {
        config.settings[rest] = structuredClone(op.value);
      } else {
        config.settings[rest] = mergeRecord(config.settings[rest], op.value);
      }
    }
  }
  next.credentials = credentials;
  return next;
}

async function postBatch(baseRevision: number, ops: HomeOp[]): Promise<{ ok: true } | { ok: false; status: number; code: string; message: string }> {
  let response: Response;
  try {
    response = await launcherRequest("/v2/home", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision, ops }),
    });
  } catch {
    return { ok: false, status: 0, code: "not_connected", message: CONNECT_AI_BOARD_MESSAGE };
  }
  if (response.ok) return { ok: true };
  const body = await readBody(response);
  return {
    ok: false,
    status: response.status,
    code: typeof body.code === "string" ? body.code : "home_save_failed",
    message: typeof body.error === "string" ? body.error : `AI Board could not save your settings (HTTP ${response.status}).`,
  };
}

/** Builds a batch from the home as it currently is; called again on fresh data after a `home_conflict`. */
export type HomeOpsBuilder = (view: HomeView, settings: UserSettings) => HomeOp[];

function requireReady(): HomeView {
  if (state.status === "ready") return state.view;
  if (state.status === "not_connected") throw new HomeSaveError("not_connected", CONNECT_AI_BOARD_MESSAGE);
  if (state.status === "update_required") throw new HomeSaveError("update_required", UPDATE_AI_BOARD_MESSAGE);
  if (state.status === "error") throw new HomeSaveError(state.code ?? "home_unreadable", state.message);
  throw new HomeSaveError("home_loading", HOME_LOADING_MESSAGE);
}

async function runSave(build: HomeOpsBuilder): Promise<void> {
  let view = requireReady();
  for (let attempt = 0; ; attempt += 1) {
    const ops = build(view, getUserSettings());
    if (ops.length === 0) return;
    const before = serverView ?? view;
    // Shown at once; reverted if the Runner refuses.
    showView(applyOpsToView(view, ops));
    const result = await postBatch(view.revision, ops);
    if (result.ok) {
      try {
        const fresh = await fetchHomeView();
        serverView = fresh;
        showView(fresh);
        setState({ status: "ready", view: fresh });
      } catch {
        // Saved; the next read shows it.
        const shown = applyOpsToView(view, ops);
        setState({ status: "ready", view: shown });
      }
      return;
    }
    if (result.code === "home_conflict" && attempt === 0) {
      // Re-apply this change to the fresh copy, once.
      try {
        view = await fetchHomeView();
        serverView = view;
        showView(view);
        setState({ status: "ready", view });
        continue;
      } catch (error) {
        showView(before);
        throw error instanceof HomeSaveError ? error : new HomeSaveError("home_conflict", result.message);
      }
    }
    showView(before);
    throw new HomeSaveError(result.code, result.message);
  }
}

/**
 * Saves one batch to the home and waits for it. Saves from this tab run one at
 * a time. Throws a `HomeSaveError` (with the Runner's message) and reverts what
 * it showed when the batch fails.
 */
export function saveHome(build: HomeOpsBuilder): Promise<void> {
  const run = saveQueue.then(() => runSave(build), () => runSave(build));
  saveQueue = run.catch(() => undefined);
  return run;
}

// ------------------------------------------------------------------ op builders

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * The ops that turn the home's settings (as `current`) into `current` with `patch`:
 * a changed map entry is its own op, so two tabs editing different entries both
 * keep their edits; any other field is one op. `toolRuntime` saves only its home
 * fields, never `runner` or a token.
 */
export function settingsPatchOps(current: UserSettings, patch: Partial<UserSettings>): HomeOp[] {
  const ops: HomeOp[] = [];
  const source = current as unknown as Record<string, unknown>;
  for (const [field, value] of Object.entries(patch)) {
    if (field === "openAIConnectionMode") {
      if (value !== undefined && !sameJson(value, current.openAIConnectionMode)) ops.push({ path: "openAIConnectionMode", op: "set", value });
      continue;
    }
    if (!(HOME_SETTINGS_FIELDS as readonly string[]).includes(field)) {
      throw new HomeSaveError("home_invalid_op", `settings.${field} is not saved in the AIBoard home.`);
    }
    if ((HOME_SETTINGS_MAP_FIELDS as readonly string[]).includes(field)) {
      const before = (source[field] ?? {}) as Record<string, unknown>;
      const after = (value ?? {}) as Record<string, unknown>;
      for (const [entry, entryValue] of Object.entries(after)) {
        if (!sameJson(entryValue, before[entry])) ops.push({ path: `settings.${field}.${entry}`, op: "set", value: entryValue });
      }
      for (const entry of Object.keys(before)) {
        if (!Object.hasOwn(after, entry)) ops.push({ path: `settings.${field}.${entry}`, op: "remove" });
      }
      continue;
    }
    if (field === "toolRuntime") {
      const runtime = (value ?? {}) as NonNullable<UserSettings["toolRuntime"]>;
      const home: Record<string, unknown> = {};
      if (runtime.remoteMcpServer !== undefined) {
        home.remoteMcpServer = runtime.remoteMcpServer === null ? null : {
          enabled: runtime.remoteMcpServer.enabled, name: runtime.remoteMcpServer.name, url: runtime.remoteMcpServer.url,
        };
      }
      if (runtime.openaiFileSearch !== undefined) {
        home.openaiFileSearch = runtime.openaiFileSearch === null ? null : {
          enabled: runtime.openaiFileSearch.enabled, vectorStoreIds: [...(runtime.openaiFileSearch.vectorStoreIds ?? [])],
        };
      }
      const before = current.toolRuntime ?? {};
      const changed = Object.entries(home).some(([key, item]) => !sameJson(item, (before as Record<string, unknown>)[key]));
      if (changed) ops.push({ path: "settings.toolRuntime", op: "merge", value: home });
      continue;
    }
    if (sameJson(value, source[field])) continue;
    if (value === undefined || (value === null && field !== "judgeModelId")) ops.push({ path: `settings.${field}`, op: "remove" });
    else ops.push({ path: `settings.${field}`, op: "set", value });
  }
  return ops;
}

/** Saves a settings patch (fields of UserSettings the home owns) as one batch, rebuilt on fresh data after a conflict. */
export function saveHomeSettings(patch: Partial<UserSettings> | ((settings: UserSettings) => Partial<UserSettings>)): Promise<void> {
  return saveHome((_view, settings) => settingsPatchOps(settings, typeof patch === "function" ? patch(settings) : patch));
}

/** A provider's saved fields, in the home's names (§5.8). */
export interface HomeProviderPatch {
  enabled?: boolean;
  baseUrl?: string | null;
  models?: string[] | null;
  enabledModelIds?: string[] | null;
  defaultModel?: string | null;
  lastValidationSucceeded?: boolean | null;
  lastValidatedAt?: string | null;
}

/**
 * A provider's row (merged, so fields this writer does not name keep their value)
 * and, when given, its key. An account-backed provider never takes a key: its
 * peer token changes with every launch (OD-32).
 */
export function providerOps(providerId: string, patch: HomeProviderPatch, secret?: string): HomeOp[] {
  const ops: HomeOp[] = [];
  if (Object.keys(patch).length > 0) ops.push({ path: `providers.${providerId}`, op: "merge", value: patch });
  if (secret !== undefined && secret.trim()) {
    if (ACCOUNT_BACKED_PROVIDER_IDS.has(providerId)) {
      throw new HomeSaveError("home_invalid_op", "This provider signs in through the account runner and takes no key.");
    }
    ops.push({ path: `credentials.providers.${providerId}`, op: "set", value: { secret: secret.trim() } });
  }
  return ops;
}

/** The fields of a CustomModel the home keeps; never its key. */
export function customModelEntry(model: Partial<CustomModel>): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  for (const field of ["label", "baseURL", "model", "capabilities", "toolCapabilityOverrides", "compatibleTransports",
    "reasoningEffort", "lastValidationSucceeded", "lastValidatedAt", "createdAt"] as const) {
    if (model[field] !== undefined) entry[field] = structuredClone(model[field]);
  }
  return entry;
}

/** Test seam: forget this tab's home state. */
export function __resetHomeClientForTests(): void {
  state = { status: "idle" };
  serverView = null;
  loading = null;
  settled = null;
  resolveSettled = null;
  secretsRemoved = false;
  saveQueue = Promise.resolve();
  listeners.clear();
}
