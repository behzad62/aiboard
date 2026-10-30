import { lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PermissionProfile } from "./contracts.js";
import type { ExecutionHost } from "./execution-host.js";
import type { RemoteSessionIssuer } from "./remote-auth.js";
import type { RemoteDeviceSession } from "./remote-device-store.js";
import {
  RemoteConnector,
  type RemoteConnectionState,
  type RemotePluginToolProvider,
  type RemoteTransport,
  type RemoteTransportContext,
} from "./remote-connector.js";
import type { RunnerCapabilitiesConfig } from "./runner-capabilities-config.js";
import type { RemoteDevicePolicy } from "./remote-principal.js";
import { readRunnerVersion } from "./remote-pairing.js";
import type { ProtectedLocations } from "./protected-locations.js";
import {
  closeRemoteComposition,
  composeRemoteRuntime,
  type RemoteComposition,
} from "./runner-composition.js";

/** D17 one-time notice, shown once before the first `aiboard remote` run. */
export const REMOTE_FIRST_RUN_NOTICE = [
  "AIBoard Remote: cloud agents will be able to run commands as you and read",
  "anything your account can read on this machine. There is no per-action",
  "approval by default; every call is audited locally. Restrict this device with",
  "--read-only, --only-here or --no-shell; inspect aiboard remote --audit.",
  "disconnect with Ctrl+C, or clear the saved session with:",
  "  aiboard remote --logout",
  "File-tool exclusions do not confine shell commands; they run as your OS user.",
].join("\n");

export type RemoteServiceStatus =
  | RemoteConnectionState
  | {
      readonly protocolVersion: string;
      readonly deviceId: string;
      readonly state: "logged-out";
      readonly reasonCode: "initial";
      readonly changedAt: string;
    };

export interface RemoteServiceOptions {
  readonly stateDirectory: string;
  /** Per-user device custody directory shared by every project on this machine. */
  readonly deviceDirectory: string;
  readonly workspacePath: string;
  readonly host: ExecutionHost;
  readonly permissionProfile: PermissionProfile;
  readonly capabilitiesConfig: RunnerCapabilitiesConfig;
  readonly extensionsHome?: string;
  readonly protectedLocations?: ProtectedLocations;
  readonly createTransport: (context: RemoteTransportContext) => RemoteTransport;
  readonly issuer: RemoteSessionIssuer;
  /** Real startup reconciliation (reconcileRunnerStartup) in the CLI. */
  readonly reconcileStartup?: () => Promise<void>;
  readonly now?: () => Date;
  readonly relayUrl?: string;
  readonly relayRootKeys?: readonly string[];
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly drainTimeoutMs?: number;
  readonly maxConcurrentJobsPerDevice?: number;
  readonly maxQueuedJobsPerDevice?: number;
  readonly toolDeadlineMs?: number;
  readonly cancellationGraceMs?: number;
  readonly onShutdownStep?: (step: string) => void;
  readonly pluginTools?: RemotePluginToolProvider;
  readonly policyPatch?: Partial<RemoteDevicePolicy>;
  readonly onSession?: (session: RemoteDeviceSession) => void;
  /** Every connector state change, after the status file is written (terminal notices). */
  readonly onStateChange?: (state: RemoteConnectionState) => void;
}

/**
 * Runner-owned remote service (ADR-A): device custody, admission, connector
 * and status reporting. Shutdown is ordered and retryable; the CLI registers
 * this service with closeRunnerResources so release happens last.
 */
export class RemoteService {
  readonly composition: RemoteComposition;
  private connector: RemoteConnector | undefined;
  private releaseOwnerLock: (() => void) | undefined;
  private started = false;
  private closed = false;
  private closeRequested = false;
  private closeError: unknown;

  constructor(private readonly options: RemoteServiceOptions) {
    this.composition = composeRemoteRuntime({
      stateDirectory: options.stateDirectory,
      deviceDirectory: options.deviceDirectory,
      workspacePath: options.workspacePath,
      host: options.host,
      permissionProfile: options.permissionProfile,
      capabilitiesConfig: options.capabilitiesConfig,
      ...(options.extensionsHome ? { extensionsHome: options.extensionsHome } : {}),
      ...(options.protectedLocations ? { protectedLocations: options.protectedLocations } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.relayUrl ? { relayUrl: options.relayUrl, relayRootKeys: options.relayRootKeys } : {}),
    });
  }

