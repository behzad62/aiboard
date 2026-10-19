"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  formatUsdPerMillion,
  type ModelPricing,
} from "@/lib/providers/pricing";
import { savePricingOverride } from "@/lib/client/settings-api";
import { flush } from "@/lib/client/store";

interface ModelPricingEditorProps {
  fullModelId: string;
  pricing: ModelPricing | null;
  onSaved: () => Promise<void> | void;
  title?: string;
}

export function ModelPricingEditor({
  fullModelId,
  pricing,
  onSaved,
  title = "Current API pricing",
}: ModelPricingEditorProps) {
  const [inputPrice, setInputPrice] = useState("");
  const [outputPrice, setOutputPrice] = useState("");
  const [cachedInputPrice, setCachedInputPrice] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const currentInput = pricing?.inputUsdPer1M;
  const currentOutput = pricing?.outputUsdPer1M;
  const currentCached = pricing?.cachedInputUsdPer1M;

  useEffect(() => {
    setInputPrice(currentInput !== undefined ? String(currentInput) : "");
    setOutputPrice(currentOutput !== undefined ? String(currentOutput) : "");
    setCachedInputPrice(currentCached !== undefined ? String(currentCached) : "");
  }, [fullModelId, currentInput, currentOutput, currentCached]);
  useEffect(() => { setMessage(null); }, [fullModelId]);

  const saveOverride = async () => {
    const nextInput = Number(inputPrice);
    const nextOutput = Number(outputPrice);
    const nextCached = cachedInputPrice.trim() === "" ? null : Number(cachedInputPrice);

    if (!inputPrice.trim() || !outputPrice.trim() || !Number.isFinite(nextInput) || !Number.isFinite(nextOutput) || (nextCached !== null && !Number.isFinite(nextCached))) {
      setMessage("Enter valid input and output prices.");
      return;
    }
    if (nextInput < 0 || nextOutput < 0 || (nextCached !== null && nextCached < 0)) {
      setMessage("Pricing values must be zero or greater.");
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      savePricingOverride({
        fullModelId,
        inputUsdPer1M: nextInput,
        outputUsdPer1M: nextOutput,
        cachedInputUsdPer1M: nextCached,
      });
      await flush();
      await onSaved();
      setMessage("Pricing override saved");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to save pricing override");
    } finally {
      setSaving(false);
    }
  };

  const resetOverride = async () => {
    setSaving(true);
    setMessage(null);
    try {
      savePricingOverride({ fullModelId, clear: true });
      await flush();
      await onSaved();
      setMessage("Pricing override reset");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to reset pricing override");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{title}</p>
        {pricing?.isOverride && <Badge variant="warning">Local override</Badge>}
      </div>
      {pricing ? (
        <>
          <p className="text-muted-foreground">
            {formatUsdPerMillion(pricing.inputUsdPer1M)} input / 1M tokens
            {" · "}
            {formatUsdPerMillion(pricing.outputUsdPer1M)} output / 1M tokens
          </p>
          {pricing.cachedInputUsdPer1M !== undefined && (
            <p className="text-xs text-muted-foreground">
              Cached input: {formatUsdPerMillion(pricing.cachedInputUsdPer1M)} / 1M tokens
            </p>
          )}
          {pricing.notes && <p className="text-xs text-muted-foreground">{pricing.notes}</p>}
          {pricing.sourceUrl ? (
            <a
              href={pricing.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex text-xs text-primary hover:underline"
            >
              {pricing.sourceLabel} · verified {pricing.verifiedAt}
            </a>
          ) : (
            <p className="text-xs text-muted-foreground">
              {pricing.sourceLabel} · verified {pricing.verifiedAt}
            </p>
          )}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Pricing is unknown for this model. You can enter local USD rates per million tokens below.
        </p>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={`${fullModelId}-input-price`}>Input / 1M</Label>
          <Input
            id={`${fullModelId}-input-price`}
            type="number"
            min="0"
            step="0.0001"
            value={inputPrice}
            onChange={(e) => setInputPrice(e.target.value)}
            placeholder="e.g. 5"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${fullModelId}-output-price`}>Output / 1M</Label>
          <Input
            id={`${fullModelId}-output-price`}
            type="number"
            min="0"
            step="0.0001"
            value={outputPrice}
            onChange={(e) => setOutputPrice(e.target.value)}
            placeholder="e.g. 30"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${fullModelId}-cached-price`}>Cached input / 1M</Label>
          <Input
            id={`${fullModelId}-cached-price`}
            type="number"
            min="0"
            step="0.0001"
            value={cachedInputPrice}
            onChange={(e) => setCachedInputPrice(e.target.value)}
            placeholder="optional"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={saveOverride} disabled={saving}>
          {saving ? "Saving..." : "Save pricing override"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={resetOverride} disabled={saving}>
          Reset pricing override
        </Button>
      </div>

      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}
