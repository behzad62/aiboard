"use client";

import { useEffect, useState } from "react";
import { ApiKeyForm } from "@/components/ApiKeyForm";
import { PricingSettings } from "@/components/PricingSettings";
import { CustomModelsManager } from "@/components/CustomModelsManager";
import { StorageSettings } from "@/components/StorageSettings";
import { ensureReady, saveSettings } from "@/lib/client/api";
import { loadProviders } from "@/lib/client/settings-api";
import { DetailControl } from "@/components/DetailControl";
import { ReasoningControl } from "@/components/ReasoningControl";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  DiscussionMode,
  EffortLevel,
  ReasoningEffort,
  Verbosity,
} from "@/lib/db/schema";
import { getModeInfo, getModeLabel } from "@/lib/orchestrator/config";
import type { ModelInfo } from "@/lib/providers/base";
import type { ModelPricingOverride } from "@/lib/providers/pricing";
import { AlertTriangle, CheckCircle2, KeyRound } from "lucide-react";

interface ProviderConfig {
  providerId: string;
  name: string;
  models: ModelInfo[];
  hasKey: boolean;
  keyHint?: string | null;
  defaultModel?: string | null;
  enabled: boolean;
  lastValidationSucceeded?: boolean | null;
  lastValidatedAt?: string | null;
}

interface SettingsData {
  providers: ProviderConfig[];
  settings: {
    defaultEffort: EffortLevel;
    defaultMode: DiscussionMode;
    judgeModelId?: string | null;
    defaultVerbosity?: Verbosity;
    defaultStyleNote?: string;
    defaultReasoningEffort?: ReasoningEffort;
    modelPricingOverrides?: Record<string, ModelPricingOverride>;
  };
}

const MODES: DiscussionMode[] = ["panel", "debate", "specialist", "build"];

const TAB_VALUES = ["providers", "pricing", "defaults", "storage", "security"];

