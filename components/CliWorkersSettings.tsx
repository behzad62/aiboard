"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, Plus, RefreshCw, Terminal, X, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  CLI_ATTEMPT_MINUTES,
  CLI_TEST_OUTCOMES,
  CLI_WORKER_CONSENT_NOTE,
  CLI_WORKER_IDS,
  CLI_WORKERS_UPDATE_MESSAGE,
  cliResetText,
  cliWorkerHealth,
  cliWorkerName,
  isCliArgumentValue,
  runCliWorkerTest,
  type CliLastTest,
  type CliWorkerCheckView,
  type CliWorkerHealth,
  type CliWorkerModelChoiceView,
} from "@/lib/client/cli-workers";
import {
  cliWorkerOps,
  homeSupportsCliWorkers,
  loadHome,
  saveHome,
  type CliWorkerProviderId,
  type HomeCliWorkerEntry,
  type HomeCliWorkerPatch,
} from "@/lib/client/home-client";
import { modelProxyClient } from "@/lib/client/model-proxy-client";
import { loadCliWorkerChecks, useCliWorkerChecks } from "@/lib/client/use-cli-worker-checks";
import { useHomeState } from "@/lib/client/use-home-state";
import { cn } from "@/lib/utils";

const DEFAULT_KEY = "__cli_default__";
const keyOf = (id: string | null) => id ?? DEFAULT_KEY;
const idOf = (key: string) => (key === DEFAULT_KEY ? null : key);

export function healthBadgeVariant(health: CliWorkerHealth): "success" | "warning" | "destructive" | "secondary" {
  if (health.state === "ready") return "success";
  if (health.state === "refused") return "destructive";
  if (health.state === "unavailable") return "warning";
  return "secondary";
}

/** The time a reset is counted from: the mount time, so a render stays pure. */
function useNow(given: number | undefined): number {
  const [mountedAt] = useState(() => Date.now());
  return given ?? mountedAt;
}

function CheckFact({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) {
  const Icon = ok === null ? CircleHelp : ok ? CheckCircle2 : XCircle;
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", ok === null ? "text-muted-foreground" : ok ? "text-success" : "text-destructive")} aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {detail && <p className="break-words text-xs text-muted-foreground">{detail}</p>}
      </div>
    </div>
  );
}

