"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ModelContextEditor } from "@/components/ModelContextEditor";
import { ModelPricingEditor } from "@/components/ModelPricingEditor";
import { getModelPricing } from "@/lib/providers/pricing";
import { getUserSettings } from "@/lib/client/store";
import { ProviderCapabilityTable } from "@/components/ProviderCapabilityTable";
import { Plus, Server, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  addCustomModel,
  deleteCustomModel,
  listCustomModels,
  testSavedCustomModel,
  updateCustomModelCapabilities,
  updateCustomModelReasoning,
  updateCustomModelToolConfiguration,
} from "@/lib/client/settings-api";
import { ensureReady } from "@/lib/client/api";
import {
  buildCustomToolCapabilityOverrides,
  CUSTOM_DECLARABLE_TOOL_CAPABILITIES,
  type CustomDeclarableToolCapabilityId,
} from "@/lib/providers/custom-capabilities";
import type { ReasoningEffort } from "@/lib/db/schema";
import type {
  ProviderTransportId,
  ToolCapabilityDescriptor,
} from "@/lib/providers/tool-capabilities";
import { resolveProviderCapabilityProfile } from "@/lib/providers/capability-resolution";
import { capabilityStatusRows } from "@/lib/providers/capability-status";
import {
  resolveModelContextProfile,
  type ModelContextOverrides,
} from "@/lib/providers/model-context";

interface ModelCaps {
  image: boolean;
  document: boolean;
  audio: boolean;
  video: boolean;
}

interface CustomModelView {
  id: string;
  label: string;
  baseURL: string;
  model: string;
  hasKey: boolean;
  capabilities?: ModelCaps;
  toolCapabilityOverrides?: ToolCapabilityDescriptor[];
  compatibleTransports?: ProviderTransportId[];
  reasoningEffort?: ReasoningEffort;
  lastValidationSucceeded?: boolean | null;
  lastValidatedAt?: string | null;
  createdAt?: string;
}

const CAPABILITY_FIELDS: { key: keyof ModelCaps; label: string }[] = [
  { key: "image", label: "Image" },
  { key: "document", label: "Document" },
  { key: "audio", label: "Audio" },
  { key: "video", label: "Video" },
];

const NO_CAPS: ModelCaps = {
  image: false,
  document: false,
  audio: false,
  video: false,
};
const CUSTOM_PROVIDER_ID = "custom";
const CUSTOM_REASONING: Array<{id: ReasoningEffort; label: string}> = [
  {id: "default", label: "Endpoint default"},
  {id: "none", label: "Off"},
  {id: "low", label: "Low"},
  {id: "medium", label: "Medium"},
  {id: "high", label: "High"},
];
const TOOL_LABELS: Record<CustomDeclarableToolCapabilityId, string> = {
  function_calling: "Function calling",
  web_search: "Web search",
  file_search: "File search",
  remote_mcp: "Remote MCP",
  tool_search: "Tool search",
  code_execution: "Code execution",
  shell: "Hosted shell",
  computer_use: "Computer use",
  image_generation: "Image generation",
};
const TRANSPORT_OPTIONS: Array<{ id: ProviderTransportId; label: string }> = [
  { id: "chat_completions", label: "Chat Completions" },
  { id: "responses", label: "Responses API" },
];

