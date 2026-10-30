import type { RemoteConnectionReason, RemoteConnectionStateName } from "./remote-connector.js";

/** Runner → launcher IPC message carrying `{ state, reasonCode }`; one constant so the two ends cannot drift. */
export const REMOTE_STATE_MESSAGE = "aiboard-remote-state";

/** Launcher line when a persisted revoke restarts the Runner into pairing with a new key. */
export const REMOTE_REPAIR_NOTICE =
  "AIBoard Remote: this computer was removed from your AIBoard account; pairing it again with a new key. Press Ctrl+C to stop instead.\n";

const STATES: ReadonlySet<string> = new Set<RemoteConnectionStateName>(
  ["disconnected", "authenticating", "connected-degraded", "tool-ready", "suspended", "revoked"]);

const SUSPENDED: Partial<Record<RemoteConnectionReason, string>> = {
  owner_lock_lost: "another AIBoard Runner took over this device",
  superseded: "another AIBoard Runner connected as this device and replaced this connection",
  local_pause: "paused on this computer",
  device_policy_expired: "this device's policy expired",
  entitlement_expired: "your AIBoard Remote plan is not active",
  recovery_unresolved: "an earlier job could not be reconciled",
  device_clone_detected: "this device's key is in use on another computer",
};

/** `[HH:MM:SS] ` in local time, so a long-running window shows when each drop and recovery happened. */
export function stampRemoteNotice(line: string, at: Date = new Date()): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `[${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}] ${line}`;
}

/**
 * Turns connector state changes into the few lines a person at the terminal
 * needs: lost / back / off for good. Transitional states print nothing.
 */
export function createRemoteStateNotices(): (state: unknown, reasonCode: unknown) => string | undefined {
  let connected = false;
  let lost = false;
  let final = false;
  const off = (why: string, next: string) => { final = true; return `AIBoard Remote: ${why}, so remote access is off. ${next}\n`; };
  return (state, reasonCode) => {
    if (final || typeof state !== "string" || !STATES.has(state) || typeof reasonCode !== "string") return undefined;
    if (state === "revoked") return off("this computer was removed from your AIBoard account", "Press Ctrl+C, then run the command again to pair it.");
    if (state === "suspended") {
      return off(SUSPENDED[reasonCode as RemoteConnectionReason] ?? "the Runner stopped accepting remote calls", "Press Ctrl+C, then run the command again.");
    }
    if (state === "disconnected") {
      // A connection that never came up does not retry; a lost one keeps trying, so its failed attempts stay quiet.
      if (reasonCode === "authentication_failed" && !connected) return off("the Runner could not connect to the relay", "Check your connection, press Ctrl+C, then run the command again.");
      if (reasonCode === "socket_lost" && connected && !lost) { lost = true; return "AIBoard Remote: lost the connection to the relay; reconnecting...\n"; }
      return undefined;
    }
    if (state === "connected-degraded" && reasonCode === "recovery_unverified") {
      return off("an earlier remote job could not be verified after reconnecting", "Press Ctrl+C, then run the command again.");
    }
    if (state === "tool-ready" || (state === "connected-degraded" && reasonCode.endsWith("_tool_unavailable"))) {
      const back = lost;
      connected = true;
      lost = false;
      return back ? "AIBoard Remote: reconnected.\n" : undefined;
    }
    return undefined;
  };
}