/** The free checks of one CLI (§3.2): installed, logged in, models, and agy's stated usage. No account field. */
export function CliWorkerFreeChecks({ check, now: givenNow }: { check: CliWorkerCheckView | undefined; now?: number }) {
  const now = useNow(givenNow);
  if (!check) return <p className="text-xs text-muted-foreground">Not checked yet.</p>;
  if (check.status === "refused") return null;
  const installed = check.code === "not_installed" ? false : check.executable ? true : null;
  const login = check.login === "logged_in" ? true : check.login === "logged_out" ? false : null;
  const listed = check.models.filter((model) => model.id !== null).length;
  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-3">
        <CheckFact
          ok={installed}
          label={installed === false ? "Not installed" : installed ? `Installed${check.version ? ` · ${check.version}` : ""}` : "Install not known"}
          {...(check.executable
            ? { detail: `${check.executable.form === "cmd" ? ".cmd shim" : check.executable.form === "exe" ? ".exe" : "program"}, ${check.executable.source === "home" ? "path set here" : "found on PATH"}` }
            : {})}
        />
        <CheckFact ok={login} label={login ? "Logged in" : login === false ? "Not logged in" : "Login not known"} />
        <CheckFact
          ok={listed > 0 ? true : null}
          label={listed > 0 ? `${listed} model${listed === 1 ? "" : "s"} listed` : "No models listed"}
          {...(check.modelsSource === "catalog" ? { detail: "From AI Board's catalog" } : check.modelsNote ? { detail: check.modelsNote } : {})}
        />
      </div>
      {check.quota && check.quota.length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground" aria-label={`${check.displayName}'s stated usage`}>
          {check.quota.map((group) => {
            const lowest = group.buckets.reduce<typeof group.buckets[number] | null>(
              (low, bucket) => (!low || bucket.remainingFraction < low.remainingFraction ? bucket : low), null);
            if (!lowest) return null;
            const reset = lowest.remainingFraction <= 0 ? cliResetText(lowest.resetsAt, now) : null;
            return (
              <li key={group.name}>
                <span className="font-medium text-foreground">{group.name}</span>: {Math.round(Math.max(0, lowest.remainingFraction) * 100)}% left
                {lowest.window ? ` (${lowest.window})` : ""}{reset ? ` · ${reset}` : ""}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The last Test (§3.4): its outcome, the reason in words, the reset time the CLI stated, and its message. */
export function CliWorkerLastTest({ lastTest, now: givenNow }: { lastTest: CliLastTest | undefined; now?: number }) {
  const now = useNow(givenNow);
  if (!lastTest) return <p className="text-xs text-muted-foreground">Not tested yet.</p>;
  const outcome = CLI_TEST_OUTCOMES[lastTest.outcome];
  const reset = cliResetText(lastTest.resetsAt, now);
  const at = new Date(lastTest.at);
  return (
    <div className="space-y-1 text-sm" role="status">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={outcome.tone}>{outcome.label}</Badge>
        <span className="text-xs text-muted-foreground">
          Tested {Number.isFinite(at.getTime()) ? at.toLocaleString() : lastTest.at}
          {lastTest.cliVersion !== "unknown" ? ` · ${lastTest.cliVersion}` : ""}
          {` · ${lastTest.modelId ?? "CLI default"}`}
        </span>
      </div>
      <p className="text-xs">{outcome.reason}</p>
      {reset && <p className="text-xs font-medium">{reset}</p>}
      {lastTest.message && lastTest.outcome !== "passed" && (
        <p className="break-words rounded-md bg-muted/60 px-2 py-1 font-mono text-xs">{lastTest.message}</p>
      )}
    </div>
  );
}

export interface CliWorkerPanelProps {
  providerId: CliWorkerProviderId;
  entry: HomeCliWorkerEntry | undefined;
  check: CliWorkerCheckView | undefined;
  /** False while the home can't take CLI worker settings (an older Runner): the panel is read-only. */
  canSave: boolean;
  /** False when the Runner has no Test route (a Runner from before CW3). */
  canTest?: boolean;
  onSave: (patch: HomeCliWorkerPatch) => Promise<void>;
  onTest: (request: { model: string | null; reasoningEffort?: string }) => Promise<string | null>;
  now?: number;
}

/** One CLI in Settings > CLI workers. Every change is one awaited home save through `onSave`. */
export function CliWorkerPanel({ providerId, entry, check, canSave, canTest = true, onSave, onTest, now }: CliWorkerPanelProps) {
  const name = cliWorkerName(providerId);
  const health = cliWorkerHealth(check);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testNote, setTestNote] = useState<string | null>(null);
  const [askingConsent, setAskingConsent] = useState(false);
  const [draftModel, setDraftModel] = useState<string>("");
  const [typedModel, setTypedModel] = useState("");
  const [testModel, setTestModel] = useState<string | null>(null);
  const [minutes, setMinutes] = useState<string>(entry?.maxMinutesPerAttempt ? String(entry.maxMinutesPerAttempt) : "");
  const [path, setPath] = useState(entry?.executablePath ?? "");

  const enabled = Boolean(entry?.enabled);
  const refused = health.state === "refused";
  const chosen = entry?.models ?? [];
  const choices: CliWorkerModelChoiceView[] = check?.models.length ? check.models : [{ id: null, name: "CLI default" }];
  const choiceOf = (id: string | null) => choices.find((choice) => choice.id === id);
  const unchosen = choices.filter((choice) => !chosen.some((model) => model.id === choice.id));
  const typedValid = typedModel.trim() !== "" && isCliArgumentValue(typedModel.trim()) && typedModel.trim() !== "default";
  const testModels = chosen.length ? chosen : [{ id: null }];
  const testTarget = testModels.find((model) => keyOf(model.id) === keyOf(testModel)) ?? testModels[0]!;
  const busy = saving || !canSave;

  const save = async (patch: HomeCliWorkerPatch) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(patch);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const turnOn = async () => {
    const ok = await save({
      enabled: true,
      // The Full-access note is accepted once (§3.12).
      ...(entry?.consentedAt ? {} : { consentedAt: new Date().toISOString() }),
      ...(chosen.length ? {} : { models: [{ id: null }] }),
    });
    if (ok) setAskingConsent(false);
  };
  const toggle = (next: boolean) => {
    if (!next) return void save({ enabled: false });
    if (!entry?.consentedAt) return setAskingConsent(true);
    void turnOn();
  };
  const setModels = (models: HomeCliWorkerEntry["models"]) => void save({ models });
  const addModel = (id: string | null) => {
    if (chosen.some((model) => model.id === id)) return;
    const effort = id === null ? undefined : choiceOf(id)?.defaultReasoningEffort;
    setModels([...chosen, { id, ...(effort ? { reasoningEffort: effort } : {}) }]);
    setDraftModel("");
    setTypedModel("");
  };
  const test = async () => {
    setTesting(true);
    setTestNote(null);
    try {
      setTestNote(await onTest({ model: testTarget.id, ...(testTarget.reasoningEffort ? { reasoningEffort: testTarget.reasoningEffort } : {}) }));
    } catch (cause) {
      setTestNote(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTesting(false);
    }
  };
  const minutesValue = minutes.trim() === "" ? null : Number(minutes);
  const minutesValid = minutesValue === null || (Number.isInteger(minutesValue) && minutesValue >= CLI_ATTEMPT_MINUTES.min && minutesValue <= CLI_ATTEMPT_MINUTES.max);

  return (
    <section aria-labelledby={`cli-${providerId}-title`} className="space-y-3 rounded-lg border bg-background/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={`cli-${providerId}-title`} className="text-base font-semibold">{name}</h3>
            <Badge variant={healthBadgeVariant(health)}>{health.label}</Badge>
            {enabled && <Badge variant="outline">Worker on</Badge>}
          </div>
          {health.reason && (
            <p className={cn("flex items-start gap-1.5 text-xs", refused ? "text-destructive" : "text-muted-foreground")}>
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{health.reason}</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={`cli-${providerId}-enabled`} className="text-sm">Use as a Build worker</Label>
          <Switch
            id={`cli-${providerId}-enabled`}
            checked={enabled}
            onCheckedChange={toggle}
            disabled={busy || (refused && !enabled)}
          />
        </div>
      </div>

      <CliWorkerFreeChecks check={check} {...(now !== undefined ? { now } : {})} />

      {askingConsent && (
        <div className="space-y-2 rounded-md border border-warning/40 bg-warning-soft p-3 text-sm" role="group" aria-labelledby={`cli-${providerId}-consent`}>
          <p id={`cli-${providerId}-consent`} className="font-medium">{CLI_WORKER_CONSENT_NOTE}</p>
          <p className="text-xs">
            A headless CLI can&apos;t ask you anything, so it runs only in Builds with Full access, in the task&apos;s own
            worktree. AI Board undoes its commits and re-runs the checks it reports before the Architect sees the work.
          </p>
          <div className="flex gap-2">
            {/* Focus moves here when the note opens, so a keyboard or screen-reader user lands on it. */}
            <Button type="button" size="sm" onClick={() => void turnOn()} disabled={busy} autoFocus>I understand, turn it on</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setAskingConsent(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {(enabled || chosen.length > 0) && (
        <div className="space-y-2">
          <Label className="text-sm">Models</Label>
          <p className="text-xs text-muted-foreground">
            Each model is its own worker in the crew picker. A listed model is a suggestion: Test confirms your plan includes it.
          </p>
          <ul className="space-y-2">
            {chosen.map((model, index) => {
              const efforts = model.id === null ? [] : choiceOf(model.id)?.reasoningEfforts ?? [];
              return (
                <li key={keyOf(model.id)} className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto]">
                  <span className="truncate rounded-md border bg-background/60 px-3 py-2 text-sm">
                    {model.id === null ? "CLI default" : choiceOf(model.id)?.name ?? model.id}
                  </span>
                  {efforts.length > 0 || model.reasoningEffort ? (
                    <Select
                      value={model.reasoningEffort ?? DEFAULT_KEY}
                      onValueChange={(value) =>
                        setModels(chosen.map((item, i) => (i === index ? { id: item.id, ...(value === DEFAULT_KEY ? {} : { reasoningEffort: value }) } : item)))}
                      disabled={busy}
                    >
                      <SelectTrigger aria-label={`${name} ${model.id ?? "default"} effort`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT_KEY}>CLI default effort</SelectItem>
                        {[...new Set([...efforts, ...(model.reasoningEffort ? [model.reasoningEffort] : [])])].map((effort) => (
                          <SelectItem key={effort} value={effort}>{effort} effort</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="px-1 text-xs text-muted-foreground">CLI default effort</span>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${model.id ?? "CLI default"} from ${name}'s models`}
                    onClick={() => setModels(chosen.filter((_, i) => i !== index))}
                    disabled={busy}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ul>
          <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto]">
            <Select value={draftModel || undefined} onValueChange={setDraftModel} disabled={busy || unchosen.length === 0}>
              <SelectTrigger aria-label={`Model to add to ${name}`}>
                <SelectValue placeholder={unchosen.length ? "Add a listed model" : "Every listed model is added"} />
              </SelectTrigger>
              <SelectContent>
                {unchosen.map((choice) => (
                  <SelectItem key={keyOf(choice.id)} value={keyOf(choice.id)}>{choice.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={typedModel}
              onChange={(event) => setTypedModel(event.target.value)}
              placeholder="or type a model id"
              aria-label={`Model id to add to ${name}`}
              disabled={busy}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => addModel(typedValid ? typedModel.trim() : idOf(draftModel))}
              disabled={busy || (!typedValid && !draftModel)}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add
            </Button>
          </div>
          {typedModel.trim() !== "" && !typedValid && (
            <p className="text-xs text-destructive">A model id uses letters, digits and . _ : / - only (at most 128).</p>
          )}
        </div>
      )}

      {(enabled || entry) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`cli-${providerId}-minutes`} className="text-sm">Time limit per attempt (minutes)</Label>
            <div className="flex gap-2">
              <Input
                id={`cli-${providerId}-minutes`}
                inputMode="numeric"
                value={minutes}
                placeholder={String(CLI_ATTEMPT_MINUTES.default)}
                onChange={(event) => setMinutes(event.target.value)}
                disabled={busy}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void save({ maxMinutesPerAttempt: minutesValue })}
                disabled={busy || !minutesValid || minutesValue === (entry?.maxMinutesPerAttempt ?? null)}
              >
                Save
              </Button>
            </div>
            <p className={cn("text-xs", minutesValid ? "text-muted-foreground" : "text-destructive")}>
              {`${CLI_ATTEMPT_MINUTES.min}–${CLI_ATTEMPT_MINUTES.max} minutes; ${CLI_ATTEMPT_MINUTES.default} when empty. Always inside the Build's own time limit.`}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`cli-${providerId}-path`} className="text-sm">Program path (optional)</Label>
            <div className="flex gap-2">
              <Input
                id={`cli-${providerId}-path`}
                value={path}
                placeholder={check?.executable?.source === "path" ? check.executable.path : "Found on PATH"}
                onChange={(event) => setPath(event.target.value)}
                disabled={busy}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void save({ executablePath: path.trim() || null })}
                disabled={busy || (path.trim() || null) === (entry?.executablePath ?? null)}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-2 border-t pt-3">
        <div className="flex flex-wrap items-center gap-2">
          {testModels.length > 1 && (
            <Select value={keyOf(testTarget.id)} onValueChange={(value) => setTestModel(idOf(value))} disabled={testing}>
              <SelectTrigger className="w-auto min-w-[12rem]" aria-label={`Model to test with ${name}`}><SelectValue /></SelectTrigger>
              <SelectContent>
                {testModels.map((model) => (
                  <SelectItem key={keyOf(model.id)} value={keyOf(model.id)}>{model.id ?? "CLI default"}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => void test()} disabled={testing || refused || !canSave || !canTest}>
            <RefreshCw className={cn("h-4 w-4", testing && "motion-safe:animate-spin")} aria-hidden="true" />
            {testing ? "Testing…" : `Test ${testTarget.id ?? "CLI default"}`}
          </Button>
          <span className="text-xs text-muted-foreground">
            Sends one tiny prompt in the CLI&apos;s most restricted mode. It uses a tiny amount of {name}&apos;s usage.
          </span>
        </div>
        {testNote && <p className="text-xs text-destructive" role="alert">{testNote}</p>}
        <CliWorkerLastTest lastTest={entry?.lastTest} {...(now !== undefined ? { now } : {})} />
      </div>

      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </section>
  );
}

/**
 * Settings > CLI workers (CWD-8): the free checks, Refresh, each CLI's models and effort, the Full-access
 * note, and Test. Settings save to the AIBoard home through home-client.ts; a Test's result is saved by the Runner.
 */
export function CliWorkersSettings() {
  const home = useHomeState();
  const supported = home.status === "ready" && homeSupportsCliWorkers();
  const { state, checks, refresh } = useCliWorkerChecks({ enabled: supported });
  const entries = home.status === "ready" ? home.view.config.cliWorkers ?? {} : {};
  const checking = state.status === "loading";

  const onTest = async (providerId: CliWorkerProviderId, request: { model: string | null; reasoningEffort?: string }) => {
    const answer = await runCliWorkerTest(modelProxyClient.launcher(), providerId, request);
    // The Runner saved the outcome in the home and marked its check stale: read both again.
    void loadHome();
    void loadCliWorkerChecks();
    if (answer.kind === "tested") {
      return answer.stopVerified ? null : "The test's programs could not be proven stopped; AI Board kept its folder for cleanup.";
    }
    return answer.message;
  };

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Terminal className="h-5 w-5 text-primary" aria-hidden="true" />
            CLI workers
          </CardTitle>
          {supported && state.status !== "unsupported" && (
            <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={checking}>
              <RefreshCw className={cn("h-4 w-4", checking && "motion-safe:animate-spin")} aria-hidden="true" />
              {checking ? "Checking…" : "Refresh"}
            </Button>
          )}
        </div>
        <CardDescription>
          Codex CLI, Claude Code and agy can take Build tasks as workers, next to API models. Each uses your own login,
          which stays in the CLI&apos;s own files: AI Board never reads or stores it. A CLI is a worker only, never the
          Architect or a reviewer, and only in Builds with Full access. Its use isn&apos;t counted toward a USD budget; the
          time limits apply.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!supported ? (
          <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm" role="status">{CLI_WORKERS_UPDATE_MESSAGE}</p>
        ) : (
          <>
            {state.status === "unsupported" && (
              <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm" role="status">
                This AI Board can save CLI worker settings but can&apos;t check or test a CLI. {CLI_WORKERS_UPDATE_MESSAGE}
              </p>
            )}
            {state.status === "error" && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm" role="alert">
                The CLIs could not be checked: {state.message}
              </p>
            )}
            {checks?.checkedAt && (
              <p className="text-xs text-muted-foreground">Checked {new Date(checks.checkedAt).toLocaleTimeString()} on this computer.</p>
            )}
            {CLI_WORKER_IDS.map((providerId) => (
              <CliWorkerPanel
                key={providerId}
                providerId={providerId}
                entry={entries[providerId]}
                check={checks?.workers.find((check) => check.providerId === providerId)}
                canSave={supported}
                canTest={state.status !== "unsupported"}
                onSave={(patch) => saveHome(() => cliWorkerOps(providerId, patch))}
                onTest={(request) => onTest(providerId, request)}
              />
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}
