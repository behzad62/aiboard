/* Guard/auth helper checks (run: npx tsx scripts/test-runner-guard.mts) */
import {
  tokensMatch,
  isAllowedHost,
  isAllowedOrigin,
  defaultAppOrigins,
} from "./runner-lib.mjs";

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
}

// ── tokensMatch ──────────────────────────────────────────────────────────────
check("tokensMatch equal", tokensMatch("abc123", "abc123") === true);
check("tokensMatch differ", tokensMatch("abc123", "abc124") === false);
check("tokensMatch length mismatch (no throw)", tokensMatch("abc", "abcd") === false);
check("tokensMatch empty differ", tokensMatch("", "x") === false);
check("tokensMatch non-string", tokensMatch(undefined as unknown as string, "x") === false);

// ── isAllowedHost ────────────────────────────────────────────────────────────
const loop = { port: 8787 };
check("host 127.0.0.1", isAllowedHost("127.0.0.1:8787", loop) === true);
check("host localhost", isAllowedHost("localhost:8787", loop) === true);
check("host [::1]", isAllowedHost("[::1]:8787", loop) === true);
check("host wrong port", isAllowedHost("127.0.0.1:9999", loop) === false);
check("host evil", isAllowedHost("evil.com:8787", loop) === false);
check("host empty", isAllowedHost("", loop) === false);
const networked = { port: 8787, host: "0.0.0.0" };
check("host bound 0.0.0.0", isAllowedHost("0.0.0.0:8787", networked) === true);
check("host bound rejects loopback-only attacker hostname", isAllowedHost("attacker.local:8787", networked) === false);

// ── isAllowedOrigin ──────────────────────────────────────────────────────────
const origins = defaultAppOrigins(["https://my-self-host.example"]);
check("origin absent (nav)", isAllowedOrigin(undefined, origins) === true);
check("origin null string", isAllowedOrigin("null", origins) === true);
check("origin aiboard.me", isAllowedOrigin("https://aiboard.me", origins) === true);
check("origin localhost dev", isAllowedOrigin("http://localhost:3000", origins) === true);
check("origin 127.0.0.1 dev", isAllowedOrigin("http://127.0.0.1:3000", origins) === true);
check("origin app-origin extra", isAllowedOrigin("https://my-self-host.example", origins) === true);
check("origin evil rejected", isAllowedOrigin("https://evil.com", origins) === false);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
