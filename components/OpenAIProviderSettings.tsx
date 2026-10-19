"use client";

import { useMemo, useState } from "react";
import { ApiKeyForm, type ProviderConfig } from "@/components/ApiKeyForm";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { saveOpenAIConnectionMode } from "@/lib/client/settings-api";
import { flush } from "@/lib/client/store";

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
    await flush();
  };

  const subscriptionModels = useMemo(() => chatgptProvider.models.map((model) => ({
    ...model, name: model.name.replace(/ \(ChatGPT\)$/, ""),
  })), [chatgptProvider.models]);
  const activeProvider = mode === "api"
    ? { ...apiProvider, name: "OpenAI API" }
    : {
        ...chatgptProvider,
        name: "OpenAI — ChatGPT subscription",
        models: subscriptionModels,
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
            API key mode uses OpenAI API billing. ChatGPT subscription mode uses your ChatGPT plan through the public OpenAI API and local account runner, without an API key. Continue with ChatGPT to authorize plan usage. Model availability depends on your account.
          </p>
        </div>
      </div>

      <ApiKeyForm
        key={activeProvider.providerId}
        provider={activeProvider}
        onSaved={onSaved}
        onDraftChange={onDraftChange}
      />
    </div>
  );
}
