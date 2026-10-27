"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { NativeRunnerConnection } from "@/lib/client/runner-v2";
import {
  approveExtensionOperation,
  beginExtensionSignIn,
  declineExtensionOperation,
  submitExtensionCredential,
  type AccessSummaryDto,
  type ExtensionOperationDto,
} from "@/lib/client/runner-extensions";

const OUTCOME_LABELS: Record<ExtensionOperationDto["outcome"], string> = {
  running: "In progress",
  awaiting_user: "Needs you",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  outcome_unknown: "Outcome unknown",
  rolled_back: "Rolled back",
};

/**
 * One installation operation, shown identically in Settings and in a chat. Only this card can approve,
 * choose or collect a secret: the agent that requested the change cannot.
 */
export function OperationCard({
  connection,
  operation,
  onChanged,
}: {
  connection: NativeRunnerConnection;
  operation: ExtensionOperationDto;
  onChanged: (operation?: ExtensionOperationDto) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const action = operation.userAction;
  const name = operation.target.name ?? operation.plan?.name ?? "extension";
  const requester = operation.owner.kind === "agent" ? `Requested by an AI agent (${operation.owner.actorRole})` : "Requested from Settings";

  const run = async (work: () => Promise<ExtensionOperationDto | undefined>) => {
    setBusy(true);
    setError(null);
    try {
      onChanged(await work());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const tone = operation.outcome === "succeeded" ? "success" : operation.outcome === "awaiting_user" ? "warning" : ["failed", "outcome_unknown", "rolled_back"].includes(operation.outcome) ? "destructive" : "secondary";

  return (
    <div className="rounded-lg border bg-background/40 p-4 text-sm" role="group" aria-label={`${operation.action} ${name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {capitalize(operation.action)} {name}
        </span>
        <Badge variant={tone}>{OUTCOME_LABELS[operation.outcome]}</Badge>
        <span className="text-xs text-muted-foreground">{requester}</span>
      </div>
      {operation.outcome === "running" && (
        <p className="mt-2 text-muted-foreground">Stage: {operation.stage.replaceAll("_", " ")}</p>
      )}
      {action?.kind === "approve" && (
        <div className="mt-3 space-y-3">
          <p>{action.reason}</p>
          <AccessSummary access={action.summary} />
          {operation.plan?.warnings.length ? (
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {operation.plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => run(() => approveExtensionOperation(connection, operation.id, action.planDigest))}>
              Approve
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => declineExtensionOperation(connection, operation.id))}>
              Decline
            </Button>
          </div>
        </div>
      )}
      {action?.kind === "credential" && (
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              for (const credential of action.names) {
                const value = secrets[credential]?.trim();
                if (value) await submitExtensionCredential(connection, operation.id, credential, value);
              }
              setSecrets({});
              return undefined;
            });
          }}
        >
          <p>{action.reason}</p>
          {action.names.map((credential) => (
            <div key={credential} className="space-y-1">
              <Label htmlFor={`${operation.id}-${credential}`}>{credential}</Label>
              <Input
                id={`${operation.id}-${credential}`}
                type="password"
                autoComplete="off"
                value={secrets[credential] ?? ""}
                onChange={(event) => setSecrets((current) => ({ ...current, [credential]: event.target.value }))}
              />
            </div>
          ))}
          <p className="text-xs text-muted-foreground">Stored encrypted on the Runner. It is never shown to models, saved in this browser or included in exports.</p>
          <Button size="sm" type="submit" disabled={busy}>Save and continue</Button>
        </form>
      )}
      {action?.kind === "sign_in" && (
        <div className="mt-3 space-y-2">
          <p>{action.reason}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => run(async () => {
              const { url } = await beginExtensionSignIn(connection, operation.id);
              // The sign-in page opens in a new tab; the Runner finishes this same operation when it returns.
              window.open(url, "_blank", "noopener");
              return undefined;
            })}>Sign in to {action.server}</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => declineExtensionOperation(connection, operation.id))}>Not now</Button>
          </div>
          <p className="text-xs text-muted-foreground">Tokens stay on the Runner; they are never shown to models or saved in this browser.</p>
        </div>
      )}
      {operation.result?.readiness && operation.outcome !== "awaiting_user" && (
        <p className="mt-2 text-muted-foreground">
          Readiness: {operation.result.readiness.state.replaceAll("_", " ")}
          {operation.result.generation !== undefined ? ` · generation ${operation.result.generation}` : ""}
        </p>
      )}
      {operation.diagnostics.length > 0 && operation.outcome !== "succeeded" && (
        <p className="mt-2 break-words text-xs text-muted-foreground">{operation.diagnostics.at(-1)}</p>
      )}
      {error && <p className="mt-2 text-xs text-destructive" role="alert">{error}</p>}
    </div>
  );
}

export function AccessSummary({ access }: { access: AccessSummaryDto }) {
  const code = access.executesCode === "never"
    ? "Runs no code: instructions and files only."
    : access.executesCode === "on_use"
      ? "Runs code on this machine when its tools are used."
      : "Runs code on this machine during installation and when its tools are used.";
  return (
    <dl className="grid gap-1 rounded-md bg-muted/60 p-3 text-xs sm:grid-cols-[auto,1fr] sm:gap-x-3">
      <dt className="font-medium">Code</dt>
      <dd>{code}</dd>
      <dt className="font-medium">Files</dt>
      <dd>{access.filesystem}</dd>
      {access.network.length > 0 && (
        <>
          <dt className="font-medium">Network</dt>
          <dd>{access.network.join(", ")}</dd>
        </>
      )}
      {access.credentials.length > 0 && (
        <>
          <dt className="font-medium">Credentials</dt>
          <dd>{access.credentials.join(", ")}</dd>
        </>
      )}
      {access.notes.map((note) => (
        <dd key={note} className="sm:col-span-2 text-muted-foreground">{note}</dd>
      ))}
    </dl>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).replaceAll("_", " ");
}
