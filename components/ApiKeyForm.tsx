"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Copy } from "lucide-react";
import type { ModelInfo } from "@/lib/providers/base";
import { getProviderDefinition } from "@/lib/providers/provider-registry";
import { getModelRuntimeBehavior } from "@/lib/providers/runtime-behavior";
import { saveProviderKey, validateProvider } from "@/lib/client/settings-api";
import { getProviderKey } from "@/lib/client/store";

interface ProviderConfig {
  providerId: string;
  name: string;
  models: ModelInfo[];
  hasKey: boolean;
  keyHint?: string | null;
  baseURL?: string | null;
  runnerTokenHint?: string | null;
  modelIds?: string[];
  defaultModel?: string | null;
  enabled: boolean;
  lastValidationSucceeded?: boolean | null;
  lastValidatedAt?: string | null;
}

interface AccountRunnerLoginResponse {
  ok?: boolean;
  url?: string;
  verificationUrl?: string;
  deviceCode?: string;
  userCode?: string;
  expiresIn?: number;
  instructions?: string;
  error?: string;
}

interface DeviceLoginPrompt {
  code: string;
  verificationUrl?: string;
  copied: boolean;
}

interface ApiKeyFormProps {
  provider: ProviderConfig;
  onSaved: () => Promise<void> | void;
  onDraftChange?: (providerId: string, patch: { enabled: boolean }) => void;
}

