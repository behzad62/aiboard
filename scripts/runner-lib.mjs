// runner-lib.mjs — pure, dependency-free helpers for the runner.
//
// These live in their own module so they can be unit-tested directly (the main
// runner.mjs has top-level side effects: it parses argv and starts a server).
// `scripts/build-runner.mjs` inlines this module into the single-file
// `public/runner.mjs` that the app serves for download, so the runner still
// distributes as ONE file. Keep this module free of any non-builtin imports.

import path from "node:path";
import fs from "node:fs";
import { timingSafeEqual, randomBytes, createHash, verify } from "node:crypto";

// ── Auth ─────────────────────────────────────────────────────────────────────

/** Constant-time string compare. Returns false on length mismatch (no throw). */
export function tokensMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ── Request guard (DNS-rebinding / CSRF defense) ─────────────────────────────

/**
 * Allow only the addresses we actually bind. Defeats DNS-rebinding: a malicious
 * page that rebinds a hostname to the runner's IP still sends a foreign Host.
 * `bound.host` is the configured --host (or undefined for the loopback default).
 */
export function isAllowedHost(hostHeader, bound) {
  if (typeof hostHeader !== "string" || !hostHeader) return false;
  const port = String(bound?.port ?? "");
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  if (bound?.host) {
    allowed.add(`${bound.host}:${port}`);
    // A bound host given without a port (rare) — accept the bare host too.
    allowed.add(String(bound.host));
  }
  return allowed.has(hostHeader);
}

/**
 * When an Origin header is present it must be in the allowlist. A request with
 * NO Origin (a top-level navigation to the shell, or a same-origin request) is
 * allowed here and still Host-gated by the caller. `appOrigins` is the set of
 * known app origins (prod + local dev + any --app-origin), plus the runner's
 * own origin which the caller adds.
 */
export function isAllowedOrigin(originHeader, appOrigins) {
  if (originHeader === undefined || originHeader === null || originHeader === "" || originHeader === "null") {
    return true; // no Origin → top-level navigation / same-origin
  }
  return appOrigins instanceof Set ? appOrigins.has(originHeader) : appOrigins.includes(originHeader);
}

/** Loopback hosts that need no extra protection (TLS / LNA prompt). */
export function isLoopbackHost(host) {
  return !host || host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/**
 * A token strong enough to expose over a network: long and not trivially
 * low-entropy. The default randomBytes(16) → 32 hex chars passes; a short or
 * repetitive --token fails so `--host` (non-loopback) refuses to start.
 */
export function isStrongToken(token) {
  if (typeof token !== "string" || token.length < 24) return false;
  return new Set(token).size >= 8;
}

/**
 * Whether the Host header passes the request guard. For the loopback default we
 * enforce the strict allowlist (defeats DNS-rebinding). For a non-loopback --host
 * bind the endpoint is intentionally public and usually reached through a tunnel
 * that sets its own Host, so the Host header is not a reliable signal — there we
 * rely on the Origin allowlist + token instead and accept any Host.
 */
export function hostGuardPasses(hostHeader, bound) {
  if (!isLoopbackHost(bound && bound.host)) return true;
  return isAllowedHost(hostHeader, bound);
}

/** Default app origins the runner trusts (prod + local dev). */
export function defaultAppOrigins(extra = []) {
  const base = [
    "https://aiboard.me",
    "https://www.aiboard.me",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ];
  return new Set([...base, ...extra.filter(Boolean)]);
}

// ── Filesystem confinement ───────────────────────────────────────────────────

const WINDOWS_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** Realpath the nearest existing ancestor of `abs`, re-appending the missing tail. */
function realpathNearest(abs) {
  let dir = abs;
  const tail = [];
  // Walk up until an existing path is found.
  while (true) {
    try {
      const real = fs.realpathSync(dir);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return abs; // reached the volume root, nothing exists
      tail.push(path.basename(dir));
      dir = parent;
    }
  }
}

/**
 * Resolve `target` (relative or absolute) against `boundary` and return the
 * canonical absolute path ONLY if it stays inside `boundary`; otherwise throw.
 * Realpath resolution defeats symlink/junction escapes; the trailing path.sep
 * makes `/srv/rootEVIL` fail a `/srv/root` boundary.
 */
export function confine(boundary, target) {
  if (typeof target !== "string" || target.includes("\0")) {
    throw new Error("Invalid path");
  }
  // Reject Windows reserved device names in any segment.
  for (const seg of target.split(/[\\/]+/)) {
    const base = seg.split(".")[0].toUpperCase();
    if (WINDOWS_RESERVED.has(base)) throw new Error(`Reserved name: ${seg}`);
  }
  const realBoundary = fs.realpathSync(boundary);
  const abs = path.resolve(realBoundary, target);
  const real = realpathNearest(abs);
  const withSep = realBoundary.endsWith(path.sep) ? realBoundary : realBoundary + path.sep;
  const norm = process.platform === "win32" ? real.toLowerCase() : real;
  const normBoundary = process.platform === "win32" ? realBoundary.toLowerCase() : realBoundary;
  const normWithSep = process.platform === "win32" ? withSep.toLowerCase() : withSep;
  if (norm === normBoundary || norm.startsWith(normWithSep)) return real;
  throw new Error(`Path escapes the allowed root: ${target}`);
}

/** Subdirectories of `dir` as {name, path}[]. Errors → []. Hidden dirs included but flagged. */
export function listDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(dir, e.name)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) out.push({ name: e.name, path: path.join(dir, e.name), hidden: e.name.startsWith(".") });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Top-level roots for the folder browser: ['/'] on POSIX, or the existing
 * Windows drive letters (probed in parallel with a short timeout so a
 * disconnected/removable drive never stalls the browser).
 */
