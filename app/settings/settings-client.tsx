"use client";

import { useEffect, useState } from "react";
import { ApiKeyForm } from "@/components/ApiKeyForm";
import { OpenAIProviderSettings } from "@/components/OpenAIProviderSettings";
import { CustomModelsManager } from "@/components/CustomModelsManager";
import { CapabilityLab } from "@/components/CapabilityLab";
import { StorageSettings } from "@/components/StorageSettings";
import { ToolRuntimeSettingsPanel } from "@/components/ToolRuntimeSettingsPanel";
import { ExtensionsSettings } from "@/components/extensions/ExtensionsSettings";
import { ensureReady, saveSettings } from "@/lib/client/api";
import { loadProviders } from "@/lib/client/settings-api";
import { loadHome, type HomeState } from "@/lib/client/home-client";
import { useHomeState } from "@/lib/client/use-home-state";
import { onHomeMirrorChange } from "@/lib/client/store";
import { RunnerSetup } from "@/components/RunnerSetup";
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
  ToolRuntimeSettings,
} from "@/lib/db/schema";
import { getModeInfo, getModeLabel } from "@/lib/orchestrator/config";
import type { ModelInfo } from "@/lib/providers/base";
import type { ModelCapabilityProbeProfile } from "@/lib/providers/capability-probes";
import type { ModelContextOverrides } from "@/lib/providers/model-context";
import { AlertTriangle, CheckCircle2, KeyRound } from "lucide-react";

interface ProviderConfig {
  providerId: string;
  name: string;
  models: ModelInfo[];
  enabledModelIds?: string[];
  hasKey: boolean;
  keyHint?: string | null;
  baseURL?: string | null;
  modelIds?: string[];
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
    modelContextOverrides?: ModelContextOverrides;
    modelCapabilityProfiles?: Record<string, ModelCapabilityProbeProfile>;
    openAIConnectionMode?: "api" | "subscription";
    toolRuntime?: ToolRuntimeSettings;
  };
}

const MODES: DiscussionMode[] = ["chat", "panel", "debate", "specialist", "build"];

const TAB_VALUES = ["providers", "tools", "extensions", "capability-lab", "defaults", "storage", "security"];

/**
 * Providers, Tools, Capability Lab and Defaults are saved in the AIBoard home, so
 * they need a connected, home-capable AI Board (plan §6.1). Storage is about this
 * browser's history and works without one.
 */
