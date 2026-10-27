import { createPublicKey, verify as cryptoVerify } from "node:crypto";

import { canonicalJson, type RemoteRequest } from "./remote-admission-store.js";
import type { RemoteDeviceSession, RemoteDeviceStore } from "./remote-device-store.js";

/** Relay identity the Runner expects in every challenge (D12). */
export const REMOTE_RELAY_AUDIENCE = "mcp.aiboard.me";
/** The only scope a device connection may claim in R1. */
export const REMOTE_CONNECT_SCOPE = "aiboard.remote";
/** Longest accepted challenge/request lifetime; the contracts set none, so R1 fixes it here. */
const MAX_LIFETIME_MS = 5 * 60_000;
/** Tolerated relay clock lead for a request's issuedAt. */
const CLOCK_SKEW_MS = 60_000;
/** Live nonces kept per cache; at capacity new ones are refused, never evicted early. */
const MAX_LIVE_NONCES = 4096;
/** P1-gated stub: real pairing/claim issuance is not built yet. */
export const STUB_REMOTE_PAIRING_URL = "https://mcp.aiboard.me/pair";

export interface RelayChallenge {
  readonly audience: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly scope: string;
  readonly nonce: string;
  readonly epoch: string;
  readonly expiresAt: string;
}

export interface DeviceProof {
  readonly deviceId: string;
  readonly publicKey: string;
  readonly signature: string;
}

export type RemoteAuthCode =
  | "unauthorized" | "device_epoch_mismatch" | "expired_request" | "device_revoked" | "invalid_request";

export class RemoteAuthError extends Error {
  constructor(readonly code: RemoteAuthCode, message: string) {
    super(message);
    this.name = "RemoteAuthError";
  }
}

/**
 * Injected claim issuer. P1 provides the real relay implementation; R1 ships
 * only this interface plus a stub that fails closed. No network calls here.
 */
export interface RemoteSessionIssuer {
  readonly pairingUrl: string;
  requestSession(identity: { deviceId: string; publicKey: string }): Promise<RemoteDeviceSession>;
  restoreSession(): Promise<RemoteDeviceSession | undefined>;
}

export class StubRemoteSessionIssuer implements RemoteSessionIssuer {
  readonly pairingUrl = STUB_REMOTE_PAIRING_URL;

  async requestSession(): Promise<RemoteDeviceSession> {
    throw new RemoteAuthError("unauthorized", "Remote pairing is unavailable until the relay identity service (P1) is built.");
  }

  async restoreSession(): Promise<RemoteDeviceSession | undefined> {
    return undefined;
  }
}

/** Canonical bytes both sides sign and verify; field order is fixed by RFC 8785. */
export function canonicalChallenge(challenge: RelayChallenge): Buffer {
  return Buffer.from(canonicalJson({
    audience: challenge.audience, accountId: challenge.accountId, deviceId: challenge.deviceId,
    scope: challenge.scope, nonce: challenge.nonce, epoch: challenge.epoch, expiresAt: challenge.expiresAt,
  }), "utf8");
}

