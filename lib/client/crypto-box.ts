/**
 * Passphrase-based encryption for the store blob (Web Crypto, PBKDF2 → AES-GCM).
 * The derived key is cached in memory for the tab session, so the user unlocks
 * once. Zero-knowledge: there is no passphrase recovery.
 */

export interface Envelope {
  v: 1;
  encrypted: boolean;
  salt?: string; // base64 (KDF salt)
  iv?: string; // base64 (AES-GCM nonce)
  data: string; // plaintext JSON (unencrypted) or base64 ciphertext
}

const PBKDF2_ITERATIONS = 150_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let sessionKey: CryptoKey | null = null;
let sessionSaltB64: string | null = null;

function toB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(
      ...(bytes.subarray(i, i + chunk) as unknown as number[])
    );
  }
  return btoa(binary);
}

function fromB64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export function isUnlocked(): boolean {
  return sessionKey !== null;
}

export function lock(): void {
  sessionKey = null;
  sessionSaltB64 = null;
}

/** Set/establish a passphrase. Returns the new salt (base64) to persist in config. */
export async function setPassphrase(passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  sessionKey = await deriveKey(passphrase, salt);
  sessionSaltB64 = toB64(salt.buffer);
  return sessionSaltB64;
}

/** Unlock with an existing passphrase against a stored salt. Throws on bad passphrase only at decrypt time. */
export async function unlock(passphrase: string, saltB64: string): Promise<void> {
  sessionKey = await deriveKey(passphrase, fromB64(saltB64));
  sessionSaltB64 = saltB64;
}

export async function wrap(
  plaintextJson: string,
  encrypt: boolean
): Promise<Envelope> {
  if (!encrypt) return { v: 1, encrypted: false, data: plaintextJson };
  if (!sessionKey || !sessionSaltB64) {
    throw new Error("Store is locked — set or enter the passphrase first.");
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    sessionKey,
    encoder.encode(plaintextJson)
  );
  return {
    v: 1,
    encrypted: true,
    salt: sessionSaltB64,
    iv: toB64(iv.buffer),
    data: toB64(ciphertext),
  };
}

export async function unwrap(env: Envelope): Promise<string> {
  if (!env.encrypted) return env.data;
  if (!env.iv) throw new Error("Malformed encrypted store.");
  if (!sessionKey) {
    throw new Error("Store is locked — enter the passphrase to unlock.");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(env.iv) },
    sessionKey,
    fromB64(env.data)
  );
  return decoder.decode(plaintext);
}

export function parseEnvelope(raw: string): Envelope | null {
  try {
    const parsed = JSON.parse(raw) as Envelope;
    if (parsed && typeof parsed === "object" && "encrypted" in parsed) {
      return parsed;
    }
  } catch {
    // not an envelope
  }
  return null;
}
