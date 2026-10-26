import type { ClientStore } from "./store";

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

/** Imported entries replace matching settings; other settings and all work remain. */
export function mergeSettingsImport(current: ClientStore, imported: ImportedSettings): ClientStore {
  return {
    ...current,
    userSettings: { ...current.userSettings, ...imported.userSettings },
    providerKeys: Array.from(new Map([...current.providerKeys, ...(imported.providerKeys ?? [])].map(item => [item.providerId, item])).values()),
    customModels: Array.from(new Map([...current.customModels, ...(imported.customModels ?? [])].map(item => [item.id, item])).values()),
  };
}
