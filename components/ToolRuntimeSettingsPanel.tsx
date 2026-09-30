"use client";

import { useMemo, useState } from "react";
import { RunnerSetup, type RunnerSelection } from "@/components/RunnerSetup";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { OpenAIFileSearchSettings, RemoteMcpServerSettings, ToolRuntimeSettings } from "@/lib/db/schema";
import {
  saveOpenAIFileSearch,
  saveRemoteMcpServer,
  saveToolRuntimeRunner,
} from "@/lib/client/tool-runtime";

export function ToolRuntimeSettingsPanel({
  settings,
  onChanged,
}: {
  settings?: ToolRuntimeSettings;
  onChanged?: () => void;
}) {
  const initialRunner = useMemo(() => settings?.runner ?? null, [settings?.runner]);
  const initialMcp = settings?.remoteMcpServer;
  const initialFileSearch = settings?.openaiFileSearch;
  const [mcpName, setMcpName] = useState(initialMcp?.name ?? "");
  const [mcpUrl, setMcpUrl] = useState(initialMcp?.url ?? "");
  const [mcpToken, setMcpToken] = useState(initialMcp?.authorizationToken ?? "");
  const [mcpEnabled, setMcpEnabled] = useState(initialMcp?.enabled ?? false);
  const [fileSearchEnabled, setFileSearchEnabled] = useState(initialFileSearch?.enabled ?? false);
  const [vectorStoreIds, setVectorStoreIds] = useState((initialFileSearch?.vectorStoreIds ?? []).join(", "));
  const [saved, setSaved] = useState(false);

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
  const saveMcp = () => {
    const name = mcpName.trim();
    const url = mcpUrl.trim();
    const server: RemoteMcpServerSettings | null = name || url
      ? {
          enabled: mcpEnabled,
          name,
          url,
          ...(mcpToken.trim() ? { authorizationToken: mcpToken.trim() } : {}),
        }
      : null;
    saveRemoteMcpServer(server);
    setSaved(true);
    onChanged?.();
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Local tool runtime</CardTitle>
          <CardDescription>
            Runner V2 is the trusted local executor for shell commands and project-file edits. A healthy saved connection is reused by new Build sessions and by provider capability readiness.
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
      <Card>
        <CardHeader>
          <CardTitle>Approved remote MCP server</CardTitle>
          <CardDescription>
            When enabled, supported providers may receive this server as an optional remote MCP tool. The URL must be http(s); credentials stay in the local AI Board settings store.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={mcpEnabled}
              onChange={(event) => setMcpEnabled(event.target.checked)}
            />
            Offer this approved server to supported providers
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tool-mcp-name">Server name</Label>
              <Input
                id="tool-mcp-name"
                value={mcpName}
                onChange={(event) => setMcpName(event.target.value)}
                placeholder="docs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tool-mcp-url">Server URL</Label>
              <Input
                id="tool-mcp-url"
                value={mcpUrl}
                onChange={(event) => setMcpUrl(event.target.value)}
                placeholder="https://mcp.example.com/sse"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tool-mcp-token">Authorization token (optional)</Label>
            <Input
              id="tool-mcp-token"
              type="password"
              value={mcpToken}
              onChange={(event) => setMcpToken(event.target.value)}
              placeholder="Leave blank for public/no-auth servers"
            />
          </div>
          <Button type="button" onClick={saveMcp}>{saved ? "Saved" : "Save MCP server"}</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Computer & browser executors</CardTitle>
          <CardDescription>
            These capabilities require a continuation-capable client executor that can perform the provider action and return screenshots/results into the same model turn.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          AI Board does not currently ship a built-in computer/browser executor in the web client. The web client does not yet provide the same-turn continuation bridge these provider tools require, so they remain setup-required instead of being falsely marked available.
        </CardContent>
      </Card>
    </div>
  );
}
