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
import type { ModelInfo } from "@/lib/providers/base";
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
  modelIds?: string[];
  defaultModel?: string | null;
  enabled: boolean;
  lastValidationSucceeded?: boolean | null;
  lastValidatedAt?: string | null;
}

const NEEDS_BASE_URL: Record<string, { label: string; placeholder: string; hint: string }> = {
  foundry: {
    label: "Foundry endpoint (base URL)",
    placeholder: "https://<resource>.services.ai.azure.com/anthropic/",
    hint: "From your Azure AI Foundry resource — the Anthropic-compatible endpoint ending in /anthropic/.",
  },
  chatgpt: {
    label: "Account runner URL",
    placeholder: "http://127.0.0.1:8788",
    hint: "Download account-provider-runner.mjs from this card, run it with Node, then paste the printed URL here.",
  },
  "github-copilot": {
    label: "Account runner URL",
    placeholder: "http://127.0.0.1:8788",
    hint: "Download account-provider-runner.mjs from this card, run it with Node, then paste the printed URL here.",
  },
};

const NEEDS_MODEL_IDS: Record<string, { label: string; placeholder: string; hint: string }> = {
  foundry: {
    label: "Model ids (one per line)",
    placeholder: "claude-opus-4-5",
    hint: "The Anthropic model ids your Foundry deployment exposes — enter exactly what your resource calls them.",
  },
};

const ACCOUNT_RUNNER_PROVIDERS: Record<
  string,
  { path: string; loginLabel: string; tokenLabel: string; tokenPlaceholder: string }
> = {
  chatgpt: {
    path: "chatgpt",
    loginLabel: "Log in with OpenAI",
    tokenLabel: "Runner token",
    tokenPlaceholder: "Paste the token printed by the account runner",
  },
  "github-copilot": {
    path: "github-copilot",
    loginLabel: "Log in with GitHub",
    tokenLabel: "Runner token",
    tokenPlaceholder: "Paste the token printed by the account runner",
  },
};

interface AccountRunnerLoginResponse {
  ok?: boolean;
  url?: string;
  instructions?: string;
  error?: string;
}

interface ApiKeyFormProps {
  provider: ProviderConfig;
  onSaved: () => Promise<void> | void;
  onDraftChange?: (providerId: string, patch: { enabled: boolean }) => void;
}

export function ApiKeyForm({ provider, onSaved, onDraftChange }: ApiKeyFormProps) {
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState(provider.baseURL ?? "");
  const [modelIdsText, setModelIdsText] = useState((provider.modelIds ?? []).join("\n"));
  const [defaultModel, setDefaultModel] = useState(provider.defaultModel ?? provider.models[0]?.id ?? "");
  const [enabled, setEnabled] = useState(provider.enabled);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const baseUrlField = NEEDS_BASE_URL[provider.providerId];
  const modelIdsField = NEEDS_MODEL_IDS[provider.providerId];
  const accountRunner = ACCOUNT_RUNNER_PROVIDERS[provider.providerId];

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
    setModelIdsText((provider.modelIds ?? []).join("\n"));
  }, [provider.defaultModel, provider.enabled, provider.models, provider.baseURL, provider.modelIds]);

  const save = async () => {
    setLoading(true);
    setMessage(null);
    try {
      if (baseUrlField && !baseURL.trim()) {
        throw new Error(accountRunner ? "This provider needs the account runner URL" : "This provider needs its endpoint base URL");
      }
      if (modelIdsField && parsedModelIds.length === 0) {
        throw new Error("Add at least one model id");
      }
      const nextDefault =
        modelIdsField && !parsedModelIds.includes(defaultModel)
          ? parsedModelIds[0]
          : defaultModel;
      saveProviderKey({
        providerId: provider.providerId,
        apiKey: apiKey || undefined,
        baseURL: baseUrlField ? baseURL : undefined,
        models: modelIdsField ? parsedModelIds : undefined,
        defaultModel: nextDefault,
        enabled,
      });
      setApiKey("");
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
      if (data.url) window.open(data.url, "_blank", "noopener,noreferrer");
      setMessage(
        [
          data.instructions,
          data.url ? "Opened the provider login in a new tab." : null,
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

  const handleEnabledChange = async (checked: boolean) => {
    if (!provider.hasKey) {
      setMessage(accountRunner ? "Save the runner URL and token before enabling this provider" : "Save an API key before enabling this provider");
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
  const keyLabel = accountRunner?.tokenLabel ?? "API Key";
  const keyPlaceholder = accountRunner
    ? provider.hasKey
      ? "Leave blank to keep existing runner token"
      : accountRunner.tokenPlaceholder
    : provider.hasKey
      ? "Leave blank to keep existing key"
      : "Enter API key";

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">{provider.name}</h3>
          {provider.hasKey && provider.keyHint && (
            <p className="text-xs text-muted-foreground">Saved key: {provider.keyHint}</p>
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
            This token is printed in the terminal when the account runner starts.
          </p>
        )}
      </div>

      {accountRunner && (
        <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Account runner and login</p>
          <p className="mt-1">
            Download the runner, run it with Node, paste its printed URL/token above, save, then authorize your account.
          </p>
          <p className="mt-2 rounded bg-background/70 px-2 py-1 font-mono text-xs">
            node account-provider-runner.mjs
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href="/account-provider-runner.mjs"
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
