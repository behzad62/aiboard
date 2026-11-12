"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  declineEncryptedStore,
  exportStore,
  flush,
  getConfig,
  initStore,
  isEncryptedStorePendingPlainSave,
  replaceStore,
  saveStoreWithoutEncryption,
  switchStorageLocation,
  withoutSecrets,
} from "@/lib/client/store";
import {
  fileSystemAccessSupported,
  pickDirectory,
  type StorageConfig,
} from "@/lib/client/storage-adapter";
import { unlock } from "@/lib/client/crypto-box";
import { FolderOpen, HardDrive, Lock, ShieldCheck } from "lucide-react";
import { homeOpsFromSettingsImport, parseSettingsImport } from "@/lib/client/storage-import";
import { KEYS_NOT_IMPORTED_MESSAGE, isHomeReady, saveHome } from "@/lib/client/home-client";

/** The AIBoard home takes at most 256 ops in one batch. */
const IMPORT_BATCH_OPS = 200;

export function StorageSettings({
  onChanged,
}: {
  onChanged?: () => void | Promise<void>;
}) {
  const [config, setConfig] = useState<StorageConfig | null>(null);
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  const [pendingPlainSave, setPendingPlainSave] = useState(false);
  const [passphrase, setPassphraseInput] = useState("");
  const [fsaSupported, setFsaSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async () => {
    const res = await initStore();
    setNeedsPassphrase(res.needsPassphrase);
    setPendingPlainSave(isEncryptedStorePendingPlainSave());
    setConfig({ ...getConfig() });
  };

  useEffect(() => {
    setFsaSupported(fileSystemAccessSupported());
    refresh().catch((e) =>
      setMessage(e instanceof Error ? e.message : "Failed to load storage")
    );
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const doUnlock = () =>
    run(async () => {
      const cfg = getConfig();
      if (!cfg.salt) throw new Error("No passphrase salt stored.");
      await unlock(passphrase, cfg.salt);
      setPassphraseInput("");
      await refresh();
      await onChanged?.();
      setMessage("Unlocked. Nothing is saved until you choose below.");
    });

  // OD-28: the store opened once with its passphrase is saved without encryption
  // only after the user confirms; declining leaves it untouched.
  const confirmPlainSave = () =>
    run(async () => {
      await saveStoreWithoutEncryption();
      await refresh();
      await onChanged?.();
      setMessage("Saved without encryption. Your chats and builds are kept.");
    });

  const declinePlainSave = () =>
    run(async () => {
      const result = await declineEncryptedStore();
      await refresh();
      await onChanged?.();
      setMessage(result.startedNewBrowserStore
        ? "The encrypted folder was left untouched. This page now uses a new store in this browser."
        : "The encrypted store was left untouched and is locked again.");
    });

  const useBrowser = () =>
    run(async () => {
      const result = await switchStorageLocation({
        ...getConfig(),
        kind: "indexeddb",
      });
      await refresh();
      await onChanged?.();
      setMessage(
        result.loadedExisting
          ? "Loaded the existing data stored in this browser (IndexedDB)."
          : "Now using this browser (IndexedDB). Your current data was copied here."
      );
    });

  const useFolder = () =>
    run(async () => {
      try {
        await pickDirectory();
      } catch (error) {
        if (error instanceof Error && ["AbortError", "NotAllowedError"].includes(error.name)) {
          throw new Error("Folder access was not granted. If you selected a folder, the browser may have refused read/write access. To copy saved settings, use Import settings below and select the folder's store.json.", { cause: error });
        }
        throw error;
      }
      const result = await switchStorageLocation({
        ...getConfig(),
        kind: "filesystem",
      });
      await refresh();
      await onChanged?.();
      setMessage(
        result.loadedExisting
          ? "Loaded the existing data from this local folder."
          : "Now using a local folder. Your current data was copied there."
      );
    });

  const fileRef = useRef<HTMLInputElement>(null);
  const settingsFileRef = useRef<HTMLInputElement>(null);

  // Imported settings go to the AIBoard home; keys are skipped (plan §6.1 "Import and export").
  const importSettings = (file: File) =>
    run(async () => {
      if (!isHomeReady()) {
        throw new Error("Connect AI Board first: settings are imported into your AIBoard home.");
      }
      const imported = parseSettingsImport(await file.text());
      const plan = homeOpsFromSettingsImport(imported);
      for (let index = 0; index < plan.ops.length; index += IMPORT_BATCH_OPS) {
        const batch = plan.ops.slice(index, index + IMPORT_BATCH_OPS);
        await saveHome(() => batch);
      }
      await onChanged?.();
      setMessage([
        "Imported provider settings, custom models, and app defaults into your AIBoard home. Your existing chats and benchmark history were preserved.",
        plan.skippedKeys.length > 0 ? `Not imported: the keys for ${plan.skippedKeys.join(", ")}. ${KEYS_NOT_IMPORTED_MESSAGE}` : null,
      ].filter(Boolean).join(" "));
    });

  // An export never holds a key.
  const exportToFile = () =>
    run(async () => {
      const blob = new Blob([JSON.stringify(withoutSecrets(exportStore()), null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ai-discussion-board-store.json";
      a.click();
      URL.revokeObjectURL(url);
      setMessage("Exported your data to a JSON file.");
    });

  const importFromFile = (file: File) =>
    run(async () => {
      const parsed = JSON.parse(await file.text());
      if (parsed && typeof parsed === "object" && "encrypted" in parsed) {
        throw new Error("This is a local-folder store.json. Use Import settings to copy its configuration. For a full restore, export a backup from the original browser first.");
      }
      if (
        !window.confirm(
          "Import this file? It replaces the current data in this browser."
        )
      ) {
        return;
      }
      // Keys are never imported; under a connected AI Board the settings stay the home's.
      replaceStore(withoutSecrets(parsed.store ?? parsed));
      await flush();
      await onChanged?.();
      setMessage(`Imported data from file. ${KEYS_NOT_IMPORTED_MESSAGE}`);
    });

  if (needsPassphrase) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5 text-primary" />
            Unlock storage
          </CardTitle>
          <CardDescription>
            This store was encrypted with a passphrase. AI Board no longer
            encrypts this browser&apos;s store: your keys live in your AIBoard
            home. Enter the passphrase once to open it; then choose whether to
            save it without encryption.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphraseInput(e.target.value)}
            placeholder="Passphrase"
            onKeyDown={(e) => e.key === "Enter" && doUnlock()}
          />
          <Button onClick={doUnlock} disabled={busy}>
            Unlock
          </Button>
          {message && <p className="text-sm text-destructive">{message}</p>}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Where your data lives</CardTitle>
          <CardDescription>
            Default is this browser. On desktop you can point at a local folder
            to share state across browsers — or sync it via a cloud folder.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="secondary">
              Location:{" "}
              {config?.kind === "filesystem" ? "Local folder" : "This browser"}
            </Badge>
            <Badge variant={config?.encryptionEnabled ? "success" : "secondary"}>
              Encryption: {config?.encryptionEnabled ? "on" : "off"}
            </Badge>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={useBrowser}
              disabled={busy}
              className={
                config?.kind === "indexeddb"
                  ? "rounded-lg border border-primary bg-primary/5 p-4 text-left ring-1 ring-primary"
                  : "rounded-lg border p-4 text-left transition-colors hover:bg-accent"
              }
            >
              <span className="flex items-center gap-2 font-medium">
                <HardDrive className="h-4 w-4" />
                This browser
              </span>
              <span className="mt-1 block text-sm text-muted-foreground">
                IndexedDB. Works on every device. Not shared between browsers.
              </span>
            </button>

            <button
              type="button"
              onClick={useFolder}
              disabled={busy || !fsaSupported}
              className={
                config?.kind === "filesystem"
                  ? "rounded-lg border border-primary bg-primary/5 p-4 text-left ring-1 ring-primary disabled:opacity-50"
                  : "rounded-lg border p-4 text-left transition-colors hover:bg-accent disabled:opacity-50"
              }
            >
              <span className="flex items-center gap-2 font-medium">
                <FolderOpen className="h-4 w-4" />
                Local folder
              </span>
              <span className="mt-1 block text-sm text-muted-foreground">
                {fsaSupported
                  ? "Pick a folder. Share across browsers / sync via cloud."
                  : "Not supported in this browser (desktop Chrome/Edge only)."}
              </span>
            </button>
          </div>
        </CardContent>
      </Card>

      {pendingPlainSave && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              Save without encryption?
            </CardTitle>
            <CardDescription>
              This store is open with its passphrase and nothing has been saved
              yet. Save it without encryption to keep your chats, builds and
              benchmark history. Your keys are not part of it any more: they
              live in your AIBoard home.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button onClick={confirmPlainSave} disabled={busy}>
              Save without encryption
            </Button>
            <Button variant="outline" onClick={declinePlainSave} disabled={busy}>
              {config?.kind === "filesystem" ? "Leave the folder untouched" : "Keep it encrypted"}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Backup &amp; restore</CardTitle>
          <CardDescription>
            Import settings from a local folder&apos;s store.json or an exported
            backup to copy providers, custom models, and defaults into your
            AIBoard home. Keys are never imported or exported: set them on the
            Providers tab or with <code>aiboard keys set</code>. Existing chats
            and benchmark history stay in place. Export or restore a full
            backup with the other actions.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => settingsFileRef.current?.click()} disabled={busy}>
            Import settings
          </Button>
          <input
            ref={settingsFileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Import AI Board settings file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importSettings(file);
              e.target.value = "";
            }}
          />
          <Button variant="outline" onClick={exportToFile} disabled={busy}>
            Export to file
          </Button>
          <Button
            variant="outline"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            Import from file
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importFromFile(file);
              e.target.value = "";
            }}
          />
        </CardContent>
      </Card>

      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}
