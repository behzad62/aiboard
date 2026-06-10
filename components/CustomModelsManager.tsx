"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Plus, Server, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  addCustomModel,
  deleteCustomModel,
  listCustomModels,
  testCustomModel,
  updateCustomModelCapabilities,
} from "@/lib/client/settings-api";

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

export function CustomModelsManager({ onChanged }: { onChanged?: () => void }) {
  const [models, setModels] = useState<CustomModelView[]>([]);
  const [label, setLabel] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [capabilities, setCapabilities] = useState<ModelCaps>({ ...NO_CAPS });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
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
  };

  const canSubmit =
    label.trim().length > 0 && baseURL.trim().length > 0 && model.trim().length > 0;
  const canTest = baseURL.trim().length > 0 && model.trim().length > 0;

  const add = async () => {
    setSaving(true);
    setMessage(null);
    try {
      addCustomModel({
        label,
        baseURL,
        model,
        apiKey: apiKey || undefined,
        capabilities,
      });
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

  const test = async () => {
    setTesting(true);
    setMessage(null);
    try {
      const data = await testCustomModel({
        baseURL,
        model,
        apiKey: apiKey || undefined,
      });
      setMessage(
        data.ok
          ? `Connection OK: ${data.preview}`
          : `Test failed: ${data.error ?? "unknown error"}`
      );
    } catch {
      setMessage("Test failed: could not reach the endpoint.");
    } finally {
      setTesting(false);
    }
  };

  const remove = async (id: string) => {
    deleteCustomModel(id);
    await load();
    onChanged?.();
  };

  const toggleCapability = async (m: CustomModelView, key: keyof ModelCaps) => {
    const current = m.capabilities ?? { ...NO_CAPS };
    updateCustomModelCapabilities(m.id, { ...current, [key]: !current[key] });
    await load();
    onChanged?.();
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
        Connect any OpenAI-API-compatible endpoint — a model you run locally
        (Ollama, LM Studio) or a hosted server. For local Ollama, base URL{" "}
        <code className="rounded bg-muted px-1">http://localhost:11434/v1</code>{" "}
        and model{" "}
        <code className="rounded bg-muted px-1">gemma3:4b</code>. Use the
        Supported inputs toggles to declare which media types the model accepts.
      </div>

      {models.length > 0 && (
        <div className="space-y-2">
          {models.map((m) => (
            <div
              key={m.id}
              className="flex items-center gap-3 rounded-lg border p-3"
            >
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
                            : "text-muted-foreground hover:bg-accent"
                        )}
                      >
                        {f.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {m.hasKey && <Badge variant="secondary">key saved</Badge>}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove(m.id)}
                title="Remove custom model"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
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
              placeholder="gemma3:4b"
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
                      : "text-muted-foreground hover:bg-accent"
                  )}
                >
                  {capLabel}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Text is always supported. Enable what this endpoint accepts — image
            attachments are sent over the OpenAI-compatible API.
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
            {testing ? "Testing…" : "Test connection"}
          </Button>
        </div>
        {message && <p className="text-sm text-muted-foreground">{message}</p>}
      </div>
    </div>
  );
}
