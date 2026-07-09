"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  applyStorageConfig,
  exportStore,
  flush,
  getConfig,
  initStore,
  replaceStore,
} from "@/lib/client/store";
import {
  fileSystemAccessSupported,
  pickDirectory,
  type StorageConfig,
} from "@/lib/client/storage-adapter";
import {
  lock,
  setPassphrase as cryptoSetPassphrase,
  unlock,
} from "@/lib/client/crypto-box";
import { FolderOpen, HardDrive, Lock, ShieldCheck } from "lucide-react";

export function StorageSettings({
  onChanged,
}: {
  onChanged?: () => void | Promise<void>;
}) {
  const [config, setConfig] = useState<StorageConfig | null>(null);
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  const [passphrase, setPassphraseInput] = useState("");
  const [fsaSupported, setFsaSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async () => {
    const res = await initStore();
    setNeedsPassphrase(res.needsPassphrase);
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
      setMessage("Unlocked.");
    });

  const useBrowser = () =>
    run(async () => {
      await applyStorageConfig({ ...getConfig(), kind: "indexeddb" });
      await refresh();
      await onChanged?.();
      setMessage("Now using this browser (IndexedDB).");
    });

  const useFolder = () =>
    run(async () => {
      await pickDirectory();
      await applyStorageConfig({ ...getConfig(), kind: "filesystem" });
      await refresh();
      await onChanged?.();
      setMessage(
        "Now using a local folder. Point another browser at the same folder, or sync it via OneDrive/Dropbox, to share state."
      );
    });

  const enableEncryption = () =>
    run(async () => {
      if (passphrase.length < 6) {
        throw new Error("Use a passphrase of at least 6 characters.");
      }
      const salt = await cryptoSetPassphrase(passphrase);
      await applyStorageConfig({
        ...getConfig(),
        encryptionEnabled: true,
        salt,
      });
      setPassphraseInput("");
      await refresh();
      setMessage(
        "Encryption on. You'll enter this passphrase once per session — there is no recovery if you lose it."
      );
    });

  const disableEncryption = () =>
    run(async () => {
      await applyStorageConfig({
        ...getConfig(),
        encryptionEnabled: false,
        salt: undefined,
      });
      lock();
      await refresh();
      await onChanged?.();
      setMessage("Passphrase lock removed. The main store is now saved unencrypted.");
    });

  const fileRef = useRef<HTMLInputElement>(null);

  const exportToFile = () =>
    run(async () => {
      const blob = new Blob([JSON.stringify(exportStore(), null, 2)], {
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
      if (
        !window.confirm(
          "Import this file? It replaces the current data in this browser."
        )
      ) {
        return;
      }
      const parsed = JSON.parse(await file.text());
      replaceStore(parsed.store ?? parsed);
      await flush();
      await onChanged?.();
      setMessage("Imported data from file.");
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
            This store is encrypted. Enter your passphrase to unlock it for this
            session.
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Passphrase encryption
          </CardTitle>
          <CardDescription>
            Encrypts the main store file (including API keys) with a passphrase.
            Discussion folders stay as readable local JSON so you can inspect,
            remove, or back them up directly.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {config?.encryptionEnabled ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Encryption is on for the main store. Discussion folders remain
                readable local JSON files. Remove the passphrase lock to stop
                requiring an unlock after tab or browser restarts.
              </p>
              <Button variant="outline" onClick={disableEncryption} disabled={busy}>
                Remove passphrase lock
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="set-passphrase">Set a passphrase</Label>
              <Input
                id="set-passphrase"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphraseInput(e.target.value)}
                placeholder="At least 6 characters"
              />
              <Button onClick={enableEncryption} disabled={busy}>
                Enable encryption
              </Button>
              <p className="text-xs text-muted-foreground">
                No recovery — if you forget it, the data can&apos;t be decrypted.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Backup &amp; restore</CardTitle>
          <CardDescription>
            Export everything to a JSON file, or import it into another browser
            or device — a portable backup without a shared folder.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
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