export async function driveRoots() {
  if (process.platform !== "win32") return [{ name: "/", path: "/" }];
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const probe = (letter) =>
    new Promise((resolve) => {
      const root = `${letter}:\\`;
      const timer = setTimeout(() => resolve(null), 400);
      fs.promises
        .opendir(root)
        .then((d) => d.close())
        .then(() => {
          clearTimeout(timer);
          resolve({ name: `${letter}:`, path: root });
        })
        .catch(() => {
          clearTimeout(timer);
          resolve(null);
        });
    });
  const results = await Promise.all(letters.map(probe));
  return results.filter(Boolean);
}

// ── Structured logging ───────────────────────────────────────────────────────

/**
 * In-memory log with a capped ring buffer, monotonic seq, live subscribers (for
 * SSE), and a `format` that reproduces the legacy one-line stdout string. The
 * runner tees console.* through `log` so the terminal output stays unchanged
 * while the panel gets a structured, replayable feed.
 */
export function createLog({ capacity = 2000 } = {}) {
  const buf = [];
  let seq = 0;
  const subscribers = new Set();

  function log(event) {
    seq += 1;
    const e = {
      level: "info",
      category: "sys",
      msg: "",
      ...event,
      seq,
      ts: event && event.ts ? event.ts : new Date().toISOString(),
    };
    buf.push(e);
    if (buf.length > capacity) buf.shift();
    for (const fn of subscribers) {
      try {
        fn(e);
      } catch {
        /* a broken subscriber must not break logging */
      }
    }
    return e;
  }

  /** Events with seq greater than `sinceSeq`. */
  function snapshot(sinceSeq = 0) {
    return buf.filter((e) => e.seq > sinceSeq);
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  /** Legacy one-line representation (what used to go to stdout). */
  function format(e) {
    return e && typeof e.msg === "string" ? e.msg : String(e?.msg ?? "");
  }

  return {
    log,
    snapshot,
    subscribe,
    format,
    get lastSeq() {
      return seq;
    },
  };
}

// ── Self-update verification ─────────────────────────────────────────────────

/**
 * Ed25519 public key pinned in the shipped runner. Self-updates must carry a
 * signature made with the matching private key (held only in the release
 * pipeline), so a compromised download host alone cannot push malicious code —
 * SHA-256 is integrity, the signature is authenticity.
 */
export const RUNNER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAs7Snl8aCmKSnmXp1l1ZTWeOriwAHCuCL8XJCRi3kycI=
-----END PUBLIC KEY-----`;

/**
 * Verify downloaded runner bytes against the manifest: SHA-256 must match AND
 * the Ed25519 signature (over the raw bytes) must verify against the pinned key.
 * Returns {ok:true} or {ok:false, reason}.
 */
export function verifyRunnerUpdate(bytes, manifest, publicKeyPem = RUNNER_PUBLIC_KEY) {
  if (!manifest || typeof manifest.sha256 !== "string") {
    return { ok: false, reason: "manifest missing sha256" };
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== manifest.sha256) return { ok: false, reason: "sha256 mismatch" };
  if (typeof manifest.sig !== "string" || !manifest.sig) {
    return { ok: false, reason: "unsigned release" };
  }
  let sigOk = false;
  try {
    sigOk = verify(null, Buffer.from(bytes), publicKeyPem, Buffer.from(manifest.sig, "base64"));
  } catch {
    sigOk = false;
  }
  return sigOk ? { ok: true } : { ok: false, reason: "signature invalid" };
}

/**
 * Rebuild the runner's argv from parsed values so a self-update re-exec preserves
 * the bound state. ALWAYS emits --port and --token (even if originally omitted),
 * or the paired app's saved token silently breaks. Emits --no-default-mcp and the
 * exact current MCP set so a removed/disabled default is not resurrected.
 */
export function buildPreservedArgv({ root, port, token, host, mcp = [], appOrigins = [] }) {
  const argv = [root, "--port", String(port), "--token", token, "--no-default-mcp"];
  if (host) argv.push("--host", host);
  for (const m of mcp) argv.push("--mcp", `${m.name}=${m.command}`);
  for (const o of appOrigins) argv.push("--app-origin", o);
  return argv;
}

/**
 * Short-lived, single-use nonces. EventSource can't send the auth header, so the
 * panel mints a nonce via an authenticated POST and passes it on the SSE URL.
 */
export function createNonceStore({ ttlMs = 30_000 } = {}) {
  const nonces = new Map(); // nonce -> expiry ms
  function mint() {
    const n = randomBytes(18).toString("hex");
    nonces.set(n, Date.now() + ttlMs);
    return n;
  }
  function consume(n) {
    if (typeof n !== "string") return false;
    const exp = nonces.get(n);
    if (exp === undefined) return false;
    nonces.delete(n); // single-use regardless of validity
    return exp > Date.now();
  }
  return { mint, consume };
}
