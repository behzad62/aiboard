import { normalizeUpstream } from "./aiboard-home-store.js";
import { CUSTOM_PROVIDER_ID } from "./home-model-policy.js";
import {
  checkHomeModelId,
  HomeModelError,
  homeProviderUpstream,
  resolveHomeRuntime,
  type HomeModelSource,
} from "./home-runtime.js";
import type { ProviderConfigStore, RunnerProviderConfig } from "./provider-config-store.js";

/**
 * Pushed configs without secrets (Simple Build plan §9, packet HM3).
 *
 * The web pushes provider configs with no `secret`; the Runner resolves each from the AIBoard home.
 * The home decides where a home key goes: the base URL, transport and protocol come from the home and
 * the pushed ones are ignored, and a pushed base URL that differs from the home's is refused with
 * `upstream_mismatch`. A resolved config is stored with `secretSource: "home"` and no secret, and
 * `HomeBackedProviderConfigStore` reads the key from the home each time a runtime is built, so a key
 * removed with `aiboard keys remove`, or replaced, takes effect at once.
 *
 * Configs that take no key from the home pass through as pushed: account-peer configs (ChatGPT and
 * Copilot, whose peer address and token come from the launcher, OD-32) and a config that carries its
 * own secret (the web before HM4a, which a Runner with HM3 still meets, §13 "Release order").
 */

export class PushedConfigError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "PushedConfigError";
  }
}

/** Whether the Runner resolves this pushed config from the home. */
export function takesKeyFromHome(config: RunnerProviderConfig): boolean {
  if (config.transport === "account-runner") return false;
  if (config.secretSource === "home") return true;
  return typeof config.secret !== "string" || config.secret === "";
}

function homeUpstream(home: HomeModelSource, providerId: string, modelId: string): string | null {
  if (providerId === CUSTOM_PROVIDER_ID) return home.config.customModels.find((entry) => entry.id === modelId)?.baseURL ?? null;
  return homeProviderUpstream(home.config, providerId);
}

function sameUpstream(left: string, right: string): boolean {
  try { return normalizeUpstream(left) === normalizeUpstream(right); }
  catch { return false; }
}

/** The connection a runtime takes from the home: transport, base URL, protocol and key. */
function connectionFields(resolved: RunnerProviderConfig): Pick<RunnerProviderConfig, "transport" | "baseUrl" | "protocol" | "secret"> {
  return {
    transport: resolved.transport,
    ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
    ...(resolved.protocol ? { protocol: resolved.protocol } : {}),
    secret: resolved.secret,
  };
}

function withoutConnection(config: RunnerProviderConfig): Omit<RunnerProviderConfig, "transport" | "baseUrl" | "protocol" | "secret" | "secretSource" | "runnerToken"> {
  const rest = { ...config } as Partial<RunnerProviderConfig>;
  delete rest.transport;
  delete rest.baseUrl;
  delete rest.protocol;
  delete rest.secret;
  delete rest.secretSource;
  delete rest.runnerToken;
  return rest as Omit<RunnerProviderConfig, "transport" | "baseUrl" | "protocol" | "secret" | "secretSource" | "runnerToken">;
}

/**
 * Resolves one pushed config from the home into the form the Runner stores: `secretSource: "home"`,
 * no secret, and the home's transport, base URL and protocol. Throws `PushedConfigError`.
 */
