"use client";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MODEL_METADATA_FIELDS, effectiveModelMetadata, missingModelMetadata, type ModelMetadataDetails, type ModelMetadataField, type ModelMetadataValues } from "@/lib/providers/model-metadata";

export function ModelMetadataEditor({ modelId, metadata, overrides, onChange }: {
  modelId: string;
  metadata?: ModelMetadataDetails;
  overrides: ModelMetadataValues;
  onChange: (values: ModelMetadataValues) => void;
}) {
  const provider = effectiveModelMetadata({ ...metadata, overrides: {}, supplemental: undefined });
  const defaults = effectiveModelMetadata({ ...metadata, overrides: {} });
  const reference = metadata?.supplemental;
  const equivalent = metadata?.apiEquivalentPricing;
  const subscription = /^(chatgpt|github-copilot):/.test(modelId);
  const missing = missingModelMetadata({ ...metadata, overrides });
  const checked = metadata?.catalogFetchedAt !== undefined;
  const numeric = ["contextWindowTokens", "maxOutputTokens", "inputUsdPer1M", "outputUsdPer1M", "cachedInputUsdPer1M"] as const;
  const modalities = ["text", "image", "document", "audio", "video"] as const;
  const change = (field: ModelMetadataField, value: number | boolean | undefined) => {
    const next = { ...overrides };
    if (value === undefined) delete next[field];
    else Object.assign(next, { [field]: value });
    onChange(next);
  };
  return (
    <details className="mt-2 rounded-md border bg-muted/10 p-3 text-sm">
      <summary className="cursor-pointer font-medium">Model details{missing.length > 0 ? ` · ${missing.length} unknown` : " · Complete"}</summary>
      {!checked && <p className="mt-2 text-xs text-muted-foreground">Saved details have not been verified against the current catalog. Browse or refresh the catalog to check what the provider reports.</p>}
      {missing.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{checked ? "Not reported or set" : "Not yet known or set"}: {missing.map((field) => MODEL_METADATA_FIELDS[field]).join(", ")}. You can fill these in below or leave them unknown. Unknown pricing is not treated as free; unconfirmed attachment types stay disabled.</p>}
      <p className="mt-2 text-xs text-muted-foreground">Catalog values are shown below each field. Optional overrides are saved with the provider. Clear an override to use the catalog again; refreshing the catalog preserves your edits.</p>
      <p className="mt-2 text-xs text-muted-foreground">Prices are in USD per million tokens and drive cost estimates throughout the app.{subscription ? " API-equivalent estimates show what the same token usage would cost through the API; they are not subscription charges." : ""}{metadata?.catalogFetchedAt ? ` Catalog checked ${new Date(metadata.catalogFetchedAt).toLocaleString()}.` : ""}</p>
      {equivalent && <p className="mt-2 text-xs text-muted-foreground">API-equivalent reference: {equivalent.modelId}, from <a href="https://models.dev" className="text-primary underline" target="_blank" rel="noreferrer">Models.dev</a>. Base API tier; long-context and other service tiers can differ.</p>}
      {reference && <p className="mt-2 text-xs text-muted-foreground"><a href="https://models.dev" target="_blank" rel="noreferrer" className="text-primary underline">Models.dev references</a> fill missing fields only. Fetched {new Date(reference.fetchedAt).toLocaleString()}{reference.updatedAt ? `; source record updated ${reference.updatedAt}` : ""}. These are community-maintained references. {reference.pricingNote}</p>}
      {reference?.scope === "model" && <p className="mt-2 text-xs text-muted-foreground">Underlying model reference: {reference.modelId}. These specifications are not confirmed subscription limits. Reported account values take precedence.</p>}
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {numeric.map((field) => {
          const tokens = field.endsWith("Tokens");
          return <div key={field} className="space-y-1">
            <Label htmlFor={`${modelId}-${field}`}>{MODEL_METADATA_FIELDS[field]}</Label>
            <Input id={`${modelId}-${field}`} type="number" min={tokens ? 1 : 0} step={tokens ? 1 : "any"}
              placeholder={defaults[field] !== undefined ? String(defaults[field]) : "Unknown"}
              value={overrides[field] ?? ""} onChange={(event) => change(field, event.target.value === "" ? undefined : Number(event.target.value))} />
            <p className="text-xs text-muted-foreground">Catalog: {provider[field] ?? (checked ? "Not reported" : "Not checked")}{overrides[field] !== undefined ? " · Manual override" : ""}</p>
            {provider[field] === undefined && reference?.values[field] !== undefined && <p className="text-xs text-muted-foreground">Models.dev reference: {reference.values[field]}</p>}
            {equivalent?.values[field as keyof typeof equivalent.values] !== undefined && <p className="text-xs text-muted-foreground">API-equivalent reference: {equivalent.values[field as keyof typeof equivalent.values]}</p>}
          </div>;
        })}
        {modalities.map((field) => <div key={field} className="space-y-1">
          <Label htmlFor={`${modelId}-${field}`}>{MODEL_METADATA_FIELDS[field]}</Label>
          <Select value={overrides[field] === undefined ? "provider" : overrides[field] ? "yes" : "no"}
            onValueChange={(value) => change(field, value === "provider" ? undefined : value === "yes")}>
            <SelectTrigger id={`${modelId}-${field}`}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="provider">{defaults[field] === undefined ? "Unknown" : `${provider[field] === undefined ? "Models.dev" : "Catalog"}: ${defaults[field] ? "Yes" : "No"}`}</SelectItem><SelectItem value="yes">Yes (override)</SelectItem><SelectItem value="no">No (override)</SelectItem></SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Catalog: {provider[field] === undefined ? (checked ? "Not reported" : "Not checked") : provider[field] ? "Yes" : "No"}</p>
          {provider[field] === undefined && reference?.values[field] !== undefined && <p className="text-xs text-muted-foreground">Models.dev reference: {reference.values[field] ? "Yes" : "No"}</p>}
        </div>)}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => {
          const next = { ...overrides };
          delete next.inputUsdPer1M; delete next.outputUsdPer1M; delete next.cachedInputUsdPer1M;
          onChange(next);
        }}>Reset pricing overrides</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => {
          const next = { ...overrides };
          delete next.contextWindowTokens; delete next.maxOutputTokens;
          onChange(next);
        }}>Reset token limit overrides</Button>
      </div>
    </details>
  );
}