  status(): RemoteServiceStatus {
    const identity = this.composition.deviceStore.load();
    const session = this.safeSession();
    if (this.connector) return this.connector.state();
    if (!identity || !session) {
      return Object.freeze({
        protocolVersion: "1.0.0",
        deviceId: identity?.deviceId ?? "device-unprovisioned",
        state: "logged-out" as const,
        reasonCode: "initial" as const,
        changedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      });
    }
    if (identity.revoked) {
      return Object.freeze({
        protocolVersion: "1.0.0", deviceId: identity.deviceId, state: "revoked" as const,
        reasonCode: "device_key_revoked" as const,
        changedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      });
    }
    return Object.freeze({
      protocolVersion: "1.0.0", deviceId: identity.deviceId, state: "disconnected" as const,
      reasonCode: "initial" as const, changedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      deviceEpoch: identity.epoch,
    });
  }

  pairingUrl(): string {
    return this.options.issuer.pairingUrl;
  }

  needsNotice(): boolean {
    return !this.composition.deviceStore.noticeAcknowledged();
  }

  acknowledgeNotice(): void {
    this.composition.deviceStore.acknowledgeNotice();
  }

  hasProvisionedSession(): boolean {
    return this.safeSession() !== undefined && this.composition.deviceStore.load() !== undefined;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const deviceStore = this.composition.deviceStore;
    const release = deviceStore.acquireOwnerLock(this.options.workspacePath);
    if (!release) {
      // Another owner holds this device; refuse to admit anything.
      this.writeStatusFile({
        protocolVersion: "1.0.0",
        deviceId: deviceStore.load()?.deviceId ?? "device-unprovisioned",
        state: "suspended", reasonCode: "owner_lock_lost",
        changedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      });
      return;
    }
    this.releaseOwnerLock = release;
    let identity = deviceStore.ensure();
    if (identity.revoked) identity = deviceStore.rotateIdentity();
    let session = this.options.issuer.requiresSessionRestore ? undefined : this.safeSession();
    if (!session) {
      try {
        session = await this.options.issuer.restoreSession()
          ?? await this.options.issuer.requestSession({ deviceId: identity.deviceId, publicKey: identity.publicKey });
      } catch (error) {
        this.writeStatusFile(this.status());
        if (this.options.issuer.requiresSessionRestore) throw error;
        if (Object.keys(this.options.policyPatch ?? {}).length > 0) throw new Error("remote_policy_identity_required: Pair this device before changing its policy.");
        return;
      }
    }
    // Closed while pairing (an in-place Remote turned off): never connect after the owner lock was released.
    if (this.closeRequested) throw new Error("remote_unavailable: Remote was turned off before pairing finished.");
    identity = deviceStore.ensure(session.accountId);
    if (identity.revoked) throw new Error("Remote device is revoked.");
    deviceStore.saveSession(session);
    this.options.onSession?.(session);
    const verified = { accountId: session.accountId, clientId: session.clientId, deviceId: identity.deviceId };
    this.composition.principals.getOrCreate(verified);
    if (Object.keys(this.options.policyPatch ?? {}).length > 0) this.composition.principals.updatePolicy(verified, this.options.policyPatch!, "local");
    const admission = this.composition.admission;
    const runnerVersion = (() => { try { return readRunnerVersion(); } catch { return ""; } })();
    const platform = process.platform;
    const connector = new RemoteConnector({
      deviceStore,
      authenticator: this.composition.authenticator,
      admission,
      runtime: this.composition.runtime,
      artifacts: this.options.host.artifacts,
      auditArtifactRead: (identity, jobId, decision, outcomeCode) => {
        const principals = this.composition.principals;
        let enabled = true;
        try { enabled = principals.policy(identity).audit; } catch { /* unknown principal: audit */ }
        principals.auditStore.recordTool({ role: "remote", ...identity, toolName: "artifacts.read", decision, outcomeCode, jobId }, enabled);
      },
      auditApproval: (identity, jobId, decision) => this.composition.principals.auditStore.recordApproval(identity, jobId, decision),
      session,
      createTransport: this.options.createTransport,
      ...(this.options.pluginTools ? { pluginTools: this.options.pluginTools } : {}),
      reconcile: async () => {
        const reconciled = admission.reconcileStartup();
        for (const job of reconciled) if (job.state === "blocked_policy") {
          this.composition.principals.auditStore.recordApproval(job.principal, job.jobId, "expired");
        }
        await this.options.reconcileStartup?.();
      },
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
      ...(this.options.random ? { random: this.options.random } : {}),
      ...(this.options.drainTimeoutMs !== undefined ? { drainTimeoutMs: this.options.drainTimeoutMs } : {}),
      ...(this.options.maxConcurrentJobsPerDevice !== undefined ? { maxConcurrentJobsPerDevice: this.options.maxConcurrentJobsPerDevice } : {}),
      ...(this.options.maxQueuedJobsPerDevice !== undefined ? { maxQueuedJobsPerDevice: this.options.maxQueuedJobsPerDevice } : {}),
      ...(this.options.toolDeadlineMs !== undefined ? { toolDeadlineMs: this.options.toolDeadlineMs } : {}),
      ...(this.options.cancellationGraceMs !== undefined ? { cancellationGraceMs: this.options.cancellationGraceMs } : {}),
      isOwnerLockHeld: () => this.releaseOwnerLock !== undefined,
      onStateChange: (state) => {
        this.writeStatusFile(state);
        try { this.options.onStateChange?.(state); } catch { /* a notice can never alter the connection */ }
      },
      statusReport: () => {
        if (!runnerVersion || (platform !== "win32" && platform !== "darwin" && platform !== "linux")) return undefined;
        const { shell, approvals, readOnly, onlyHere, audit } = this.composition.principals.policy(verified);
        return { runnerVersion, platform, policy: { shell, approvals, readOnly, onlyHere, audit } };
      },
      ...(this.options.onShutdownStep ? { onShutdownStep: this.options.onShutdownStep } : {}),
    });
    this.connector = connector;
    this.writeStatusFile(connector.state());
    await connector.start();
  }