export default function SettingsPage() {
  const [tab, setTab] = useState("providers");
  const [data, setData] = useState<SettingsData | null>(null);
  const [draftEnabled, setDraftEnabled] = useState<Record<string, boolean>>({});
  const [defaultEffort, setDefaultEffort] = useState<EffortLevel>("medium");
  const [defaultMode, setDefaultMode] = useState<DiscussionMode>("panel");
  const [judgeModelId, setJudgeModelId] = useState("");
  const [defaultVerbosity, setDefaultVerbosity] = useState<Verbosity>("balanced");
  const [defaultStyleNote, setDefaultStyleNote] = useState("");
  const [defaultReasoningEffort, setDefaultReasoningEffort] =
    useState<ReasoningEffort>("default");
  const [saved, setSaved] = useState(false);

  const load = async () => {
    const { needsPassphrase } = await ensureReady();
    if (needsPassphrase) {
      // Nothing else is readable until the store is unlocked — jump straight
      // to the Storage tab, which holds the unlock form.
      setTab("storage");
      return;
    }
    const nextData: SettingsData = loadProviders();
    setData(nextData);
    setDraftEnabled(
      Object.fromEntries(
        nextData.providers.map((provider) => [provider.providerId, provider.enabled])
      )
    );
    setDefaultEffort(nextData.settings.defaultEffort);
    setDefaultMode(nextData.settings.defaultMode);
    setJudgeModelId(nextData.settings.judgeModelId ?? "");
    setDefaultVerbosity(nextData.settings.defaultVerbosity ?? "balanced");
    setDefaultStyleNote(nextData.settings.defaultStyleNote ?? "");
    setDefaultReasoningEffort(
      nextData.settings.defaultReasoningEffort ?? "default"
    );
  };

  useEffect(() => {
    // Deep link: /settings?tab=storage opens that tab directly (used by the
    // "storage is locked" prompts). Static export — read the query client-side.
    const requested = new URLSearchParams(window.location.search).get("tab");
    if (requested && TAB_VALUES.includes(requested)) setTab(requested);
    load().catch(() => undefined);
  }, []);

  const effectiveProviders = (data?.providers ?? []).map((provider) => ({
    ...provider,
    enabled: draftEnabled[provider.providerId] ?? provider.enabled,
  }));

  const enabledModels = effectiveProviders
    .filter((p) => p.hasKey && p.enabled)
    .flatMap((p) =>
      p.models.map((m) => ({
        fullId: `${p.providerId}:${m.id}`,
        name: m.name,
        providerName: p.name,
      }))
    );
  const validatedModels = effectiveProviders
    .filter((p) => p.hasKey && p.lastValidationSucceeded)
    .flatMap((p) =>
      p.models.map((m) => ({
        fullId: `${p.providerId}:${m.id}`,
        name: m.name,
        providerName: p.name,
      }))
    );
  const configuredProviders = effectiveProviders.filter((provider) => provider.hasKey);
  const enabledProviders = configuredProviders.filter((provider) => provider.enabled);
  const validatedProviders = configuredProviders.filter(
    (provider) => provider.lastValidationSucceeded
  );
  const setupReady = enabledModels.length >= 2;

  const handleDraftChange = (providerId: string, patch: { enabled: boolean }) => {
    setDraftEnabled((prev) => ({ ...prev, [providerId]: patch.enabled }));
  };

  const saveDefaults = async () => {
    saveSettings({
      defaultEffort,
      defaultMode,
      judgeModelId: judgeModelId || undefined,
      defaultVerbosity,
      defaultStyleNote,
      defaultReasoningEffort,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Settings
        </h1>
        <p className="mt-2 text-muted-foreground">
          Provider keys, model pricing, and the defaults used when you start a
          new discussion. Everything is stored locally on your device.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-2 sm:grid-cols-5">
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
          <TabsTrigger value="defaults">Defaults</TabsTrigger>
          <TabsTrigger value="storage">Storage</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
        </TabsList>

        {/* ── Providers ─────────────────────────────────────────── */}
        <TabsContent value="providers" className="space-y-6">
          <Card className="border-primary/20 bg-gradient-to-br from-background via-background to-primary/5 shadow-sm">
            <CardHeader className="pb-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={setupReady ? "success" : "warning"}>
                  {setupReady ? "Discussion-ready" : "Setup incomplete"}
                </Badge>
                <Badge variant="secondary">
                  Configured: {configuredProviders.length}
                </Badge>
                <Badge variant="secondary">Enabled: {enabledProviders.length}</Badge>
                <Badge variant="secondary">
                  Validated: {validatedProviders.length}
                </Badge>
              </div>
              <CardTitle className="text-xl">Provider health</CardTitle>
              <CardDescription>
                You need at least two enabled models to run a multi-model
                discussion cleanly.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border bg-background/80 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    API keys saved
                  </p>
                  <p className="mt-2 text-2xl font-semibold">
                    {configuredProviders.length}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Providers with stored credentials
                  </p>
                </div>
                <div className="rounded-lg border bg-background/80 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Enabled models
                  </p>
                  <p className="mt-2 text-2xl font-semibold">
                    {enabledModels.length}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Available on the home screen
                  </p>
                </div>
                <div className="rounded-lg border bg-background/80 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Tested models
                  </p>
                  <p className="mt-2 text-2xl font-semibold">
                    {validatedModels.length}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Models with a successful connection test
                  </p>
                </div>
              </div>

              {setupReady ? (
                <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50/80 p-4 text-sm text-emerald-950">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    The app is ready to start discussions. Enabled switches save
                    immediately; the Save button is only for key and
                    default-model changes.
                  </span>
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/80 p-4 text-sm text-amber-950">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Add and enable at least two providers, then choose a default
                    judge model in the Defaults tab.
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">API keys</h2>
            </div>
            <Tabs
              defaultValue={effectiveProviders[0]?.providerId ?? "custom"}
            >
              <TabsList className="flex h-auto flex-wrap justify-start gap-1">
                {effectiveProviders.map((provider) => (
                  <TabsTrigger key={provider.providerId} value={provider.providerId}>
                    {provider.name}
                  </TabsTrigger>
                ))}
                <TabsTrigger value="custom">Custom</TabsTrigger>
              </TabsList>

              {effectiveProviders.map((provider) => (
                <TabsContent key={provider.providerId} value={provider.providerId}>
                  <ApiKeyForm
                    provider={provider}
                    onSaved={load}
                    onDraftChange={handleDraftChange}
                  />
                </TabsContent>
              ))}

              <TabsContent value="custom">
                <CustomModelsManager onChanged={load} />
              </TabsContent>
            </Tabs>
          </div>
        </TabsContent>

        {/* ── Pricing ───────────────────────────────────────────── */}
        <TabsContent value="pricing">
          <PricingSettings
            providers={effectiveProviders}
            overrides={data?.settings.modelPricingOverrides}
            onSaved={load}
          />
        </TabsContent>

        {/* ── Defaults ──────────────────────────────────────────── */}
        <TabsContent value="defaults">
          <Card>
            <CardHeader>
              <CardTitle>Discussion defaults</CardTitle>
              <CardDescription>
                Pre-fill these options when you start a new discussion.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
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
                      {MODES.map((m) => (
                        <SelectItem key={m} value={m}>
                          {getModeLabel(m)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                <p className="font-medium">{getModeInfo(defaultMode).label}</p>
                <p className="mt-1 text-muted-foreground">
                  {getModeInfo(defaultMode).summary}
                </p>
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

              <div className="space-y-5 border-t pt-5">
                <DetailControl
                  verbosity={defaultVerbosity}
                  onVerbosityChange={setDefaultVerbosity}
                  styleNote={defaultStyleNote}
                  onStyleNoteChange={setDefaultStyleNote}
                  idPrefix="default"
                />
                <ReasoningControl
                  value={defaultReasoningEffort}
                  onChange={setDefaultReasoningEffort}
                />
              </div>

              <Button type="button" onClick={saveDefaults}>
                {saved ? "Saved!" : "Save defaults"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Storage ───────────────────────────────────────────── */}
        <TabsContent value="storage">
          <StorageSettings onChanged={load} />
        </TabsContent>

        {/* ── Security ──────────────────────────────────────────── */}
        <TabsContent value="security">
          <Card>
            <CardHeader>
              <CardTitle>Security &amp; privacy</CardTitle>
              <CardDescription>
                Where your data lives and where it goes.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                <strong className="text-foreground">
                  Everything stays on your device.
                </strong>{" "}
                Discussions, prompts, attachments, settings, and API keys are
                stored only locally — in this browser (IndexedDB) or in the
                local folder you pick on the Storage tab. This app has no
                backend: it is served as static files, and nothing you type or
                upload is sent to or stored on any server of ours.
              </p>
              <p>
                <strong className="text-foreground">
                  Prompts go only to the AI providers you configure.
                </strong>{" "}
                When you run a discussion, your topic, transcript, and
                attachments are sent over HTTPS directly from your browser to
                the providers of the models you selected (e.g. OpenAI,
                Anthropic, Google, OpenRouter, or your own local endpoint) —
                nowhere else. Each provider handles that data under its own
                privacy policy; a local model via Ollama never leaves your
                machine.
              </p>
              <p>
                <strong className="text-foreground">
                  API keys never leave your device
                </strong>{" "}
                except inside requests to their own provider. To encrypt the
                whole store at rest — keys included — set a passphrase on the
                Storage tab (PBKDF2-derived AES-256-GCM via Web Crypto; only
                you know the passphrase, and there is no recovery if you lose
                it). Recommended if your store lives in a shared or
                cloud-synced folder.
              </p>
              <p>
                <strong className="text-foreground">
                  The local runner is opt-in and visible.
                </strong>{" "}
                It binds to 127.0.0.1 on your machine, only touches the folder
                you point it at, logs every command, and asks your approval per
                command unless you chose Full access. Stop it any time with
                Ctrl+C.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
