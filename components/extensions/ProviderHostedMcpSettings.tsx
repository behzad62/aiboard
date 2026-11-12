"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveRemoteMcpServer } from "@/lib/client/tool-runtime";
import { homeRemoteMcpTokenHint } from "@/lib/client/home-client";
import type { RemoteMcpServerSettings } from "@/lib/db/schema";

export function ProviderHostedMcpSettings({ settings, onChanged }: {
  settings?: RemoteMcpServerSettings | null;
  onChanged?: () => void;
}) {
  const [name, setName] = useState(settings?.name ?? "");
  const [url, setUrl] = useState(settings?.url ?? "");
  // The token is typed once and saved to the AIBoard home; the page shows only its hint.
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenHint = homeRemoteMcpTokenHint();

  useEffect(() => {
    setName(settings?.name ?? "");
    setUrl(settings?.url ?? "");
    setEnabled(settings?.enabled ?? false);
  }, [settings?.name, settings?.url, settings?.enabled]);

  const save = async () => {
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    setError(null);
    try {
      await saveRemoteMcpServer(trimmedName || trimmedUrl ? {
        enabled,
        name: trimmedName,
        url: trimmedUrl,
        ...(token.trim() ? { authorizationToken: token.trim() } : {}),
      } : null);
      setToken("");
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (saveError) {
      // A failed save reverts the form to what the home holds.
      setName(settings?.name ?? "");
      setUrl(settings?.url ?? "");
      setEnabled(settings?.enabled ?? false);
      setError(saveError instanceof Error ? saveError.message : "Could not save the server");
    }
    onChanged?.();
  };

  return (
    <Card id="provider-hosted-mcp">
      <CardHeader>
        <CardTitle>Provider-hosted MCP server</CardTitle>
        <CardDescription>
          Not offered to providers yet: a provider-hosted server bypasses the Runner’s per-tool filter, so AI Board does not send it until that can be enforced. To use a remote server now, add it as a Runner-hosted MCP server. Saved settings here are kept in your AIBoard home, and the token with your other keys.
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
          <Input id="tool-mcp-token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder={tokenHint ? `Saved (${tokenHint}); type a new one to replace it` : "Leave blank for public/no-auth servers"} />
        </div>
        <Button type="button" onClick={() => void save()}>{saved ? "Saved" : "Save provider-hosted server"}</Button>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      </CardContent>
    </Card>
  );
}
