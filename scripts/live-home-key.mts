/**
 * Where the opt-in live provider scripts find a key (Simple Build plan §17 item 18, packet HM6).
 * Keys live in the AIBoard home (`~/.aiboard`, or `AIBOARD_HOME`), not in a browser store, so a live
 * script reads the home the way `aiboard config` does: read-only, through the Runner's own reader,
 * which returns a key only while it is bound to the provider's current upstream.
 *
 * The result never carries a key hint, and callers never print the key.
 */
import { homedir } from "node:os";

import { resolveAiboardHome } from "../runner-v2/src/aiboard-home-paths.js";
import { readAiboardHomeSync } from "../runner-v2/src/aiboard-home-store.js";

export type LiveHomeKey =
  | { found: true; key: string; source: "env" | "home"; baseUrl: string | null }
  | { found: false; reason: string };

/**
 * The key for `providerId`: `envName` when it is set, else the AIBoard home's saved key. A home that
 * cannot be read (another computer's keys, an unsafe AIBOARD_HOME) is a skip reason, never a throw.
 */
export function liveProviderKey(providerId: string, envName: string, env: NodeJS.ProcessEnv = process.env): LiveHomeKey {
  const fromEnv = env[envName]?.trim();
  if (fromEnv) return { found: true, key: fromEnv, source: "env", baseUrl: null };
  try {
    const location = resolveAiboardHome({ platform: process.platform, environment: env, home: homedir() });
    const home = readAiboardHomeSync(location);
    if (!home.exists) return { found: false, reason: `no ${envName} and no AIBoard home at ${location.home}` };
    const key = home.secret(`credentials.providers.${providerId}`)?.trim();
    if (!key) return { found: false, reason: `no ${envName} and no ${providerId} key in the AIBoard home (aiboard keys set ${providerId})` };
    const baseUrl = home.config.providers[providerId]?.baseUrl;
    return { found: true, key, source: "home", baseUrl: typeof baseUrl === "string" && baseUrl ? baseUrl : null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { found: false, reason: `no ${envName}, and the AIBoard home cannot be read (${message.split(":")[0]})` };
  }
}
