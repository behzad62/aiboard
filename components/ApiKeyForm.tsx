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
import {
  fetchOpenRouterModelCatalog,
  type OpenRouterCatalogModel,
  refreshOpenRouterModelCapabilities,
  saveProviderKey,
  validateProvider,
} from "@/lib/client/settings-api";
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

type OpenRouterCatalogFilterId =
  | "tools"
  | "structuredOutputs"
  | "imageInput"
  | "documentInput"
  | "reasoningEffort";

const OPENROUTER_CATALOG_FILTERS: Array<{
  id: OpenRouterCatalogFilterId;
  label: string;
  match: (model: OpenRouterCatalogModel) => boolean;
}> = [
  {
    id: "tools",
    label: "Supports tools",
    match: (model) => model.supportsTools,
  },
  {
    id: "structuredOutputs",
    label: "Structured output",
    match: (model) => model.supportsStructuredOutputs,
  },
  {
    id: "imageInput",
    label: "Image input",
    match: (model) => model.supportsImageInput,
  },
  {
    id: "documentInput",
    label: "File input",
    match: (model) => model.supportsDocumentInput,
  },
  {
    id: "reasoningEffort",
    label: "Reasoning effort",
    match: (model) => model.supportsReasoningEffort,
  },
];

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
  const [openRouterCatalog, setOpenRouterCatalog] = useState<OpenRouterCatalogModel[]>([]);
  const [openRouterCatalogQuery, setOpenRouterCatalogQuery] = useState("");
  const [loadingOpenRouterCatalog, setLoadingOpenRouterCatalog] = useState(false);
  const [openRouterCatalogError, setOpenRouterCatalogError] = useState<string | null>(null);
  const [openRouterCatalogFilters, setOpenRouterCatalogFilters] = useState<
    Record<OpenRouterCatalogFilterId, boolean>
  >({
    tools: false,
    structuredOutputs: false,
    imageInput: false,
    documentInput: false,
    reasoningEffort: false,
  });
  const providerDefinition = getProviderDefinition(provider.providerId);
  const baseUrlField = providerDefinition?.baseURLField;
  const runnerTokenField = providerDefinition?.runnerTokenField;
  const modelIdsField = providerDefinition?.modelIdsField;
  const accountRunner = providerDefinition?.accountRunner;
  const runnerDownload = providerDefinition?.runnerDownload;
  const savedUserDefinedModelIds = new Set(provider.modelIds ?? []);
  const builtInModels = provider.models.filter(
    (model) => !savedUserDefinedModelIds.has(model.id)
  );
  const builtInModelIds = new Set(builtInModels.map((model) => model.id));
  const isOpenRouter = provider.providerId === "openrouter";

  const parsedModelIds = modelIdsText
    .split(/[\n,]/)
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  const parsedModelIdSet = new Set(parsedModelIds);
  const selectableModels = modelIdsField
    ? Array.from(
        new Map(
          [...builtInModels, ...parsedModelIds.map((id) => ({ id, name: id }))].map(
            (model) => [model.id, model]
          )
        ).values()
      )
    : provider.models;

  useEffect(() => {
    setDefaultModel(provider.defaultModel ?? provider.models[0]?.id ?? "");
    setEnabled(provider.enabled);
    setBaseURL(provider.baseURL ?? "");
    setRunnerToken("");
    setModelIdsText((provider.modelIds ?? []).join("\n"));
    setOpenRouterCatalog([]);
    setOpenRouterCatalogQuery("");
    setOpenRouterCatalogError(null);
    setOpenRouterCatalogFilters({
      tools: false,
      structuredOutputs: false,
      imageInput: false,
      documentInput: false,
      reasoningEffort: false,
    });
  }, [provider.defaultModel, provider.enabled, provider.models, provider.baseURL, provider.modelIds]);

  const filteredOpenRouterCatalog = openRouterCatalog
    .filter((model) => {
      const query = openRouterCatalogQuery.trim().toLowerCase();
      if (!query) return true;
      const haystack = [
        model.id,
        model.name,
        model.description ?? "",
        model.inputModalities.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    })
    .filter((model) =>
      OPENROUTER_CATALOG_FILTERS.every(
        (filter) => !openRouterCatalogFilters[filter.id] || filter.match(model)
      )
    )
    .slice(0, 40);

  const addOpenRouterModelId = (modelId: string) => {
    setModelIdsText((prev) => {
      const next = prev
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      if (!next.includes(modelId)) next.push(modelId);
      return next.join("\n");
    });
    if (!defaultModel) setDefaultModel(modelId);
  };

  const loadOpenRouterCatalog = async () => {
    setLoadingOpenRouterCatalog(true);
    setOpenRouterCatalogError(null);
    try {
      const models = await fetchOpenRouterModelCatalog();
      setOpenRouterCatalog(models);
    } catch (err) {
      setOpenRouterCatalogError(
        err instanceof Error ? err.message : "Failed to load OpenRouter models"
      );
    } finally {
      setLoadingOpenRouterCatalog(false);
    }
  };

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
      if (
        modelIdsField &&
        providerDefinition?.modelSource === "user-defined" &&
        parsedModelIds.length === 0
      ) {
        throw new Error("Add at least one model id");
      }
      if (runnerTokenField && !runnerToken.trim() && !provider.runnerTokenHint) {
        throw new Error(
          providerDefinition?.runnerTokenRequiredMessage ??
            "This provider needs the local runner token"
        );
      }
      const nextDefault = selectableModels.some((model) => model.id === defaultModel)
        ? defaultModel
        : selectableModels[0]?.id;
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
      let savedMessage = "Saved successfully";
      if (provider.providerId === "openrouter" && parsedModelIds.length > 0) {
        try {
          const sync = await refreshOpenRouterModelCapabilities(parsedModelIds);
          if (sync.synced > 0 && sync.missing.length === 0) {
            savedMessage = `Saved successfully. Synced OpenRouter capabilities for ${sync.synced} model${sync.synced === 1 ? "" : "s"}.`;
          } else if (sync.synced > 0) {
            savedMessage = `Saved successfully. Synced ${sync.synced} OpenRouter model${sync.synced === 1 ? "" : "s"}; ${sync.missing.length} id${sync.missing.length === 1 ? " was" : "s were"} not found in the live catalog.`;
          } else if (sync.missing.length > 0) {
            savedMessage = `Saved successfully, but the live OpenRouter catalog did not recognize: ${sync.missing.join(", ")}.`;
          }
        } catch (err) {
          savedMessage =
            err instanceof Error
              ? `Saved successfully, but OpenRouter capability sync failed: ${err.message}`
              : "Saved successfully, but OpenRouter capability sync failed.";
        }
      }
      setApiKey("");
      setRunnerToken("");
      setMessage(savedMessage);
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
          {isOpenRouter && (
            <div className="rounded-md border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={loadOpenRouterCatalog}
                  disabled={loadingOpenRouterCatalog}
                >
                  {loadingOpenRouterCatalog ? "Loading catalog..." : openRouterCatalog.length > 0 ? "Refresh OpenRouter catalog" : "Browse OpenRouter models"}
                </Button>
                {openRouterCatalog.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {openRouterCatalog.length.toLocaleString()} models available from the live OpenRouter catalog.
                  </span>
                )}
              </div>
              {openRouterCatalogError && (
                <p className="mt-2 text-xs text-destructive">{openRouterCatalogError}</p>
              )}
              {openRouterCatalog.length > 0 && (
                <div className="mt-3 space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor={`openrouter-search-${provider.providerId}`}>Filter live catalog</Label>
                    <Input
                      id={`openrouter-search-${provider.providerId}`}
                      value={openRouterCatalogQuery}
                      onChange={(e) => setOpenRouterCatalogQuery(e.target.value)}
                      placeholder="Search by model id, name, or modality"
                    />
                  </div>
                    <div className="flex flex-wrap gap-2">
                      {OPENROUTER_CATALOG_FILTERS.map((filter) => {
                        const active = openRouterCatalogFilters[filter.id];
                        return (
                          <Button
                            key={filter.id}
                            type="button"
                            size="sm"
                            variant={active ? "default" : "outline"}
                            onClick={() =>
                              setOpenRouterCatalogFilters((prev) => ({
                                ...prev,
                                [filter.id]: !prev[filter.id],
                              }))
                            }
                          >
                            {filter.label}
                          </Button>
                        );
                      })}
                    </div>
                  <div className="max-h-80 space-y-2 overflow-auto pr-1">
                    {filteredOpenRouterCatalog.map((model) => {
                      const isBuiltIn = builtInModelIds.has(model.id);
                      const isAdded = parsedModelIdSet.has(model.id);
                        const modalityBadges = [
                          model.supportsImageInput ? "image" : null,
                          model.supportsDocumentInput ? "file" : null,
                          model.supportsAudioInput ? "audio" : null,
                          model.supportsVideoInput ? "video" : null,
                        ].filter((value): value is string => value !== null);
                      return (
                        <div
                          key={model.id}
                          className="rounded-md border bg-background p-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-medium">{model.name}</p>
                              <p className="truncate font-mono text-xs text-muted-foreground">
                                {model.id}
                              </p>
                              {model.description && (
                                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                                  {model.description}
                                </p>
                              )}
                              <div className="mt-2 flex flex-wrap gap-1">
                                {modalityBadges.length > 0 ? (
                                  modalityBadges.map((modality) => (
                                    <Badge key={modality} variant="secondary">
                                      {modality}
                                    </Badge>
                                  ))
                                ) : (
                                  <Badge variant="secondary">text</Badge>
                                )}
                                {model.supportsTools && (
                                  <Badge variant="secondary">tools</Badge>
                                )}
                                {model.supportsStructuredOutputs && (
                                  <Badge variant="secondary">structured output</Badge>
                                )}
                                {model.supportsReasoningEffort && (
                                  <Badge variant="secondary">reasoning effort</Badge>
                                )}
                              </div>
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={isBuiltIn || isAdded}
                              onClick={() => addOpenRouterModelId(model.id)}
                            >
                              {isBuiltIn ? "Built in" : isAdded ? "Added" : "Add"}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                    {filteredOpenRouterCatalog.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        No OpenRouter models matched that filter.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
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
