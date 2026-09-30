"use client";

import { useState } from "react";
import { ApiKeyForm, type ProviderConfig } from "@/components/ApiKeyForm";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { saveOpenAIConnectionMode, saveProviderKey } from "@/lib/client/settings-api";

export type OpenAIConnectionMode = "api" | "subscription";

export function initialOpenAIConnectionMode(
  apiProvider: ProviderConfig,
  chatgptProvider: ProviderConfig,
  preferred?: OpenAIConnectionMode,
): OpenAIConnectionMode {
  if (preferred === "api" || preferred === "subscription") return preferred;
  if (chatgptProvider.enabled && !apiProvider.enabled) return "subscription";
  if (apiProvider.enabled && !chatgptProvider.enabled) return "api";
  if (chatgptProvider.hasKey && !apiProvider.hasKey) return "subscription";
  return "api";
}

export function OpenAIProviderSettings({
  apiProvider,
  chatgptProvider,
  onSaved,
  onDraftChange,
  preferredMode,
}: {
  apiProvider: ProviderConfig;
  chatgptProvider: ProviderConfig;
  onSaved: () => Promise<void> | void;
  onDraftChange?: (providerId: string, patch: { enabled: boolean }) => void;
  preferredMode?: OpenAIConnectionMode;
}) {
  const [mode, setMode] = useState<OpenAIConnectionMode>(() =>
    initialOpenAIConnectionMode(apiProvider, chatgptProvider, preferredMode),
  );

  const changeMode = async (next: OpenAIConnectionMode) => {
    if (next === mode) return;
    setMode(next);
    saveOpenAIConnectionMode(next);
    const inactive = next === "api" ? chatgptProvider : apiProvider;
    if (inactive.enabled && inactive.hasKey) {
      saveProviderKey({
        providerId: inactive.providerId,
        defaultModel: inactive.defaultModel ?? undefined,
        enabled: false,
      });
      onDraftChange?.(inactive.providerId, { enabled: false });
      await onSaved();
    }
  };

  const activeProvider = mode === "api"
    ? { ...apiProvider, name: "OpenAI API" }
    : {
        ...chatgptProvider,
        name: "OpenAI — ChatGPT subscription",
        models: chatgptProvider.models.map((model) => ({
          ...model,
          name: model.name.replace(/ \(ChatGPT\)$/, ""),
        })),
      };
  const inactiveProvider = mode === "api" ? chatgptProvider : apiProvider;

  const handleDraftChange = (providerId: string, patch: { enabled: boolean }) => {
    onDraftChange?.(providerId, patch);
    if (patch.enabled && inactiveProvider.enabled && inactiveProvider.hasKey) {
      saveProviderKey({
        providerId: inactiveProvider.providerId,
        defaultModel: inactiveProvider.defaultModel ?? undefined,
        enabled: false,
      });
      onDraftChange?.(inactiveProvider.providerId, { enabled: false });
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/20 p-4">
        <div className="space-y-2">
          <Label htmlFor="openai-connection-mode">Connection method</Label>
          <Select value={mode} onValueChange={(value) => void changeMode(value as OpenAIConnectionMode)}>
            <SelectTrigger id="openai-connection-mode" className="max-w-md">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="api">API key</SelectItem>
              <SelectItem value="subscription">ChatGPT subscription</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            API key mode uses OpenAI API billing. ChatGPT subscription mode uses the local account runner and your signed-in ChatGPT entitlement. The two routes keep separate transport and capability truth internally.
          </p>
        </div>
      </div>

      <ApiKeyForm
        key={activeProvider.providerId}
        provider={activeProvider}
        onSaved={onSaved}
        onDraftChange={handleDraftChange}
      />
    </div>
  );
}
