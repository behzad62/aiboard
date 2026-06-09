"use client";

import { useState } from "react";
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
import type { ModelInfo } from "@/lib/providers/base";

interface ProviderConfig {
  providerId: string;
  name: string;
  models: ModelInfo[];
  hasKey: boolean;
  keyHint?: string | null;
  defaultModel?: string | null;
  enabled: boolean;
}

interface ApiKeyFormProps {
  provider: ProviderConfig;
  onSaved: () => void;
}

export function ApiKeyForm({ provider, onSaved }: ApiKeyFormProps) {
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState(provider.defaultModel ?? provider.models[0]?.id ?? "");
  const [enabled, setEnabled] = useState(provider.enabled);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: provider.providerId,
          apiKey: apiKey || undefined,
          defaultModel,
          enabled,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save");
      setApiKey("");
      setMessage("Saved successfully");
      onSaved();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Save failed");
    } finally {
      setLoading(false);
    }
  };

  const testKey = async () => {
    setTesting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: provider.providerId,
          apiKey: apiKey || undefined,
        }),
      });
      const data = await res.json();
      setMessage(data.valid ? "Connection successful" : "Invalid API key");
    } catch {
      setMessage("Validation failed");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">{provider.name}</h3>
          {provider.hasKey && provider.keyHint && (
            <p className="text-xs text-muted-foreground">Saved key: {provider.keyHint}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={`enabled-${provider.providerId}`}>Enabled</Label>
          <Switch
            id={`enabled-${provider.providerId}`}
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`key-${provider.providerId}`}>API Key</Label>
        <Input
          id={`key-${provider.providerId}`}
          type="password"
          placeholder={provider.hasKey ? "Leave blank to keep existing key" : "Enter API key"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label>Default model</Label>
        <Select value={defaultModel} onValueChange={setDefaultModel}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {provider.models.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex gap-2">
        <Button type="button" onClick={save} disabled={loading}>
          {loading ? "Saving..." : "Save"}
        </Button>
        <Button type="button" variant="outline" onClick={testKey} disabled={testing}>
          {testing ? "Testing..." : "Test connection"}
        </Button>
      </div>

      {message && (
        <p className="text-sm text-muted-foreground">{message}</p>
      )}
    </div>
  );
}
