"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  connectManually,
  consumeConnectFragment,
  LocalRunnerHandoffError,
} from "@/lib/client/local-runner-handoff";

type Status =
  | { state: "working"; message: string }
  | { state: "connected"; message: string }
  | { state: "partial"; message: string; failures: Array<{ kind: string; port: number; message: string }> }
  | { state: "error"; message: string; blockedByBrowser?: boolean }
  | { state: "manual"; message?: string };

export default function ConnectClient() {
  const router = useRouter();
  const startedRef = useRef(false);
  const [status, setStatus] = useState<Status>({ state: "working", message: "Checking this link…" });
  const [code, setCode] = useState("");
  const [port, setPort] = useState("");
  const [manualBusy, setManualBusy] = useState(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      const result = await consumeConnectFragment({
        location: window.location,
        history: window.history,
      });
      if (result.status === "manual") {
        setStatus({ state: "manual" });
        return;
      }
      if (result.status === "connected") {
        if (result.failures.length > 0) {
          setStatus({
            state: "partial",
            message: "Connected: " + result.sessions.map((session) => session.kind).join(", ") + ". Some Runners did not connect:",
            failures: result.failures.map((failure) => ({ kind: failure.kind, port: failure.port, message: failure.message })),
          });
          return;
        }
      setStatus({ state: "connected", message: "Connected. Opening your workspace…" });
        router.replace("/");
        return;
      }
      setStatus({
        state: "error",
        message: result.error.message,
        blockedByBrowser: result.error.kind === "unreachable",
      });
    })();
  }, [router]);

  const submitManual = async (event: React.FormEvent) => {
    event.preventDefault();
    if (manualBusy) return;
    setManualBusy(true);
    try {
      const combined = await connectManually({ code, port });
      if (combined.failures.length > 0) {
        setCode("");
        setStatus({
          state: "partial",
          message: "Connected: " + combined.peerSessions.map((session) => session.kind).join(", ") + ". Some Runners did not connect:",
          failures: combined.failures.map((failure) => ({ kind: failure.kind, port: failure.port, message: failure.message })),
        });
        setManualBusy(false);
        return;
      }
      setCode("");
      setStatus({ state: "connected", message: "Connected. Opening your workspace…" });
      router.replace("/");
    } catch (error) {
      // The code may now be consumed; never retry it automatically.
      setCode("");
      setStatus({
        state: "error",
        message: error instanceof LocalRunnerHandoffError
          ? error.message
          : "Could not connect to the Runner. Run `aiboard` again.",
        blockedByBrowser: error instanceof LocalRunnerHandoffError && error.kind === "unreachable",
      });
    } finally {
      setManualBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="space-y-2">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Connect a local Runner</h1>
        <p className="text-sm text-muted-foreground">
          This page connects this browser tab to the Runner V2 that <code>aiboard</code> started on
          your computer. The one-time code in the link is used once and removed from the address bar;
          it is never saved.
        </p>
      </div>

      {status.state === "working" && (
        <p role="status" className="rounded-lg border bg-muted/40 p-4 text-sm">{status.message}</p>
      )}
      {status.state === "connected" && (
        <p role="status" className="rounded-lg border bg-muted/40 p-4 text-sm">{status.message}</p>
      )}
      {status.state === "partial" && (
        <div role="status" className="space-y-2 rounded-lg border bg-muted/40 p-4 text-sm">
          <p>{status.message}</p>
          <ul className="list-disc space-y-1 pl-5">
            {status.failures.map((failure) => (
              <li key={failure.kind + "-" + failure.port}>{failure.kind} (port {failure.port}): {failure.message}</li>
            ))}
          </ul>
          <p>The connected Runners work in this tab. Run <code>aiboard</code> again for a new code for the rest; used codes are never retried.</p>
          <Button type="button" onClick={() => router.replace("/")}>Open workspace</Button>
        </div>
      )}
      {status.state === "error" && (
        <div role="alert" className="space-y-2 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm">
          <p>{status.message}</p>
          {status.blockedByBrowser && (
            <p>
              If your browser asked about local network access and you denied it, allow local network
              access for this site: open the site information / permissions control in the address bar
              (or your browser&apos;s local network settings), allow it, then run <code>aiboard</code> again
              and open the new link. Manual paste below cannot bypass a denied permission.
            </p>
          )}
        </div>
      )}

      <form onSubmit={submitManual} className="space-y-3 rounded-lg border p-4">
        <p className="text-sm font-medium">Connect manually</p>
        <p className="text-xs text-muted-foreground">
          If no browser opened, <code>aiboard</code> printed a code and a port in its terminal. Paste
          them here. Codes expire after about two minutes and work only once.
        </p>
        <div className="space-y-1">
          <Label htmlFor="pair-code" className="text-xs">Pairing code</Label>
          <Input
            id="pair-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="v1.…"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pair-port" className="text-xs">Runner port</Label>
          <Input
            id="pair-port"
            value={port}
            onChange={(event) => setPort(event.target.value)}
            placeholder="8787"
            inputMode="numeric"
            autoComplete="off"
          />
        </div>
        <Button type="submit" disabled={manualBusy || !code.trim() || !port.trim()}>
          {manualBusy ? "Connecting…" : "Connect"}
        </Button>
      </form>

      <p className="text-xs text-muted-foreground">
        Local development: the Runner only accepts this page from <code>http://localhost:3000</code> when
        it is started with the environment variable <code>AIBOARD_LOCAL_PAIR_DEV_ORIGIN=1</code>; production
        accepts only <code>https://aiboard.me</code>.
      </p>
    </div>
  );
}
