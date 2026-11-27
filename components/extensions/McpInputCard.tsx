"use client";

import { useState } from "react";
import { answerRunnerMcpInput, type McpChatPromptDto } from "@/lib/client/runner-extensions";
import type { NativeRunnerConnection } from "@/lib/client/runner-v2";

export function McpInputCard({ prompt, connection, sessionId, onChanged }: {
  prompt: McpChatPromptDto; connection: NativeRunnerConnection; sessionId: string; onChanged: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function send(action: "accept" | "decline" | "cancel") {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const content: Record<string, string | number | boolean> = Object.create(null);
      if (action === "accept") {
        for (const field of prompt.fields) {
          const raw = values[field.key];
          if (raw === undefined || raw === "") {
            if (field.required) throw new Error("Please complete " + field.title + ".");
            continue;
          }
          if (field.choices) content[field.key] = field.choices[Number(raw)];
          else if (field.type === "boolean") content[field.key] = raw === "true";
          else if (field.type === "number" || field.type === "integer") {
            const n = Number(raw);
            if (!Number.isFinite(n) || (field.type === "integer" && !Number.isSafeInteger(n))) throw new Error("Invalid number.");
            content[field.key] = n;
          } else content[field.key] = raw;
        }
      }
      await answerRunnerMcpInput(connection, sessionId, prompt.id, { action, ...(action === "accept" ? { content } : {}) });
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not submit input."); }
    finally { setBusy(false); }
  }
  return (
    <form className="rounded-lg border bg-card p-4 space-y-3" onSubmit={e => { e.preventDefault(); void send("accept"); }}>
      <div className="text-sm font-semibold">MCP server requests input ? {prompt.source}</div>
      <p className="text-sm whitespace-pre-wrap break-words">{prompt.message}</p>
      <p className="text-xs text-muted-foreground">Your answer goes to this server. Do not enter passwords, API keys or other secrets. You can decline instead.</p>
      {prompt.fields.map(field => (
        <label key={field.key} className="block space-y-1 text-sm">
          <span>{field.title}{field.required ? " *" : ""}</span>
          {field.description && <span className="block text-xs text-muted-foreground">{field.description}</span>}
          {field.choices || field.type === "boolean" ? (
            <select className="block w-full rounded border bg-background p-2" required={field.required} disabled={busy} value={values[field.key] ?? ""}
              onChange={e => setValues(old => ({ ...old, [field.key]: e.target.value }))}>
              <option value="">Select?</option>
              {field.choices ? field.choices.map((choice, i) => <option key={i} value={String(i)}>{String(choice)}</option>) :
                <><option value="true">Yes</option><option value="false">No</option></>}
            </select>
          ) : (
            <input className="block w-full rounded border bg-background p-2" type={field.type === "string" ? "text" : "number"}
              required={field.required} disabled={busy} autoComplete="off" value={values[field.key] ?? ""}
              min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={Math.min(field.maxLength ?? 8000, 8000)}
              step={field.type === "integer" ? 1 : field.type === "number" ? "any" : undefined}
              onChange={e => setValues(old => ({ ...old, [field.key]: e.target.value }))} />
          )}
        </label>
      ))}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <div className="flex gap-2">
        <button className="rounded bg-primary text-primary-foreground px-3 py-2 text-sm" disabled={busy} type="submit">Send answer</button>
        <button className="rounded border px-3 py-2 text-sm" disabled={busy} type="button" onClick={() => void send("decline")}>Decline</button>
        <button className="rounded border px-3 py-2 text-sm" disabled={busy} type="button" onClick={() => void send("cancel")}>Cancel</button>
      </div>
    </form>
  );
}