  /** True once start() holds the per-user device owner lock (taken before its first await). */
  holdsOwnerLock(): boolean { return this.releaseOwnerLock !== undefined; }

  pendingCommandApproval() { return this.connector?.pendingCommandApproval(); }

  answerCommandApproval(jobId: string, nonce: string, approved: boolean): boolean {
    return this.connector?.answerCommandApproval(jobId, nonce, approved) ?? false;
  }

  /** Test/CLI hook: the owner lock was lost underneath a running service. */
  simulateOwnerLockLoss(): void {
    const release = this.releaseOwnerLock;
    this.releaseOwnerLock = undefined;
    release?.();
    this.connector?.suspend("owner_lock_lost");
  }

  /** Ordered close. A failed step stays pending and the next call retries it. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closeRequested = true;
    try {
      if (this.connector) await this.connector.close();
      await closeRemoteComposition(this.composition);
      this.options.onShutdownStep?.("resources-released");
      const release = this.releaseOwnerLock;
      this.releaseOwnerLock = undefined;
      release?.();
      this.closed = true;
      this.closeError = undefined;
    } catch (error) {
      this.closeError = error;
      throw error;
    }
  }

  /** `remote --logout`: stop first, then clear the saved session. */
  logout(): void {
    if (this.connector && !this.closed) throw new Error("Stop the remote Runner before logging out.");
    const release = this.releaseOwnerLock;
    this.releaseOwnerLock = undefined;
    release?.();
    this.composition.deviceStore.logout();
    this.connector = undefined;
    this.started = false;
    this.writeStatusFile(this.status());
  }

  private safeSession() {
    try { return this.composition.deviceStore.loadSession(); }
    catch { return undefined; }
  }

  private writeStatusFile(status: RemoteServiceStatus): void {
    try {
      const path = join(this.options.stateDirectory, "remote-status.json");
      try { if (lstatSync(path).isSymbolicLink()) return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      writeFileSync(path, JSON.stringify(status), { mode: 0o600 });
    } catch { /* status reporting never blocks admission control */ }
  }
}
