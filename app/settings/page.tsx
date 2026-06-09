"use client";

import { useEffect, useState } from "react";
import { ApiKeyForm } from "@/components/ApiKeyForm";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DiscussionMode, EffortLevel } from "@/lib/db/schema";
import { getModeLabel } from "@/lib/orchestrator/config";
import type { ModelInfo } from "@/lib/providers/base";

interface ProviderConfig {
  providerId: string;
  name: string;
  models: ModelInfo[];
  hasKey: boolean;
  keyHint?: string | null;
  defaultModel?: string | null;
  enabled: boolean;
}

interface SettingsData {
  providers: ProviderConfig[];
  settings: {
    defaultEffort: EffortLevel;
    defaultMode: DiscussionMode;
    judgeModelId?: string | null;
  };
}

export default function SettingsPage() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [defaultEffort, setDefaultEffort] = useState<EffortLevel>("medium");
  const [defaultMode, setDefaultMode] = useState<DiscussionMode>("panel");
  const [judgeModelId, setJudgeModelId] = useState("");
  const [saved, setSaved] = useState(false);

  const load = () => {
    fetch("/api/keys")
      .then((r) => r.json())
      .then((d: SettingsData) => {
        setData(d);
        setDefaultEffort(d.settings.defaultEffort);
        setDefaultMode(d.settings.defaultMode);
        setJudgeModelId(d.settings.judgeModelId ?? "");
      });
  };

  useEffect(() => {
    load();
  }, []);

  const enabledModels = (data?.providers ?? [])
    .filter((p) => p.hasKey && p.enabled)
    .flatMap((p) =>
      p.models.map((m) => ({
        fullId: `${p.providerId}:${m.id}`,
        name: m.name,
      }))
    );

  const saveDefaults = async () => {
    await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "settings",
        defaultEffort,
        defaultMode,
        judgeModelId: judgeModelId || undefined,
      }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="mt-2 text-muted-foreground">
          Configure API keys for OpenAI, Anthropic, Google Gemini, and OpenRouter. Keys are encrypted locally.
        </p>
      </div>

      <div className="space-y-4">
        <h2 className="text-lg font-semibold">API Keys</h2>
        {data?.providers.map((provider) => (
          <ApiKeyForm key={provider.providerId} provider={provider} onSaved={load} />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Defaults</CardTitle>
          <CardDescription>Pre-fill options when starting a new discussion</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Default effort</Label>
            <Select
              value={defaultEffort}
              onValueChange={(v) => setDefaultEffort(v as EffortLevel)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Default mode</Label>
            <Select
              value={defaultMode}
              onValueChange={(v) => setDefaultMode(v as DiscussionMode)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="panel">{getModeLabel("panel")}</SelectItem>
                <SelectItem value="debate">{getModeLabel("debate")}</SelectItem>
                <SelectItem value="specialist">{getModeLabel("specialist")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {enabledModels.length > 0 && (
            <div className="space-y-2">
              <Label>Default judge model</Label>
              <Select value={judgeModelId} onValueChange={setJudgeModelId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select judge model" />
                </SelectTrigger>
                <SelectContent>
                  {enabledModels.map((m) => (
                    <SelectItem key={m.fullId} value={m.fullId}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <button
            type="button"
            onClick={saveDefaults}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {saved ? "Saved!" : "Save defaults"}
          </button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Security</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            API keys are encrypted at rest using AES-256-GCM. Set{" "}
            <code className="rounded bg-muted px-1">ENCRYPTION_SECRET</code> in{" "}
            <code className="rounded bg-muted px-1">.env.local</code> for production use.
          </p>
          <p>Keys are never sent back to the browser after saving.</p>
        </CardContent>
      </Card>
    </div>
  );
}
