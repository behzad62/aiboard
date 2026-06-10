import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { decrypt } from "@/lib/crypto/keys";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * One-time migration export (temporary — removed in P3). Returns the whole
 * server store with provider/custom-model keys DECRYPTED so the browser can
 * re-encrypt them under the user's passphrase. Server-encrypted keys can't be
 * decrypted client-side, so the plaintext is sent here over localhost.
 */
export async function GET() {
  const storePath = path.join(process.cwd(), "data", "store.json");
  if (!fs.existsSync(storePath)) {
    return NextResponse.json({ store: null });
  }

  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));

  const tryDecrypt = (
    encryptedKey?: string | null,
    iv?: string | null,
    authTag?: string | null
  ): string | undefined => {
    if (!encryptedKey || !iv || !authTag) return undefined;
    try {
      return decrypt({ encrypted: encryptedKey, iv, authTag });
    } catch {
      return undefined;
    }
  };

  const providerKeys = (store.providerKeys ?? []).map(
    (k: {
      encryptedKey?: string;
      iv?: string;
      authTag?: string;
      [key: string]: unknown;
    }) => ({
      ...k,
      apiKey: tryDecrypt(k.encryptedKey, k.iv, k.authTag),
    })
  );

  const customModels = (store.customModels ?? []).map(
    (m: {
      encryptedKey?: string | null;
      iv?: string | null;
      authTag?: string | null;
      [key: string]: unknown;
    }) => ({
      ...m,
      apiKey: tryDecrypt(m.encryptedKey, m.iv, m.authTag),
    })
  );

  return NextResponse.json({
    store: { ...store, providerKeys, customModels },
  });
}
