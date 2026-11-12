/**
 * The open encrypted store is written only after the user chooses to save it
 * without encryption (OD-28). Until then every change lives only in this tab,
 * so leaving the page asks first (plan §9, HM4b).
 */
import { hasUnsavedEncryptedStoreChanges } from "./store";

/** Where the user makes that choice. */
export const ENCRYPTED_STORE_CHOICE_HREF = "/settings?tab=storage";

export const ENCRYPTED_STORE_NOTICE =
  "Your changes are not being saved. This store was opened with its passphrase, and nothing is written until you choose to save it without encryption.";

interface BeforeUnloadLike {
  preventDefault(): void;
  returnValue?: unknown;
}

/** The beforeunload handler: it asks only while there are unsaved changes. */
export function warnBeforeUnloadIfUnsaved(event: BeforeUnloadLike): void {
  if (!hasUnsavedEncryptedStoreChanges()) return;
  event.preventDefault();
  // Older browsers show the prompt only when returnValue is set.
  event.returnValue = "";
}

/** Installs the handler on `target` (the window); returns the uninstaller. */
export function installUnsavedStoreGuard(target: Pick<Window, "addEventListener" | "removeEventListener">): () => void {
  const handler = (event: Event) => warnBeforeUnloadIfUnsaved(event as unknown as BeforeUnloadLike);
  target.addEventListener("beforeunload", handler);
  return () => target.removeEventListener("beforeunload", handler);
}
