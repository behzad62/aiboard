"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveRemoteMcpServer } from "@/lib/client/tool-runtime";
import type { RemoteMcpServerSettings } from "@/lib/db/schema";

export function ProviderHostedMcpSettings({ settings, onChanged }: {
  settings?: RemoteMcpServerSettings | null;
  onChanged?: () => void;
}) {
  const [name, setName] = useState(settings?.name ?? "");
  const [url, setUrl] = useState(settings?.url ?? "");
  const [token, setToken] = useState(settings?.authorizationToken ?? "");
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(settings?.name ?? "");
    setUrl(settings?.url ?? "");
    setToken(settings?.authorizationToken ?? "");
    setEnabled(settings?.enabled ?? false);
  }, [settings?.name, settings?.url, settings?.authorizationToken, settings?.enabled]);

  const save = () => {
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    saveRemoteMcpServer(trimmedName || trimmedUrl ? {
      enabled,
      name: trimmedName,
      url: trimmedUrl,
      ...(token.trim() ? { authorizationToken: token.trim() } : {}),
    } : null);
    setSaved(true);
    onChanged?.();
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <Card id="provider-hosted-mcp">
      <CardHeader>
        <CardTitle>Provider-hosted MCP server</CardTitle>
        <CardDescription>
          Configure one remote server for supported model providers to call directly. This is separate from Runner-hosted MCP servers: its token stays in this browser’s settings and it does not require a Runner connection.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          Offer this server to supported providers
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="tool-mcp-name">Server name</Label>
            <Input id="tool-mcp-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="docs" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tool-mcp-url">Server URL</Label>
            <Input id="tool-mcp-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://mcp.example.com/sse" />
            <p className="text-xs text-muted-foreground">Use an HTTP or HTTPS URL.</p>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tool-mcp-token">Authorization token (optional)</Label>
          <Input id="tool-mcp-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Leave blank for public/no-auth servers" />
        </div>
        <Button type="button" onClick={save}>{saved ? "Saved" : "Save provider-hosted server"}</Button>
      </CardContent>
    </Card>
  );
}