/** Relay-side check (and test oracle) that a proof was made by the device key. */
export function verifyDeviceProof(publicKey: string, challenge: RelayChallenge, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64url"), type: "spki", format: "der" });
    return cryptoVerify(null, canonicalChallenge(challenge), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export interface RemoteAuthenticatorOptions {
  readonly now?: () => Date;
  readonly expectedAudience?: string;
  readonly expectedScope?: string;
}

/**
 * Runner-side verification of relay messages (ADR-A): audience, account,
 * device, scope, expiry, nonce replay and epoch fencing are all checked
 * locally before admission. The connector signs; it never trusts the relay.
 */
export class RemoteAuthenticator {
  private readonly now: () => Date;
  private readonly expectedAudience: string;
  private readonly expectedScope: string;
  private readonly seenChallengeNonces = new Map<string, number>();
  private readonly seenRequestNonces = new Map<string, number>();

  constructor(
    private readonly deviceStore: RemoteDeviceStore,
    options: RemoteAuthenticatorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.expectedAudience = options.expectedAudience ?? REMOTE_RELAY_AUDIENCE;
    this.expectedScope = options.expectedScope ?? REMOTE_CONNECT_SCOPE;
  }

  validateChallenge(challenge: RelayChallenge, session: RemoteDeviceSession): void {
    const identity = this.deviceStore.load();
    if (!identity) throw new RemoteAuthError("unauthorized", "Remote device is not provisioned.");
    if (identity.revoked) throw new RemoteAuthError("device_revoked", "Remote device is revoked.");
    if (!challenge || typeof challenge !== "object") throw new RemoteAuthError("invalid_request", "Relay challenge is invalid.");
    if (challenge.audience !== this.expectedAudience) {
      throw new RemoteAuthError("unauthorized", "Relay challenge audience does not match the relay identity.");
    }
    if (challenge.accountId !== session.accountId || challenge.accountId !== identity.accountId) {
      throw new RemoteAuthError("unauthorized", "Relay challenge account does not match this device.");
    }
    if (challenge.deviceId !== identity.deviceId) {
      throw new RemoteAuthError("unauthorized", "Relay challenge device does not match this device.");
    }
    if (challenge.scope !== this.expectedScope || challenge.scope !== session.scope) {
      throw new RemoteAuthError("unauthorized", "Relay challenge scope does not match the device session.");
    }
    if (typeof challenge.nonce !== "string" || !challenge.nonce || challenge.nonce.length > 512) {
      throw new RemoteAuthError("invalid_request", "Relay challenge nonce is invalid.");
    }
    if (typeof challenge.epoch !== "string" || !/^[1-9][0-9]{0,18}$/.test(challenge.epoch)) {
      throw new RemoteAuthError("device_epoch_mismatch", "Relay challenge epoch is invalid.");
    }
    if (BigInt(challenge.epoch) < BigInt(identity.epoch)) {
      throw new RemoteAuthError("device_epoch_mismatch", "Relay challenge epoch is stale.");
    }
    const expiresAt = typeof challenge.expiresAt === "string" ? Date.parse(challenge.expiresAt) : Number.NaN;
    if (!Number.isFinite(expiresAt)) throw new RemoteAuthError("invalid_request", "Relay challenge expiry is invalid.");
    if (expiresAt <= this.now().getTime()) throw new RemoteAuthError("expired_request", "Relay challenge has expired.");
    if (expiresAt > this.now().getTime() + MAX_LIFETIME_MS) {
      throw new RemoteAuthError("invalid_request", "Relay challenge lifetime is too long.");
    }
    this.checkReplay(this.seenChallengeNonces, challenge.nonce, "Relay challenge nonce was already used.");
  }

  /** Validate, fence the epoch forward, remember the nonce, then sign. */
  answerChallenge(challenge: RelayChallenge, session: RemoteDeviceSession): DeviceProof {
    this.validateChallenge(challenge, session);
    const identity = this.deviceStore.load()!;
    this.deviceStore.advanceEpochTo(challenge.epoch);
    this.seenChallengeNonces.set(challenge.nonce, Date.parse(challenge.expiresAt));
    const signature = this.deviceStore.sign(canonicalChallenge(challenge));
    return Object.freeze({
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      signature: signature.toString("base64url"),
    });
  }

  /** Per-request fence: identity, current epoch, expiry and nonce replay. */
  verifyRequest(request: RemoteRequest, session: RemoteDeviceSession): void {
    const identity = this.deviceStore.load();
    if (!identity) throw new RemoteAuthError("unauthorized", "Remote device is not provisioned.");
    if (identity.revoked) throw new RemoteAuthError("device_revoked", "Remote device is revoked.");
    if (request.accountId !== session.accountId || request.accountId !== identity.accountId) {
      throw new RemoteAuthError("unauthorized", "Remote request account does not match this device.");
    }
    if (request.deviceId !== identity.deviceId) {
      throw new RemoteAuthError("unauthorized", "Remote request device does not match this device.");
    }
    if (request.deviceEpoch !== identity.epoch) {
      throw new RemoteAuthError("device_epoch_mismatch", "Remote request epoch is not current.");
    }
    const now = this.now().getTime();
    const issuedAt = typeof request.issuedAt === "string" ? Date.parse(request.issuedAt) : Number.NaN;
    const expiresAt = typeof request.expiresAt === "string" ? Date.parse(request.expiresAt) : Number.NaN;
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > expiresAt) {
      throw new RemoteAuthError("invalid_request", "Remote request lifetime is invalid.");
    }
    if (expiresAt <= now) throw new RemoteAuthError("expired_request", "Remote request has expired.");
    if (issuedAt > now + CLOCK_SKEW_MS || expiresAt - issuedAt > MAX_LIFETIME_MS || expiresAt > now + MAX_LIFETIME_MS + CLOCK_SKEW_MS) {
      throw new RemoteAuthError("invalid_request", "Remote request lifetime is too long or issued in the future.");
    }
    this.checkReplay(this.seenRequestNonces, request.nonce, "Remote request nonce was already used.");
    this.seenRequestNonces.set(request.nonce, expiresAt);
  }

  /**
   * Nonces are remembered until they expire and are never evicted early: a
   * full cache of live nonces refuses new ones instead of reopening replay.
   */
  private checkReplay(seen: Map<string, number>, nonce: string, message: string): void {
    const now = this.now().getTime();
    for (const [entry, until] of seen) if (until <= now) seen.delete(entry);
    const seenUntil = seen.get(nonce);
    if (seenUntil !== undefined && seenUntil > now) throw new RemoteAuthError("unauthorized", message);
    if (seen.size >= MAX_LIVE_NONCES) throw new RemoteAuthError("unauthorized", "Too many live remote nonces; retry shortly.");
  }
}
