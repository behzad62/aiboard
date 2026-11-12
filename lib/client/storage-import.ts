import type { ClientStore } from "./store";
import type { HomeOp } from "./home-client";

type ImportedSettings = Partial<Pick<ClientStore, "userSettings" | "providerKeys" | "customModels">>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Accept a browser export or the envelope used by a local-folder store.json. */
export function parseSettingsImport(text: string): ImportedSettings {
  let parsed: unknown = JSON.parse(text);
  if (record(parsed) && "encrypted" in parsed) {
    if (parsed.encrypted !== false) {
      throw new Error("This file is encrypted. Unlock it in the original browser and use Export to file, then import that backup.");
    }
    if (typeof parsed.data !== "string") throw new Error("The saved settings file has no readable data.");
    parsed = JSON.parse(parsed.data);
  }
  if (record(parsed) && record(parsed.store)) parsed = parsed.store;
  if (!record(parsed)) throw new Error("Choose an AI Board store.json or exported backup.");
  const settings: ImportedSettings = {};
  if ("userSettings" in parsed) {
    if (!record(parsed.userSettings)) throw new Error("The file contains invalid app settings.");
    settings.userSettings = parsed.userSettings as unknown as ClientStore["userSettings"];
  }
  for (const key of ["providerKeys", "customModels"] as const) {
    if (!(key in parsed)) continue;
    const items = parsed[key];
    const id = key === "providerKeys" ? "providerId" : "id";
    if (!Array.isArray(items) || !items.every(item => record(item) && typeof item[id] === "string" && item[id].trim())) {
      throw new Error(`The file contains invalid ${key === "providerKeys" ? "provider settings" : "custom models"}.`);
    }
    if (key === "providerKeys") settings.providerKeys = items as ClientStore["providerKeys"];
    else settings.customModels = items as ClientStore["customModels"];
  }
  if (Object.keys(settings).length === 0) throw new Error("This file contains no AI Board settings.");
  return settings;
}

/** The settings an import may write to the AIBoard home: the home-owned UserSettings fields, never a secret. */
const IMPORTABLE_SETTINGS = [
  "defaultEffort", "defaultMode", "judgeModelId", "defaultVerbosity", "defaultStyleNote",
  "defaultReasoningEffort", "defaultBuildRunPolicy", "defaultBuildSkillMode", "defaultBuildBudgetUsd",
  "defaultBuildTimeLimitMinutes", "defaultBuildAlwaysRequireIndependentVerifier",
  "modelPricingOverrides", "modelContextOverrides", "discoveredModelMetadata", "providerToolCapabilityEvidence",
  "modelCapabilityProfiles",
] as const;
const MAP_SETTINGS = new Set(["modelPricingOverrides", "modelContextOverrides", "discoveredModelMetadata", "modelCapabilityProfiles"]);
const CUSTOM_MODEL_FIELDS = [
  "label", "baseURL", "model", "capabilities", "toolCapabilityOverrides", "compatibleTransports",
  "reasoningEffort", "createdAt",
] as const;

export interface SettingsImportPlan {
  ops: HomeOp[];
  /** Provider and custom-model names whose keys the file held and the import skipped. */
  skippedKeys: string[];
}

/**
 * Imported entries replace matching settings in the AIBoard home; other settings
 * and all of this browser's work remain. Keys are skipped: the file's provider
 * keys, runner tokens, custom-model keys and the remote MCP token never leave
 * this page (plan §6.1 "Import and export"). Map-valued settings import entry by
 * entry, so entries the file does not name keep their value.
 */
export function homeOpsFromSettingsImport(imported: ImportedSettings): SettingsImportPlan {
  const ops: HomeOp[] = [];
  const skippedKeys: string[] = [];
  const settings = (imported.userSettings ?? {}) as unknown as Record<string, unknown>;
  for (const field of IMPORTABLE_SETTINGS) {
    const value = settings[field];
    if (value === undefined) continue;
    if (MAP_SETTINGS.has(field) && record(value)) {
      for (const [entry, entryValue] of Object.entries(value)) ops.push({ path: `settings.${field}.${entry}`, op: "set", value: entryValue });
      continue;
    }
    if (value === null && field !== "judgeModelId") continue;
    ops.push({ path: `settings.${field}`, op: "set", value });
  }
  if (settings.openAIConnectionMode === "api" || settings.openAIConnectionMode === "subscription") {
    ops.push({ path: "openAIConnectionMode", op: "set", value: settings.openAIConnectionMode });
  }
  const runtime = record(settings.toolRuntime) ? settings.toolRuntime : undefined;
  if (runtime) {
    const home: Record<string, unknown> = {};
    const remote = runtime.remoteMcpServer;
    if (record(remote) && typeof remote.enabled === "boolean" && typeof remote.name === "string" && typeof remote.url === "string") {
      home.remoteMcpServer = { enabled: remote.enabled, name: remote.name, url: remote.url };
      if (typeof remote.authorizationToken === "string" && remote.authorizationToken) skippedKeys.push("remote MCP server");
    }
    const search = runtime.openaiFileSearch;
    if (record(search) && typeof search.enabled === "boolean" && Array.isArray(search.vectorStoreIds)) {
      home.openaiFileSearch = { enabled: search.enabled, vectorStoreIds: search.vectorStoreIds.filter((id) => typeof id === "string") };
    }
    if (Object.keys(home).length > 0) ops.push({ path: "settings.toolRuntime", op: "merge", value: home });
  }
  for (const key of imported.providerKeys ?? []) {
    const value: Record<string, unknown> = {};
    if (typeof key.enabled === "boolean") value.enabled = key.enabled;
    if (key.baseURL !== undefined) value.baseUrl = key.baseURL || null;
    if (key.models !== undefined) value.models = key.models;
    if (key.enabledModelIds !== undefined) value.enabledModelIds = key.enabledModelIds;
    if (key.defaultModel !== undefined) value.defaultModel = key.defaultModel;
    if (Object.keys(value).length > 0) ops.push({ path: `providers.${key.providerId}`, op: "merge", value });
    if (key.apiKey || key.runnerToken || key.encryptedKey) skippedKeys.push(key.providerId);
  }
  for (const model of imported.customModels ?? []) {
    const value: Record<string, unknown> = {};
    for (const field of CUSTOM_MODEL_FIELDS) {
      if (model[field] !== undefined) value[field] = model[field];
    }
    if (typeof value.label !== "string" || typeof value.baseURL !== "string" || typeof value.model !== "string") continue;
    ops.push({ path: `customModels.${model.id}`, op: "set", value });
    if (model.apiKey || model.encryptedKey) skippedKeys.push(model.label || model.id);
  }
  return { ops, skippedKeys };
}