export function ApiKeyForm({ provider, onSaved, onDraftChange }: ApiKeyFormProps) {
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState(provider.baseURL ?? "");
  const [runnerToken, setRunnerToken] = useState("");
  const [modelIdsText, setModelIdsText] = useState((provider.modelIds ?? []).join("\n"));
  const [defaultModel, setDefaultModel] = useState(provider.defaultModel ?? provider.models[0]?.id ?? "");
  const [enabled, setEnabled] = useState(provider.enabled);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [deviceLoginPrompt, setDeviceLoginPrompt] = useState<DeviceLoginPrompt | null>(null);
  const providerDefinition = getProviderDefinition(provider.providerId);
  const baseUrlField = providerDefinition?.baseURLField;
  const runnerTokenField = providerDefinition?.runnerTokenField;
  const modelIdsField = providerDefinition?.modelIdsField;
  const accountRunner = providerDefinition?.accountRunner;
  const runnerDownload = providerDefinition?.runnerDownload;

  const parsedModelIds = modelIdsText
    .split(/[\n,]/)
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  const selectableModels = modelIdsField
    ? parsedModelIds.map((id) => ({ id, name: id }))
    : provider.models;

  useEffect(() => {
    setDefaultModel(provider.defaultModel ?? provider.models[0]?.id ?? "");
    setEnabled(provider.enabled);
    setBaseURL(provider.baseURL ?? "");
    setRunnerToken("");
    setModelIdsText((provider.modelIds ?? []).join("\n"));
  }, [provider.defaultModel, provider.enabled, provider.models, provider.baseURL, provider.modelIds]);

  const save = async () => {
    setLoading(true);
    setMessage(null);
    try {
      if (baseUrlField && !baseURL.trim()) {
        throw new Error(
          providerDefinition?.baseURLRequiredMessage ??
            "This provider needs its endpoint base URL"
        );
      }
      if (modelIdsField && parsedModelIds.length === 0) {
        throw new Error("Add at least one model id");
      }
      if (runnerTokenField && !runnerToken.trim() && !provider.runnerTokenHint) {
        throw new Error(
          providerDefinition?.runnerTokenRequiredMessage ??
            "This provider needs the local runner token"
        );
      }
      const nextDefault =
        modelIdsField && !parsedModelIds.includes(defaultModel)
          ? parsedModelIds[0]
          : defaultModel;
      saveProviderKey({
        providerId: provider.providerId,
        apiKey: apiKey || undefined,
        baseURL: baseUrlField ? baseURL : undefined,
        runnerToken: runnerTokenField
          ? runnerToken.trim() || undefined
          : undefined,
        models: modelIdsField ? parsedModelIds : undefined,
        defaultModel: nextDefault,
        enabled,
      });
      setApiKey("");
      setRunnerToken("");
      setMessage("Saved successfully");
      await onSaved();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Save failed");
    } finally {
      setLoading(false);
    }
  };

  const testKey = async () => {
    setTesting(true);
    setMessage(null);
    try {
      const data = await validateProvider({
        providerId: provider.providerId,
        apiKey: apiKey || undefined,
        baseURL: baseUrlField ? baseURL : undefined,
        runnerToken: runnerTokenField
          ? runnerToken.trim() || undefined
          : undefined,
        modelId: defaultModel,
      });
      setMessage(
        data.valid
          ? `Model test successful${data.usedImage ? " with test image" : ""}: ${data.preview ?? "Response received"}`
          : data.error ?? "Model test failed"
      );
      await onSaved();
    } catch {
      setMessage("Validation failed");
      await onSaved();
    } finally {
      setTesting(false);
    }
  };

  const loginAccountProvider = async () => {
    if (!accountRunner) return;
    setLoggingIn(true);
    setMessage(null);
    setDeviceLoginPrompt(null);
    try {
      const saved = getProviderKey(provider.providerId);
      const runnerBaseURL = (baseURL || saved?.baseURL || "").trim().replace(/\/$/, "");
      const runnerToken = (apiKey || saved?.apiKey || "").trim();
      if (!runnerBaseURL) throw new Error("Enter the account runner URL first");
      if (!runnerToken) throw new Error("Enter or save the account runner token first");

      const response = await fetch(`${runnerBaseURL}/providers/${accountRunner.path}/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-runner-token": runnerToken,
        },
      });
      const data = (await response.json().catch(() => ({}))) as AccountRunnerLoginResponse;
      if (!response.ok || data.error) {
        throw new Error(data.error ?? `Login failed (${response.status})`);
      }
      const deviceCode = data.deviceCode ?? data.userCode;
      let copied = false;
      if (deviceCode && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(deviceCode);
          copied = true;
        } catch {
          copied = false;
        }
      }
      if (deviceCode) {
        setDeviceLoginPrompt({
          code: deviceCode,
          verificationUrl: data.verificationUrl ?? data.url,
          copied,
        });
      }
      const loginUrl = data.verificationUrl ?? data.url;
      if (loginUrl) window.open(loginUrl, "_blank", "noopener,noreferrer");
      setMessage(
        [
          deviceCode
            ? `${copied ? "Copied" : "Use"} GitHub code ${deviceCode}.`
            : data.instructions,
          loginUrl ? "Opened the provider login in a new tab." : null,
          "After approval finishes, click Test connection.",
        ]
          .filter(Boolean)
          .join(" ")
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoggingIn(false);
    }
  };

  const copyDeviceCode = async () => {
    if (!deviceLoginPrompt) return;
    try {
      await navigator.clipboard.writeText(deviceLoginPrompt.code);
      setDeviceLoginPrompt({ ...deviceLoginPrompt, copied: true });
      setMessage(`Copied GitHub code ${deviceLoginPrompt.code}. Paste it into the GitHub device page.`);
    } catch {
      setMessage(`Copy failed. Type GitHub code ${deviceLoginPrompt.code} into the GitHub device page.`);
    }
  };

  const handleEnabledChange = async (checked: boolean) => {
    if (!provider.hasKey) {
      setMessage(
        providerDefinition?.missingCredentialMessage ??
          "Save an API key before enabling this provider"
      );
      return;
    }
    if (runnerTokenField && !provider.runnerTokenHint) {
      setMessage(
        providerDefinition?.runnerTokenRequiredMessage ??
          "Save the local runner token before enabling this provider"
      );
      return;
    }

    const previousEnabled = enabled;
    setEnabled(checked);
    onDraftChange?.(provider.providerId, { enabled: checked });
    setToggling(true);
    setMessage(null);

    try {
      saveProviderKey({
        providerId: provider.providerId,
        defaultModel,
        enabled: checked,
      });
      setMessage(checked ? "Provider enabled" : "Provider disabled");
      await onSaved();
    } catch (err) {
      setEnabled(previousEnabled);
      onDraftChange?.(provider.providerId, { enabled: previousEnabled });
      setMessage(err instanceof Error ? err.message : "Failed to update provider");
    } finally {
      setToggling(false);
    }
  };

  const validationLabel = provider.lastValidationSucceeded == null
    ? "Not tested"
    : provider.lastValidationSucceeded
      ? "Connection verified"
      : "Last test failed";

  const validationVariant = provider.lastValidationSucceeded == null
    ? "secondary"
    : provider.lastValidationSucceeded
      ? "success"
      : "destructive";
  const runtimeBehavior = getModelRuntimeBehavior(
    `${provider.providerId}:${defaultModel}`
  );
  const keyLabel =
    accountRunner?.tokenLabel ?? providerDefinition?.credentialLabel ?? "API Key";
  const keyPlaceholder = provider.hasKey
    ? providerDefinition?.savedCredentialPlaceholder ??
      "Leave blank to keep existing key"
    : providerDefinition?.credentialPlaceholder ?? "Enter API key";
  const runnerTokenPlaceholder = provider.runnerTokenHint
    ? "Leave blank to keep existing local runner token"
    : runnerTokenField?.placeholder ?? "Paste local runner token";

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">{provider.name}</h3>
          {provider.hasKey && provider.keyHint && (
            <p className="text-xs text-muted-foreground">Saved key: {provider.keyHint}</p>
          )}
          {provider.runnerTokenHint && (
            <p className="text-xs text-muted-foreground">
              Saved runner token: {provider.runnerTokenHint}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={`enabled-${provider.providerId}`}>Enabled</Label>
          <Switch
            id={`enabled-${provider.providerId}`}
            checked={enabled}
            disabled={toggling || loading || testing || loggingIn}
            onCheckedChange={handleEnabledChange}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={validationVariant}>{validationLabel}</Badge>
        {provider.lastValidatedAt && (
          <span>Last checked {new Date(provider.lastValidatedAt).toLocaleString()}</span>
        )}
      </div>

      {baseUrlField && (
        <div className="space-y-2">
          <Label htmlFor={`baseurl-${provider.providerId}`}>{baseUrlField.label}</Label>
          <Input
            id={`baseurl-${provider.providerId}`}
            placeholder={baseUrlField.placeholder}
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{baseUrlField.hint}</p>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor={`key-${provider.providerId}`}>{keyLabel}</Label>
        <Input
          id={`key-${provider.providerId}`}
          type="password"
          placeholder={keyPlaceholder}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        {accountRunner && (
          <p className="text-xs text-muted-foreground">
            {accountRunner.tokenHint}
          </p>
        )}
      </div>

      {runnerTokenField && (
        <div className="space-y-2">
          <Label htmlFor={`runner-token-${provider.providerId}`}>
            {runnerTokenField.label}
          </Label>
          <Input
            id={`runner-token-${provider.providerId}`}
            type="password"
            placeholder={runnerTokenPlaceholder}
            value={runnerToken}
            onChange={(e) => setRunnerToken(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{runnerTokenField.hint}</p>
        </div>
      )}

      {accountRunner && (
        <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Account runner and login</p>
          <p className="mt-1">{accountRunner.setupHint}</p>
          <p className="mt-2 rounded bg-background/70 px-2 py-1 font-mono text-xs">
            {accountRunner.command}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={accountRunner.downloadHref}
              download
              className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              Download account runner
            </a>
            <Button
              type="button"
              variant="secondary"
              onClick={loginAccountProvider}
              disabled={loggingIn || loading || testing}
            >
              {loggingIn ? "Starting login..." : accountRunner.loginLabel}
            </Button>
          </div>
          {deviceLoginPrompt && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border bg-background/80 p-3 text-foreground">
              <div>
                <p className="text-xs font-medium text-muted-foreground">GitHub device code</p>
                <p className="font-mono text-lg font-semibold tracking-normal">{deviceLoginPrompt.code}</p>
                <p className="text-xs text-muted-foreground">
                  Paste this code into the GitHub device page{deviceLoginPrompt.verificationUrl ? ` at ${deviceLoginPrompt.verificationUrl}` : ""}.
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={copyDeviceCode}>
                <Copy className="h-4 w-4" aria-hidden="true" />
                {deviceLoginPrompt.copied ? "Copied" : "Copy"}
              </Button>
            </div>
          )}
        </div>
      )}

      {runnerDownload && !accountRunner && (
        <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Account runner</p>
          <p className="mt-1">{runnerDownload.hint}</p>
          <p className="mt-2 rounded bg-background/70 px-2 py-1 font-mono text-xs">
            {runnerDownload.command}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={runnerDownload.downloadHref}
              download
              className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              Download account runner
            </a>
          </div>
        </div>
      )}

      {modelIdsField && (
        <div className="space-y-2">
          <Label htmlFor={`models-${provider.providerId}`}>{modelIdsField.label}</Label>
          <Textarea
            id={`models-${provider.providerId}`}
            rows={3}
            placeholder={modelIdsField.placeholder}
            value={modelIdsText}
            onChange={(e) => setModelIdsText(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{modelIdsField.hint}</p>
        </div>
      )}

      <div className="space-y-2">
        <Label>Default model</Label>
        <Select value={defaultModel} onValueChange={setDefaultModel}>
          <SelectTrigger>
            <SelectValue placeholder={selectableModels.length ? undefined : "Add a model id above"} />
          </SelectTrigger>
          <SelectContent>
            {selectableModels.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          <p className="font-medium">Runtime behavior</p>
          <p className="mt-1 text-muted-foreground">{runtimeBehavior.temperatureLabel}</p>
          <p className="text-xs text-muted-foreground">{runtimeBehavior.temperatureNote}</p>
          <p className="mt-2 text-muted-foreground">{runtimeBehavior.promptCachingLabel}</p>
          <p className="text-xs text-muted-foreground">{runtimeBehavior.promptCachingNote}</p>
          {runtimeBehavior.concurrencyNote && (
            <>
              <p className="mt-2 text-muted-foreground">Concurrency</p>
              <p className="text-xs text-muted-foreground">
                {runtimeBehavior.concurrencyNote}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="flex gap-2">
        <Button type="button" onClick={save} disabled={loading}>
          {loading ? "Saving..." : "Save"}
        </Button>
        <Button type="button" variant="outline" onClick={testKey} disabled={testing}>
          {testing ? "Testing..." : "Test connection"}
        </Button>
      </div>

      {message && (
        <p className="text-sm text-muted-foreground">{message}</p>
      )}
    </div>
  );
}