function HomeGate({ home, children }: { home: HomeState; children: React.ReactNode }) {
  if (home.status === "ready") return <>{children}</>;
  if (home.status === "idle" || home.status === "loading") {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground" role="status">
          Loading your settings from AI Board…
        </CardContent>
      </Card>
    );
  }
  const message = home.status === "not_connected"
    ? "AI Board isn't connected. Run `aiboard` in a terminal, in a project folder (not your home folder), and open the link it prints."
    : home.message;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{home.status === "update_required" ? "Update AI Board" : home.status === "not_connected" ? "Connect AI Board" : "Settings unavailable"}</CardTitle>
        <CardDescription role="alert">{message}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {home.status === "not_connected" && <RunnerSetup />}
        <Button type="button" variant="outline" onClick={() => void loadHome()}>Try again</Button>
      </CardContent>
    </Card>
  );
}

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
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const home = useHomeState();

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
    if (requested === "pricing") setTab("providers");
    else if (requested && TAB_VALUES.includes(requested)) setTab(requested);
    load().catch(() => undefined);
    // The page re-reads the home whenever its tab is shown again, and redraws when
    // the home's mirror changes (a save here, or another tab's, after a re-read).
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadHome();
    };
    document.addEventListener("visibilitychange", onVisible);
    const stopMirror = onHomeMirrorChange(() => {
      load().catch(() => undefined);
    });
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      stopMirror();
    };
  }, []);

  const effectiveProviders = (data?.providers ?? []).map((provider) => ({
    ...provider,
    enabled: draftEnabled[provider.providerId] ?? provider.enabled,
  }));
  const providerTabs = effectiveProviders.filter((provider) => provider.providerId !== "chatgpt");
  const openAIApiProvider = effectiveProviders.find((provider) => provider.providerId === "openai");
  const chatgptProvider = effectiveProviders.find((provider) => provider.providerId === "chatgpt");

  const enabledModels = effectiveProviders
    .filter((p) => p.hasKey && p.enabled)
    .flatMap((p) => {
      const enabledSet =
        p.enabledModelIds !== undefined ? new Set(p.enabledModelIds) : null;
      const visibleModels = enabledSet
        ? p.models.filter((model) => enabledSet.has(model.id))
        : p.models;
      return visibleModels.map((m) => ({
        fullId: `${p.providerId}:${m.id}`,
        name: m.name,
        providerName: p.name,
      }));
    });
  const validatedModels = effectiveProviders
    .filter((p) => p.hasKey && p.lastValidationSucceeded)
    .flatMap((p) => {
      const enabledSet =
        p.enabledModelIds !== undefined ? new Set(p.enabledModelIds) : null;
      const visibleModels = enabledSet
        ? p.models.filter((model) => enabledSet.has(model.id))
        : p.models;
      return visibleModels.map((m) => ({
        fullId: `${p.providerId}:${m.id}`,
        name: m.name,
        providerName: p.name,
      }));
    });
  const configuredProviders = effectiveProviders.filter((provider) => provider.hasKey);
  const enabledProviders = configuredProviders.filter((provider) => provider.enabled);
  const validatedProviders = configuredProviders.filter(
    (provider) => provider.lastValidationSucceeded
  );
  const setupReady = enabledModels.length >= 2;

  const handleDraftChange = (providerId: string, patch: { enabled: boolean }) => {
    setDraftEnabled((prev) => ({ ...prev, [providerId]: patch.enabled }));
  };

  // The six defaults are one batch; a failed save shows the error and reverts the form.
  const saveDefaults = async () => {
    setDefaultsError(null);
    try {
      await saveSettings({
        defaultEffort,
        defaultMode,
        judgeModelId: judgeModelId || null,
        defaultVerbosity,
        defaultStyleNote,
        defaultReasoningEffort,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      setDefaultsError(error instanceof Error ? error.message : "Could not save the defaults");
    }
    await load();
  };

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Settings
        </h1>
        <p className="mt-2 text-muted-foreground">
          Provider keys, tools, pricing, and the defaults for new chats and
          builds, saved in your AIBoard home on this computer.
        </p>
        {home.status === "ready" && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="home-path">
            Saved in <code className="rounded bg-muted px-1">{home.view.home}</code>
          </p>
        )}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-2 sm:grid-cols-4 lg:grid-cols-7">
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="extensions">Extensions</TabsTrigger>
          <TabsTrigger value="capability-lab">Capability Lab</TabsTrigger>
          <TabsTrigger value="defaults">Defaults</TabsTrigger>
          <TabsTrigger value="storage">Storage</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
        </TabsList>

        {/* ── Providers ─────────────────────────────────────────── */}
        <TabsContent value="providers" className="space-y-6">
          <HomeGate home={home}>
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
                A build needs one enabled model; a chat compares two or more.
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
                <div className="flex items-start gap-2 rounded-lg border border-success/40 bg-success-soft p-4 text-sm text-success">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Ready for chats and builds. Enabled switches save
                    immediately; use Save for credentials, model selections,
                    and model details.
                  </span>
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-soft p-4 text-sm text-warning">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Add and enable models from at least one provider (two models
                    for chat), then pick a default judge in the Defaults tab.
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
              defaultValue="openai"
            >
              <TabsList className="flex h-auto flex-wrap justify-start gap-1">
                {providerTabs.map((provider) => (
                  <TabsTrigger key={provider.providerId} value={provider.providerId}>
                    {provider.providerId === "openai" ? "OpenAI" : provider.name}
                  </TabsTrigger>
                ))}
                <TabsTrigger value="custom">Custom</TabsTrigger>
              </TabsList>

              {providerTabs.map((provider) => (
                <TabsContent key={provider.providerId} value={provider.providerId}>
                  {provider.providerId === "openai" && openAIApiProvider && chatgptProvider ? (
                    <OpenAIProviderSettings
                      apiProvider={openAIApiProvider}
                      chatgptProvider={chatgptProvider}
                      onSaved={load}
                      onDraftChange={handleDraftChange}
                      preferredMode={data?.settings.openAIConnectionMode}
                    />
                  ) : (
                    <ApiKeyForm
                      provider={provider}
                      onSaved={load}
                      onDraftChange={handleDraftChange}
                    />
                  )}
                </TabsContent>
              ))}

              <TabsContent value="custom">
                <CustomModelsManager
                  contextOverrides={data?.settings.modelContextOverrides}
                  onChanged={load}
                />
              </TabsContent>
            </Tabs>
          </div>
          </HomeGate>
        </TabsContent>

        {/* ── Tools ─────────────────────────────────────────────── */}
        <TabsContent value="tools">
          <HomeGate home={home}>
            <ToolRuntimeSettingsPanel
              settings={data?.settings.toolRuntime}
              onChanged={load}
              onOpenExtensions={() => setTab("extensions")}
            />
          </HomeGate>
        </TabsContent>

        {/* ── Extensions ────────────────────────────────────────── */}
        <TabsContent value="extensions">
          <ExtensionsSettings settings={data?.settings.toolRuntime} onChanged={load} onOpenTools={() => setTab("tools")} />
        </TabsContent>

        {/* ── Capability Lab ───────────────────────────────────── */}
        <TabsContent value="capability-lab">
          <HomeGate home={home}>
            <CapabilityLab
              providers={effectiveProviders}
              capabilityProfiles={data?.settings.modelCapabilityProfiles}
              onChanged={load}
            />
          </HomeGate>
        </TabsContent>

        {/* ── Defaults ──────────────────────────────────────────── */}
        <TabsContent value="defaults">
          <HomeGate home={home}>
          <Card>
            <CardHeader>
              <CardTitle>Chat defaults</CardTitle>
              <CardDescription>
                Pre-fill these options when you start a new chat.
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

              <Button type="button" onClick={() => void saveDefaults()}>
                {saved ? "Saved!" : "Save defaults"}
              </Button>
              {defaultsError && <p className="text-sm text-destructive" role="alert">{defaultsError}</p>}
            </CardContent>
          </Card>
          </HomeGate>
        </TabsContent>

        {/* ── Storage ───────────────────────────────────────────── */}
        <TabsContent value="storage">
          <StorageSettings onChanged={load} />
        </TabsContent>

        {/* ── Security: where your settings and keys live (plan §6.1, OD-27) ── */}
        <TabsContent value="security">
          <Card>
            <CardHeader>
              <CardTitle>Where your settings and keys live</CardTitle>
              <CardDescription>
                AI Board is a tool on your computer; this page is its window.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                <strong className="text-foreground">Settings and keys: your AIBoard home.</strong>{" "}
                {home.status === "ready" ? (
                  <>Saved in <code className="rounded bg-muted px-1">{home.view.home}</code>.</>
                ) : (
                  <>Saved in the AIBoard home folder, <code className="rounded bg-muted px-1">~/.aiboard</code> (or <code className="rounded bg-muted px-1">AIBOARD_HOME</code>), once AI Board is connected.</>
                )}{" "}
                <code className="rounded bg-muted px-1">config.json</code> holds settings and no secret. Keys are encrypted in{" "}
                <code className="rounded bg-muted px-1">credentials.json</code> with a key kept outside the home
                {home.status === "ready" && home.view.keyPath ? <> (<code className="rounded bg-muted px-1">{home.view.keyPath}</code>)</> : null}
                , so a copied or synced home never carries usable keys. The same settings serve every browser and every
                project, and <code className="rounded bg-muted px-1">aiboard keys</code> and{" "}
                <code className="rounded bg-muted px-1">aiboard config</code> in a terminal.
              </p>
              <p>
                <strong className="text-foreground">Who can read them.</strong> Any program running as your user can read
                the home and its key, as with other command-line tools that keep keys in your user folder. There is no
                passphrase, so tasks can run unattended. Commands that a task runs at an unconfined access level can read
                them too: choose a confined level for work you don&apos;t trust.
              </p>
              <p>
                <strong className="text-foreground">Where prompts go.</strong> Model calls go from this page through AI
                Board on your computer, which adds the key and forwards them to the provider you picked. This site has no
                backend and never receives your keys or prompts.
              </p>
              <p>
                <strong className="text-foreground">This browser&apos;s history.</strong> Chats, builds and benchmark results
                stay in this browser (IndexedDB) or in the folder you pick on the Storage tab.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