export function CustomModelsManager({
  contextOverrides,
  onChanged,
}: {
  contextOverrides?: ModelContextOverrides;
  onChanged?: () => void;
}) {
  const [models, setModels] = useState<CustomModelView[]>([]);
  const [label, setLabel] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [capabilities, setCapabilities] = useState<ModelCaps>({ ...NO_CAPS });
  const [declaredTools, setDeclaredTools] = useState<CustomDeclarableToolCapabilityId[]>([]);
  const [compatibleTransports, setCompatibleTransports] = useState<ProviderTransportId[]>(["chat_completions"]);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("default");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  const load = async () => {
    await ensureReady();
    setModels(listCustomModels());
  };

  useEffect(() => {
    load().catch(() => undefined);
  }, []);

  const reset = () => {
    setLabel("");
    setBaseURL("");
    setModel("");
    setApiKey("");
    setCapabilities({ ...NO_CAPS });
    setDeclaredTools([]);
    setCompatibleTransports(["chat_completions"]);
    setReasoningEffort("default");
  };

  const canSubmit =
    label.trim().length > 0 &&
    baseURL.trim().length > 0 &&
    model.trim().length > 0;
  const canTest = baseURL.trim().length > 0 && model.trim().length > 0;

  /** Saves the form to the AIBoard home (the key in the same batch) and clears it, key included. */
  const saveForm = () =>
    addCustomModel({
      label: label.trim() || model.trim(),
      baseURL,
      model,
      apiKey: apiKey || undefined,
      capabilities,
      toolCapabilityOverrides: buildCustomToolCapabilityOverrides(declaredTools),
      compatibleTransports,
      reasoningEffort,
    });

  const add = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await saveForm();
      setMessage("Custom model added.");
      reset();
      await load();
      onChanged?.();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to add model");
    } finally {
      setSaving(false);
    }
  };

  // Testing an unsaved endpoint saves it first: the Runner's model proxy uses only
  // what the AIBoard home saved (plan §9 "Testing a key"). A failed test leaves it
  // saved and marked not validated, so it can be corrected or removed below.
  const test = async () => {
    setTesting(true);
    setMessage(null);
    try {
      const saved = await saveForm();
      reset();
      const data = await testSavedCustomModel(saved.id);
      setMessage(
        data.valid
          ? `Saved and tested${data.usedImage ? " with a test image" : ""}: ${data.preview ?? "Response received"}`
          : `Saved, but the test failed: ${data.error ?? "unknown error"}. Correct it or remove it below.`,
      );
      await load();
      onChanged?.();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Test failed: could not reach the endpoint.");
    } finally {
      setTesting(false);
    }
  };

  /** Runs one saved-model change; a failed save shows its error and the list re-reads the home. */
  const mutate = async (change: () => Promise<void>) => {
    try {
      await change();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not save the change");
    }
    await load();
    onChanged?.();
  };

  const testSaved = async (id: string) => {
    setTestingId(id);
    setTestResults((prev) => ({ ...prev, [id]: "Testing…" }));
    try {
      const data = await testSavedCustomModel(id);
      setTestResults((prev) => ({
        ...prev,
        [id]: data.valid
          ? `Model test successful${data.usedImage ? " with test image" : ""}: ${data.preview ?? "Response received"}`
          : `Test failed: ${data.error ?? "unknown error"}`,
      }));
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [id]: "Test failed: could not reach the endpoint.",
      }));
    } finally {
      setTestingId(null);
      await load(); // refresh the Connection verified / failed badge
      onChanged?.();
    }
  };

  const changeSavedReasoning = (m: CustomModelView, effort: ReasoningEffort) =>
    mutate(() => updateCustomModelReasoning(m.id, effort));
  const remove = (id: string) => mutate(() => deleteCustomModel(id));

  const toggleCapability = (m: CustomModelView, key: keyof ModelCaps) => {
    const current = m.capabilities ?? { ...NO_CAPS };
    return mutate(() => updateCustomModelCapabilities(m.id, { ...current, [key]: !current[key] }));
  };

  const declaredToolIds = (m: CustomModelView) =>
    new Set(
      (m.toolCapabilityOverrides ?? [])
        .map((item) => item.id)
        .filter((id): id is CustomDeclarableToolCapabilityId =>
          CUSTOM_DECLARABLE_TOOL_CAPABILITIES.includes(
            id as CustomDeclarableToolCapabilityId,
          ),
        ),
    );

  const toggleSavedToolCapability = async (
    m: CustomModelView,
    id: CustomDeclarableToolCapabilityId,
  ) => {
    const current = declaredToolIds(m);
    if (current.has(id)) current.delete(id);
    else current.add(id);
    await mutate(() => updateCustomModelToolConfiguration(m.id, {
      toolCapabilityOverrides: buildCustomToolCapabilityOverrides([...current]),
      compatibleTransports: m.compatibleTransports ?? ["chat_completions"],
    }));
  };

  const nextTransportSelection = (
    current: ProviderTransportId[],
    id: ProviderTransportId,
  ): ProviderTransportId[] => {
    if (current.includes(id)) {
      return current.length === 1 ? current : current.filter((item) => item !== id);
    }
    return [...current, id];
  };

  const toggleSavedTransport = async (
    m: CustomModelView,
    id: ProviderTransportId,
  ) => {
    await mutate(() => updateCustomModelToolConfiguration(m.id, {
      toolCapabilityOverrides: m.toolCapabilityOverrides ?? [],
      compatibleTransports: nextTransportSelection(
        m.compatibleTransports ?? ["chat_completions"],
        id,
      ),
    }));
  };
  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
        Connect any OpenAI-API-compatible endpoint — a model you run locally
        (Ollama, LM Studio) or a hosted server. For local Ollama, base URL{" "}
        <code className="rounded bg-muted px-1">http://localhost:11434/v1</code>{" "}
        and model <code className="rounded bg-muted px-1">gemma4:12b</code>.
        Ollama must also allow requests from the browser: set{" "}
        <code className="rounded bg-muted px-1">OLLAMA_ORIGINS=*</code> before
        starting it (PowerShell:{" "}
        <code className="rounded bg-muted px-1">
          $env:OLLAMA_ORIGINS=&quot;*&quot;; ollama serve
        </code>
        ), otherwise the browser blocks the connection with a CORS error. Use
        the Supported inputs toggles to declare which media types the model
        accepts. If you just want to use a newer OpenRouter model, add its id on
        the OpenRouter tab instead of creating a custom endpoint here.
      </div>

      {models.length > 0 && (
        <div className="space-y-2">
          {models.map((m) => {
            const fullModelId = `${CUSTOM_PROVIDER_ID}:${m.id}`;
            const contextProfile = resolveModelContextProfile(
              m.id,
              CUSTOM_PROVIDER_ID,
              contextOverrides,
            );
            const resolvedCapabilityRows = capabilityStatusRows(
              resolveProviderCapabilityProfile({
                providerId: CUSTOM_PROVIDER_ID,
                modelId: m.id,
                customOverrides: m.toolCapabilityOverrides ?? [],
              }),
              { allowedTransports: m.compatibleTransports ?? ["chat_completions"] },
            );

            return (
              <div key={m.id} className="space-y-3 rounded-lg border p-3">
                <div className="flex items-center gap-3">
                  <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{m.label}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {m.model} · {m.baseURL}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {CAPABILITY_FIELDS.map((f) => {
                        const on = m.capabilities?.[f.key] ?? false;
                        return (
                          <button
                            key={f.key}
                            type="button"
                            aria-pressed={on}
                            onClick={() => toggleCapability(m, f.key)}
                            title={`Toggle ${f.label} support`}
                            className={cn(
                              "rounded-full border px-2 py-0.5 text-[0.65rem] font-medium transition-colors",
                              on
                                ? "border-primary bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:bg-accent",
                            )}
                          >
                            {f.label}
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-2 space-y-1">
                      <p className="text-[0.65rem] font-medium text-muted-foreground">
                        Declared tool support
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {CUSTOM_DECLARABLE_TOOL_CAPABILITIES.map((id) => {
                          const on = declaredToolIds(m).has(id);
                          return (
                            <button
                              key={id}
                              type="button"
                              aria-pressed={on}
                              onClick={() => toggleSavedToolCapability(m, id)}
                              className={cn(
                                "rounded-full border px-2 py-0.5 text-[0.65rem] font-medium transition-colors",
                                on
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "text-muted-foreground hover:bg-accent",
                              )}
                            >
                              {TOOL_LABELS[id]}
                            </button>
                          );
                        })}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {TRANSPORT_OPTIONS.map(({ id, label: transportLabel }) => {
                          const on = (m.compatibleTransports ?? ["chat_completions"]).includes(id);
                          return (
                            <button
                              key={id}
                              type="button"
                              aria-pressed={on}
                              onClick={() => toggleSavedTransport(m, id)}
                              className={cn(
                                "rounded-full border px-2 py-0.5 text-[0.65rem] font-medium transition-colors",
                                on
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "text-muted-foreground hover:bg-accent",
                              )}
                            >
                              {transportLabel}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                  <Badge
                    variant={
                      m.lastValidationSucceeded == null
                        ? "secondary"
                        : m.lastValidationSucceeded
                          ? "success"
                          : "destructive"
                    }
                  >
                    {m.lastValidationSucceeded == null
                      ? "Not tested"
                      : m.lastValidationSucceeded
                        ? "Connection verified"
                        : "Last test failed"}
                  </Badge>
                  {m.hasKey && <Badge variant="secondary">key saved</Badge>}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => testSaved(m.id)}
                    disabled={testingId === m.id}
                  >
                    {testingId === m.id ? "Testing..." : "Test connection"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => remove(m.id)}
                    title="Remove custom model"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                {testResults[m.id] && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {testResults[m.id]}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  <label htmlFor={`custom-reasoning-${m.id}`} className="font-medium">Reasoning effort</label>
                  <select
                    id={`custom-reasoning-${m.id}`}
                    aria-label={`Reasoning effort for ${m.label}`}
                    value={m.reasoningEffort ?? "default"}
                    onChange={(event) => changeSavedReasoning(m, event.target.value as ReasoningEffort)}
                    className="rounded-md border bg-background px-2 py-1"
                  >
                    {CUSTOM_REASONING.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                  <span className="text-muted-foreground">Used when a benchmark or chat does not select an explicit effort. Retest after changing.</span>
                </div>
                <ProviderCapabilityTable
                  rows={resolvedCapabilityRows}
                  title="Declared tool support & readiness"
                />
                <details className="mt-3 rounded-md border p-3 text-sm">
                  <summary className="cursor-pointer font-medium">Pricing</summary>
                  <div className="mt-3">
                    <ModelPricingEditor fullModelId={fullModelId}
                      pricing={getModelPricing(fullModelId, getUserSettings().modelPricingOverrides, getUserSettings().discoveredModelMetadata)}
                      onSaved={async () => { await load(); onChanged?.(); }} title="Pricing" />
                  </div>
                </details>
                <ModelContextEditor
                  fullModelId={fullModelId}
                  profile={contextProfile}
                  override={contextOverrides?.[fullModelId]}
                  onSaved={async () => {
                    await load();
                    onChanged?.();
                  }}
                />
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-3 rounded-lg border p-4">
        <p className="font-medium">Add a custom model</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="custom-label">Display name</Label>
            <Input
              id="custom-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Gemma 4 (local)"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="custom-model">Model id</Label>
            <Input
              id="custom-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gemma4:12b"
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="custom-baseurl">Base URL</Label>
          <Input
            id="custom-baseurl"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder="http://localhost:11434/v1"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="custom-key">API key (optional)</Label>
          <Input
            id="custom-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Leave blank for keyless local servers"
          />
        </div>

        <div className="space-y-1.5">
          <Label>Supported inputs</Label>
          <div className="flex flex-wrap gap-2">
            {CAPABILITY_FIELDS.map(({ key, label: capLabel }) => {
              const on = capabilities[key];
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setCapabilities((c) => ({ ...c, [key]: !c[key] }))
                  }
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    on
                      ? "border-primary bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  {capLabel}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Text is always supported. Enable what this endpoint accepts — image
            and document attachments are sent over the OpenAI-compatible API.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="custom-reasoning-new">Default reasoning effort</Label>
          <select
            id="custom-reasoning-new"
            value={reasoningEffort}
            onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            {CUSTOM_REASONING.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">Auto leaves the endpoint in charge; Off, Low, Medium and High explicitly request the selected reasoning mode. Actual support depends on the endpoint. ToolBench can override this per run.</p>
        </div>
        <div className="space-y-1.5">
          <Label>Declared tool support</Label>
          <p className="text-xs text-muted-foreground">
            Tool support is not auto-detected. Enable a tool only when this
            endpoint actually implements it; these switches are your explicit
            declaration of endpoint support.
          </p>
          <div className="flex flex-wrap gap-2">
            {CUSTOM_DECLARABLE_TOOL_CAPABILITIES.map((id) => {
              const on = declaredTools.includes(id);
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setDeclaredTools((current) =>
                      current.includes(id)
                        ? current.filter((item) => item !== id)
                        : [...current, id],
                    )
                  }
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    on
                      ? "border-primary bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  {TOOL_LABELS[id]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Compatible API transports</Label>
          <div className="flex flex-wrap gap-2">
            {TRANSPORT_OPTIONS.map(({ id, label: transportLabel }) => {
              const on = compatibleTransports.includes(id);
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setCompatibleTransports((current) =>
                      nextTransportSelection(current, id),
                    )
                  }
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    on
                      ? "border-primary bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  {transportLabel}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Chat Completions is the conservative default. Declare Responses API
            only if this endpoint implements the OpenAI-compatible Responses path.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={add} disabled={!canSubmit || saving}>
            <Plus className="mr-1 h-4 w-4" />
            {saving ? "Adding…" : "Add model"}
          </Button>
          <Button
            variant="outline"
            onClick={test}
            disabled={!canTest || testing}
          >
            {testing ? "Testing…" : "Save and test"}
          </Button>
        </div>
        {message && <p className="text-sm text-muted-foreground">{message}</p>}
      </div>
    </div>
  );
}
