"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { saveModelContextOverride } from "@/lib/client/settings-api";
import { flush } from "@/lib/client/store";
import {
  formatContextWindowTokens,
  type LongContextQuality,
  type ModelBuildRole,
  type ModelContextProfile,
  type ModelContextProfileOverride,
} from "@/lib/providers/model-context";

interface ModelContextEditorProps {
  fullModelId: string;
  profile: ModelContextProfile;
  override?: ModelContextProfileOverride;
  onSaved: () => Promise<void> | void;
  advancedOnly?: boolean;
}

const QUALITY_LABELS: Record<LongContextQuality, string> = {
  poor: "Poor",
  ok: "Ok",
  good: "Good",
  excellent: "Excellent",
};

const BUILD_ROLES: ModelBuildRole[] = [
  "architect",
  "worker",
  "reviewer",
  "summary",
];

function roleLabel(role: ModelBuildRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function ModelContextEditor({
  fullModelId,
  profile,
  override,
  onSaved,
  advancedOnly = false,
}: ModelContextEditorProps) {
  const [contextWindow, setContextWindow] = useState("");
  const [maxOutput, setMaxOutput] = useState("");
  const [buildReserve, setBuildReserve] = useState("");
  const [inputCeiling, setInputCeiling] = useState("");
  const [quality, setQuality] = useState<LongContextQuality>("ok");
  const [promptCaching, setPromptCaching] = useState(false);
  const [roles, setRoles] = useState<ModelBuildRole[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const rolesKey = JSON.stringify(profile.recommendedBuildRoles ?? []);

  useEffect(() => {
    setContextWindow(String(profile.contextWindowTokens));
    setMaxOutput(String(profile.maxOutputTokens ?? ""));
    setBuildReserve(
      String(profile.buildOutputReserveTokens ?? "")
    );
    setInputCeiling(
      String(profile.effectiveBuildInputCeilingTokens ?? "")
    );
    setQuality(profile.longContextQuality ?? "ok");
    setPromptCaching(profile.promptCaching ?? false);
    setRoles(JSON.parse(rolesKey) as ModelBuildRole[]);
  }, [fullModelId, profile.contextWindowTokens, profile.maxOutputTokens, profile.buildOutputReserveTokens,
    profile.effectiveBuildInputCeilingTokens, profile.longContextQuality, profile.promptCaching, rolesKey]);
  useEffect(() => { setMessage(null); }, [fullModelId]);

  const toggleRole = (role: ModelBuildRole) => {
    setRoles((prev) =>
      prev.includes(role)
        ? prev.filter((existing) => existing !== role)
        : [...prev, role]
    );
  };

  const parseOptionalPositive = (value: string): number | undefined | null => {
    if (value.trim() === "") return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
    return parsed;
  };

  const saveOverride = async () => {
    const nextContext = parseOptionalPositive(contextWindow);
    const nextMaxOutput = parseOptionalPositive(maxOutput);
    const nextReserve = parseOptionalPositive(buildReserve);
    const nextInputCeiling = parseOptionalPositive(inputCeiling);

    if (
      (!advancedOnly && (nextContext === null || nextMaxOutput === null)) ||
      nextReserve === null ||
      nextInputCeiling === null
    ) {
      setMessage("Enter valid positive token counts.");
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      saveModelContextOverride({
        fullModelId,
        contextWindowTokens: advancedOnly ? override?.contextWindowTokens ?? undefined : nextContext ?? undefined,
        maxOutputTokens: advancedOnly ? override?.maxOutputTokens ?? undefined : nextMaxOutput ?? undefined,
        buildOutputReserveTokens: nextReserve,
        effectiveBuildInputCeilingTokens: nextInputCeiling,
        longContextQuality: quality,
        promptCaching,
        recommendedBuildRoles: roles,
      });
      await flush();
      await onSaved();
      setMessage(advancedOnly ? "Build settings saved" : "Context override saved");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to save context override");
    } finally {
      setSaving(false);
    }
  };

  const resetOverride = async () => {
    setSaving(true);
    setMessage(null);
    try {
      saveModelContextOverride(advancedOnly ? { fullModelId, clearBuildSettings: true } : { fullModelId, clear: true });
      await flush();
      await onSaved();
      setMessage(advancedOnly ? "Build settings reset" : "Context override reset");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to reset context override");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{advancedOnly ? "Build settings" : "Context profile"}</p>
        {profile.source === "override" && (
          <Badge variant="warning">Local override</Badge>
        )}
        {(profile.source === "provider-default" || profile.source === "default") && <Badge variant="warning">Conservative fallback</Badge>}
      </div>
      {(profile.source === "provider-default" || profile.source === "default") && <p className="text-xs text-muted-foreground">Model token limits have not been reported or set. These fallback limits are used for scheduling; you can enter the actual limits in Model details.</p>}

      <p className="text-muted-foreground">
        {advancedOnly ? "Scheduling profile: " : ""}
        {formatContextWindowTokens(profile.contextWindowTokens)} context
        {profile.maxOutputTokens
          ? ` / ${formatContextWindowTokens(profile.maxOutputTokens)} max output`
          : ""}
        {profile.buildOutputReserveTokens
          ? ` / ${formatContextWindowTokens(profile.buildOutputReserveTokens)} reserve`
          : ""}
        {profile.longContextQuality
          ? ` - ${QUALITY_LABELS[profile.longContextQuality]} long context`
          : ""}
      </p>
      {advancedOnly && <p className="text-xs text-muted-foreground">Scheduling values can include conservative fallbacks for unreported limits. Set model token limits in Model details. Save Build settings separately below.</p>}

      <div className={`grid gap-3 ${advancedOnly ? "md:grid-cols-2" : "md:grid-cols-4"}`}>
        {!advancedOnly && <div className="space-y-1">
          <Label htmlFor={`${fullModelId}-context-window`}>Context tokens</Label>
          <Input
            id={`${fullModelId}-context-window`}
            type="number"
            min="1"
            step="1024"
            value={contextWindow}
            onChange={(e) => setContextWindow(e.target.value)}
            placeholder="e.g. 128000"
          />
        </div>}
        {!advancedOnly && <div className="space-y-1">
          <Label htmlFor={`${fullModelId}-max-output`}>Max output</Label>
          <Input
            id={`${fullModelId}-max-output`}
            type="number"
            min="1"
            step="1024"
            value={maxOutput}
            onChange={(e) => setMaxOutput(e.target.value)}
            placeholder="e.g. 8192"
          />
        </div>}
        <div className="space-y-1">
          <Label htmlFor={`${fullModelId}-build-reserve`}>Build reserve</Label>
          <Input
            id={`${fullModelId}-build-reserve`}
            type="number"
            min="1"
            step="1024"
            value={buildReserve}
            onChange={(e) => setBuildReserve(e.target.value)}
            placeholder="e.g. 8192"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${fullModelId}-input-ceiling`}>Input ceiling</Label>
          <Input
            id={`${fullModelId}-input-ceiling`}
            type="number"
            min="1"
            step="1024"
            value={inputCeiling}
            onChange={(e) => setInputCeiling(e.target.value)}
            placeholder="e.g. 120000"
          />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="space-y-1">
          <Label htmlFor={`${fullModelId}-long-context-quality`}>
            Long-context quality
          </Label>
          <Select
            value={quality}
            onValueChange={(value) => setQuality(value as LongContextQuality)}
          >
            <SelectTrigger id={`${fullModelId}-long-context-quality`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="poor">Poor</SelectItem>
              <SelectItem value="ok">Ok</SelectItem>
              <SelectItem value="good">Good</SelectItem>
              <SelectItem value="excellent">Excellent</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end gap-2 pb-2">
          <Switch id={`${fullModelId}-prompt-caching`} checked={promptCaching} onCheckedChange={setPromptCaching} />
          <Label htmlFor={`${fullModelId}-prompt-caching`}>Prompt caching</Label>
        </div>
      </div>

      <div className="space-y-1">
        <Label>Recommended Build roles</Label>
        <div className="flex flex-wrap gap-2">
          {BUILD_ROLES.map((role) => (
            <Button
              key={role}
              type="button"
              size="sm"
              variant={roles.includes(role) ? "secondary" : "outline"}
              aria-pressed={roles.includes(role)}
              onClick={() => toggleRole(role)}
            >
              {roleLabel(role)}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={saveOverride} disabled={saving}>
          {saving ? "Saving..." : advancedOnly ? "Save Build settings" : "Save context override"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={resetOverride}
          disabled={saving}
        >
          {advancedOnly ? "Reset Build settings" : "Reset context override"}
        </Button>
      </div>

      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}
