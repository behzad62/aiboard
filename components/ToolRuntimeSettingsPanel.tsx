"use client";

import { useEffect, useMemo, useState } from "react";
import { RunnerSetup, type RunnerSelection } from "@/components/RunnerSetup";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { OpenAIFileSearchSettings, ToolRuntimeSettings } from "@/lib/db/schema";
import {
  saveOpenAIFileSearch,
  saveToolRuntimeRunner,
} from "@/lib/client/tool-runtime";

export function ToolRuntimeSettingsPanel({
  settings,
  onChanged,
  onOpenExtensions,
}: {
  settings?: ToolRuntimeSettings;
  onChanged?: () => void;
  onOpenExtensions: () => void;
}) {
  const initialRunner = useMemo(() => settings?.runner ?? null, [settings?.runner]);
  const fileSearchEnabledSetting = settings?.openaiFileSearch?.enabled ?? false;
  const vectorStoreIdsSetting = (settings?.openaiFileSearch?.vectorStoreIds ?? []).join(", ");
  const [fileSearchEnabled, setFileSearchEnabled] = useState(fileSearchEnabledSetting);
  const [vectorStoreIds, setVectorStoreIds] = useState(vectorStoreIdsSetting);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setFileSearchEnabled(fileSearchEnabledSetting);
    setVectorStoreIds(vectorStoreIdsSetting);
  }, [fileSearchEnabledSetting, vectorStoreIdsSetting]);

  const persistRunner = (selection: RunnerSelection | null) => {
    saveToolRuntimeRunner(selection);
    onChanged?.();
  };

  const saveFileSearch = () => {
    const ids = [...new Set(vectorStoreIds.split(/[\s,]+/).map((id) => id.trim()).filter(Boolean))];
    const config: OpenAIFileSearchSettings | null = ids.length > 0
      ? { enabled: fileSearchEnabled, vectorStoreIds: ids }
      : null;
    saveOpenAIFileSearch(config);
    setSaved(true);
    onChanged?.();
    setTimeout(() => setSaved(false), 1500);
  };


  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Manage skills, MCP servers and plugins in <button type="button" className="underline" onClick={onOpenExtensions}>Extensions</button>.
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Local tool runtime</CardTitle>
          <CardDescription>
            Connect Runner V2 for Build sessions and Runner-hosted extensions. A healthy saved connection is also used for provider capability readiness.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RunnerSetup initialSelection={initialRunner} onChange={persistRunner} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>OpenAI File Search</CardTitle>
          <CardDescription>
            Configure one or more existing OpenAI vector-store IDs. When enabled, AI Board offers File Search only to OpenAI Responses calls and passes these IDs as vector_store_ids.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={fileSearchEnabled}
              onChange={(event) => setFileSearchEnabled(event.target.checked)}
            />
            Offer File Search to supported OpenAI models
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="tool-openai-vector-stores">Vector store IDs</Label>
            <Input
              id="tool-openai-vector-stores"
              value={vectorStoreIds}
              onChange={(event) => setVectorStoreIds(event.target.value)}
              placeholder="vs_abc123, vs_def456"
            />
            <p className="text-xs text-muted-foreground">
              Separate multiple IDs with commas or spaces. Create/upload content to the vector store in OpenAI first, then paste the resulting ID here.
            </p>
          </div>
          <Button type="button" onClick={saveFileSearch}>{saved ? "Saved" : "Save File Search"}</Button>
        </CardContent>
      </Card>
    </div>
  );
}
