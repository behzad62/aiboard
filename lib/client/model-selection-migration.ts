import type { ClientStore } from "./store";
import {
  migrateFullModelId,
  migrateModelIdKeyedRecord,
  migrateProviderModelId,
} from "@/lib/providers/model-id-migration";

const RESUMABLE_GAME_STATUSES = new Set(["setup", "active", "paused"]);

/**
 * Migrates only saved selections that can still drive a future model call.
 * Historical evidence and completed records intentionally retain their exact
 * model ids so exports and benchmark provenance do not change retroactively.
 */
export function migrateClientStoreModelSelections(
  input: ClientStore
): { store: ClientStore; changed: boolean } {
  const store = structuredClone(input);
  let changed = false;

  const migrateFull = (modelId: string | null | undefined) => {
    if (!modelId) return modelId;
    const migrated = migrateFullModelId(modelId);
    if (migrated !== modelId) changed = true;
    return migrated;
  };

  store.userSettings.judgeModelId = migrateFull(
    store.userSettings.judgeModelId
  ) as string | null;

  const pricingOverrides = migrateModelIdKeyedRecord(
    store.userSettings.modelPricingOverrides
  );
  if (
    JSON.stringify(pricingOverrides) !==
    JSON.stringify(store.userSettings.modelPricingOverrides)
  ) {
    store.userSettings.modelPricingOverrides = pricingOverrides;
    changed = true;
  }

  const contextOverrides = migrateModelIdKeyedRecord(
    store.userSettings.modelContextOverrides
  );
  if (
    JSON.stringify(contextOverrides) !==
    JSON.stringify(store.userSettings.modelContextOverrides)
  ) {
    store.userSettings.modelContextOverrides = contextOverrides;
    changed = true;
  }

  for (const provider of store.providerKeys) {
    if (!provider.defaultModel) continue;
    const migrated = migrateProviderModelId(
      provider.providerId,
      provider.defaultModel
    );
    if (migrated !== provider.defaultModel) {
      provider.defaultModel = migrated;
      changed = true;
    }
  }

  for (const discussion of store.discussions) {
    try {
      const parsed: unknown = JSON.parse(discussion.modelIds);
      if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
        const migrated = parsed.map((id) => migrateFull(id));
        if (migrated.some((id, index) => id !== parsed[index])) {
          discussion.modelIds = JSON.stringify(migrated);
        }
      }
    } catch {
      // Preserve malformed historical data; validation remains the caller's job.
    }
    discussion.judgeModelId = migrateFull(discussion.judgeModelId) as
      | string
      | null;
    discussion.reviewerModelId = migrateFull(discussion.reviewerModelId) as
      | string
      | null
      | undefined;
  }

  for (const session of store.gameSessions) {
    if (!RESUMABLE_GAME_STATUSES.has(session.status)) continue;
    for (const participant of session.participants) {
      if (participant.kind !== "ai") continue;
      if (participant.modelId) {
        participant.modelId = migrateFull(participant.modelId) as string;
      }
    }
  }

  return changed ? { store, changed: true } : { store: input, changed: false };
}
