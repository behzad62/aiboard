"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import type { ModelInfo } from "@/lib/providers/base";
import {
  CAPABILITY_PROBES,
  summarizeCapabilityResults,
  type CapabilityProbeId,
  type ModelCapabilityProbeProfile,
} from "@/lib/providers/capability-probes";
import {
  clearCapabilityProfile,
  getCapabilityProfiles,
  runCapabilityProbes,
} from "@/lib/client/capability-api";

interface ProviderConfig {
  providerId: string;
  name: string;
  models: ModelInfo[];
  hasKey: boolean;
  enabled: boolean;
}

interface CapabilityLabProps {
  providers: ProviderConfig[];
  onChanged?: () => Promise<void> | void;
}

function defaultProbeSelection(): Record<CapabilityProbeId, boolean> {
  return Object.fromEntries(
    CAPABILITY_PROBES.map((probe) => [probe.id, probe.defaultSelected])
  ) as Record<CapabilityProbeId, boolean>;
}

function resultVariant(status: string) {
  if (status === "pass") return "success" as const;
  if (status === "fail") return "destructive" as const;
  return "secondary" as const;
}

export function CapabilityLab({ providers, onChanged }: CapabilityLabProps) {
  const models = useMemo(
    () =>
      providers
        .filter((provider) => provider.hasKey)
        .flatMap((provider) =>
          provider.models.map((model) => ({
            fullId: `${provider.providerId}:${model.id}`,
            model,
            provider,
          }))
        ),
    [providers]
  );
  const [selectedModelId, setSelectedModelId] = useState(models[0]?.fullId ?? "");
  const [selectedProbes, setSelectedProbes] = useState(defaultProbeSelection);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Record<string, ModelCapabilityProbeProfile>>(
    () => getCapabilityProfiles()
  );

  useEffect(() => {
    if (!selectedModelId && models[0]) {
      setSelectedModelId(models[0].fullId);
    }
  }, [models, selectedModelId]);

  const currentProfile = selectedModelId ? profiles[selectedModelId] : undefined;
  const enabledProbeIds = CAPABILITY_PROBES.filter((probe) => selectedProbes[probe.id]).map(
    (probe) => probe.id
  );

  const runTests = async () => {
    if (!selectedModelId) return;
    if (enabledProbeIds.length === 0) {
      setMessage("Select at least one capability test.");
      return;
    }
    setRunning(true);
    setMessage(null);
    try {
      const profile = await runCapabilityProbes({
        fullModelId: selectedModelId,
        probeIds: enabledProbeIds,
      });
      const next = getCapabilityProfiles();
      setProfiles(next);
      setMessage(`Capability tests complete: ${summarizeCapabilityResults(profile.results)}`);
      await onChanged?.();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Capability tests failed");
    } finally {
      setRunning(false);
    }
  };

  const resetCurrent = async () => {
    if (!selectedModelId) return;
    clearCapabilityProfile(selectedModelId);
    setProfiles(getCapabilityProfiles());
    setMessage("Capability profile reset.");
    await onChanged?.();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider Capability Lab</CardTitle>
        <CardDescription>
          Live-test the exact provider, model, key, deployment, or account you configured. Advanced
          probes are opt-in because they can consume provider quota or subscription messages.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {models.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Save at least one provider key or account-runner token before running capability tests.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <Label>Model to test</Label>
              <Select value={selectedModelId} onValueChange={setSelectedModelId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {models.map(({ fullId, model, provider }) => (
                    <SelectItem key={fullId} value={fullId}>
                      {model.name} · {provider.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-3">
              <div>
                <Label>Capability tests</Label>
                <p className="text-xs text-muted-foreground">
                  Basic tests are selected by default. Select advanced probes only when you want to spend
                  a few extra account/API requests to verify those features.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {CAPABILITY_PROBES.map((probe) => (
                  <label
                    key={probe.id}
                    className="flex items-start gap-3 rounded-md border bg-background p-3 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selectedProbes[probe.id]}
                      onChange={(event) =>
                        setSelectedProbes((prev) => ({
                          ...prev,
                          [probe.id]: event.target.checked,
                        }))
                      }
                    />
                    <span>
                      <span className="font-medium text-foreground">
                        {probe.label} {probe.advanced && <span className="text-xs text-muted-foreground">· advanced</span>}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {probe.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={runTests} disabled={running}>
                {running ? "Running tests..." : "Run capability tests"}
              </Button>
              <Button type="button" variant="outline" onClick={resetCurrent} disabled={running || !currentProfile}>
                Reset selected profile
              </Button>
            </div>

            {currentProfile && (
              <div className="space-y-3 rounded-md border bg-muted/20 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Last profile:</span>
                  <Badge variant="secondary">{new Date(currentProfile.testedAt).toLocaleString()}</Badge>
                  <Badge variant="secondary">{summarizeCapabilityResults(currentProfile.results)}</Badge>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {currentProfile.results.map((result) => (
                    <div key={result.id} className="rounded border bg-background p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{CAPABILITY_PROBES.find((p) => p.id === result.id)?.label ?? result.id}</span>
                        <Badge variant={resultVariant(result.status)}>{result.status}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{result.detail}</p>
                      {result.preview && (
                        <p className="mt-2 max-h-20 overflow-auto rounded bg-muted/50 p-2 font-mono text-xs">
                          {result.preview}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        {message && <p className="text-sm text-muted-foreground">{message}</p>}
      </CardContent>
    </Card>
  );
}
