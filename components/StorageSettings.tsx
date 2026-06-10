"use client";

import { useEffect, useState } from "react";
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

export function StorageSettings() {
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
      setMessage("Unlocked.");
    });

  const useBrowser = () =>
    run(async () => {
      await applyStorageConfig({ ...getConfig(), kind: "indexeddb" });
      await refresh();
      setMessage("Now using this browser (IndexedDB).");
    });

  const useFolder = () =>
    run(async () => {
      await pickDirectory();
      await applyStorageConfig({ ...getConfig(), kind: "filesystem" });
      await refresh();
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
      setMessage("Encryption off.");
    });

  const importFromServer = () =>
    run(async () => {
      if (
        !window.confirm(
          "Import all data from the server into this browser's storage? This replaces the current client store."
        )
      ) {
        return;
      }
      const res = await fetch("/api/export");
      const data = await res.json();
      if (!data.store) {
        setMessage("No server data found to import.");
        return;
      }
      replaceStore(data.store);
      await flush();
      setMessage("Imported from the server into client storage.");
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
            Encrypts the whole store (including API keys) with a passphrase.
            Recommended when using a shared or cloud-synced folder.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {config?.encryptionEnabled ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Encryption is on. The store is unreadable without your passphrase.
              </p>
              <Button variant="outline" onClick={disableEncryption} disabled={busy}>
                Turn off encryption
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
          <CardTitle>Migrate from the server</CardTitle>
          <CardDescription>
            One-time import of your existing discussions, settings, keys, and
            custom models into client storage.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={importFromServer} disabled={busy}>
            Import from server
          </Button>
        </CardContent>
      </Card>

      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}
