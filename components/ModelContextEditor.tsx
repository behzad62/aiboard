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
import { saveModelContextOverride } from "@/lib/client/settings-api";
import {
  formatContextWindowTokens,
  type LongContextBehavior,
  type ModelContextProfile,
  type ModelContextProfileOverride,
} from "@/lib/providers/model-context";

interface ModelContextEditorProps {
  fullModelId: string;
  profile: ModelContextProfile;
  override?: ModelContextProfileOverride;
  onSaved: () => Promise<void> | void;
}

const BEHAVIOR_LABELS: Record<LongContextBehavior, string> = {
  standard: "Standard",
  large: "Large",
  very_large: "Very large",
};

export function ModelContextEditor({
  fullModelId,
  profile,
  override,
  onSaved,
}: ModelContextEditorProps) {
  const [contextWindow, setContextWindow] = useState("");
  const [outputReserve, setOutputReserve] = useState("");
  const [behavior, setBehavior] = useState<LongContextBehavior>("standard");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setContextWindow(String(override?.contextWindowTokens ?? profile.contextWindowTokens));
    setOutputReserve(String(override?.outputReserveTokens ?? profile.outputReserveTokens));
    setBehavior(override?.longContextBehavior ?? profile.longContextBehavior);
    setMessage(null);
  }, [fullModelId, override, profile]);

  const saveOverride = async () => {
    const nextContext = Number(contextWindow);
    const nextReserve = Number(outputReserve);
    if (!Number.isFinite(nextContext) || !Number.isFinite(nextReserve)) {
      setMessage("Enter valid context and reserve token counts.");
      return;
    }
    if (nextContext <= 0 || nextReserve <= 0) {
      setMessage("Context and reserve token counts must be greater than zero.");
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      saveModelContextOverride({
        fullModelId,
        contextWindowTokens: nextContext,
        outputReserveTokens: nextReserve,
        longContextBehavior: behavior,
      });
      setMessage("Context override saved");
      await onSaved();
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
      saveModelContextOverride({ fullModelId, clear: true });
      setMessage("Context override reset");
      await onSaved();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to reset context override");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">Context profile</p>
        {profile.source === "override" && (
          <Badge variant="warning">Local override</Badge>
        )}
      </div>

      <p className="text-muted-foreground">
        {formatContextWindowTokens(profile.contextWindowTokens)} context /{" "}
        {formatContextWindowTokens(profile.outputReserveTokens)} reserve
        {" - "}
        {BEHAVIOR_LABELS[profile.longContextBehavior]}
      </p>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-1">
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
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${fullModelId}-output-reserve`}>Output reserve</Label>
          <Input
            id={`${fullModelId}-output-reserve`}
            type="number"
            min="1"
            step="1024"
            value={outputReserve}
            onChange={(e) => setOutputReserve(e.target.value)}
            placeholder="e.g. 8192"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${fullModelId}-long-context`}>Long context</Label>
          <Select
            value={behavior}
            onValueChange={(value) => setBehavior(value as LongContextBehavior)}
          >
            <SelectTrigger id={`${fullModelId}-long-context`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="standard">Standard</SelectItem>
              <SelectItem value="large">Large</SelectItem>
              <SelectItem value="very_large">Very large</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={saveOverride} disabled={saving}>
          {saving ? "Saving..." : "Save context override"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={resetOverride}
          disabled={saving}
        >
          Reset to built-in context
        </Button>
      </div>

      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}
