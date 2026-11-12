"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore } from "react";
import { AlertTriangle } from "lucide-react";

import { isEncryptedStorePendingPlainSave, onEncryptedStoreChange } from "@/lib/client/store";
import {
  ENCRYPTED_STORE_CHOICE_HREF,
  ENCRYPTED_STORE_NOTICE,
  installUnsavedStoreGuard,
} from "@/lib/client/unsaved-store-guard";

/** The notice itself, shown on every page while the open encrypted store waits for the user's choice. */
export function UnsavedStoreNoticeView({ pending }: { pending: boolean }) {
  if (!pending) return null;
  return (
    <div
      role="alert"
      data-testid="unsaved-store-notice"
      className="border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm text-foreground sm:px-6"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-2 gap-y-1">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{ENCRYPTED_STORE_NOTICE}</span>
        <Link href={ENCRYPTED_STORE_CHOICE_HREF} className="font-medium underline underline-offset-2">
          Choose in Settings &gt; Storage
        </Link>
      </div>
    </div>
  );
}

/** App-wide: the notice, plus a prompt before leaving while changes are unsaved. */
export function UnsavedStoreNotice() {
  const pending = useSyncExternalStore(onEncryptedStoreChange, isEncryptedStorePendingPlainSave, () => false);
  useEffect(() => {
    if (!pending) return;
    return installUnsavedStoreGuard(window);
  }, [pending]);
  return <UnsavedStoreNoticeView pending={pending} />;
}