export function resolvePushedConfig(home: HomeModelSource, pushed: RunnerProviderConfig): RunnerProviderConfig {
  if (typeof pushed.runtimeId !== "string" || !pushed.runtimeId) throw new PushedConfigError(400, "invalid_request", "A provider config needs a runtimeId.");
  if (pushed.secretSource !== undefined && pushed.secretSource !== "home") throw new PushedConfigError(400, "invalid_request", `Provider runtime ${pushed.runtimeId} has an invalid secret source.`);
  if (pushed.secretSource === "home" && pushed.secret) throw new PushedConfigError(400, "invalid_request", `Provider runtime ${pushed.runtimeId} names the home as its key source and also carries a key.`);
  try {
    const { providerId, modelId } = checkHomeModelId(home.config, pushed.runtimeId);
    if (pushed.providerId !== providerId) throw new PushedConfigError(400, "invalid_request", `Provider runtime ${pushed.runtimeId} names provider ${String(pushed.providerId)}.`);
    // Checked before any key is read: a pushed URL never decides where a home key goes.
    const upstream = homeUpstream(home, providerId, modelId);
    if (typeof pushed.baseUrl === "string" && pushed.baseUrl !== "" && (upstream === null || !sameUpstream(pushed.baseUrl, upstream))) {
      throw new PushedConfigError(422, "upstream_mismatch", `The base URL pushed for ${pushed.runtimeId} is not the one saved in the AIBoard home; save the endpoint in Settings or with the CLI first.`);
    }
    const resolved = resolveHomeRuntime(home, pushed.runtimeId, { priority: pushed.priority, reasoningEffort: pushed.reasoningEffort ?? null }).config;
    const connection = connectionFields(resolved);
    return { ...withoutConnection(pushed), ...connection, secret: "", secretSource: "home" };
  } catch (error) {
    if (error instanceof HomeModelError) throw new PushedConfigError(422, error.code, error.message.replace(/^[a-z_]+: /, ""));
    throw error;
  }
}

/** A stored home-backed config with its key and connection read from the home now. Throws `HomeModelError`. */
export function fillFromHome(home: HomeModelSource, stored: RunnerProviderConfig): RunnerProviderConfig {
  const resolved = resolveHomeRuntime(home, stored.runtimeId, { priority: stored.priority, reasoningEffort: stored.reasoningEffort ?? null }).config;
  return { ...withoutConnection(stored), ...connectionFields(resolved) };
}

/**
 * A provider config store whose home-backed configs take their key from the AIBoard home on every
 * `load()`. A config the home can no longer serve (its key removed, its provider disabled, the home
 * unreadable) is left out, so the places that build runtimes report it as not configured instead of
 * sending a request without a key. `loadStored()` returns the configs as stored, with no secret, for
 * the control server's list and merge.
 */
export class HomeBackedProviderConfigStore implements ProviderConfigStore {
  private readonly reported = new Map<string, string>();

  constructor(private readonly inner: ProviderConfigStore, private readonly readHome: () => HomeModelSource) {}

  load(): RunnerProviderConfig[] {
    const stored = this.inner.load();
    if (!stored.some((config) => config.secretSource === "home")) return stored;
    let home: HomeModelSource | undefined;
    let homeProblem = "";
    try { home = this.readHome(); }
    catch (error) { homeProblem = error instanceof Error ? error.message : "the AIBoard home could not be read"; }
    const filled: RunnerProviderConfig[] = [];
    for (const config of stored) {
      if (config.secretSource !== "home") { filled.push(config); continue; }
      if (!home) { this.report(config.runtimeId, homeProblem); continue; }
      try {
        filled.push(fillFromHome(home, config));
        this.reported.delete(config.runtimeId);
      } catch (error) {
        if (!(error instanceof HomeModelError)) throw error;
        this.report(config.runtimeId, error.message);
      }
    }
    return filled;
  }

  loadStored(): RunnerProviderConfig[] {
    return this.inner.load();
  }

  save(configs: readonly RunnerProviderConfig[]): void {
    this.inner.save(configs);
  }

  close(): void {
    this.inner.close();
  }

  /** Once per runtime and reason: `load()` runs on every Build start, chat turn and media check. */
  private report(runtimeId: string, reason: string): void {
    if (this.reported.get(runtimeId) === reason) return;
    this.reported.set(runtimeId, reason);
    console.warn(`[runner] ${runtimeId} is not available from the AIBoard home: ${reason}`);
  }
}

/** The configs as stored: `loadStored()` when the store fills from the home, else `load()`. */
export function loadStoredProviderConfigs(store: ProviderConfigStore): RunnerProviderConfig[] {
  return store instanceof HomeBackedProviderConfigStore ? store.loadStored() : store.load();
}
