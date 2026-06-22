/* Self-update verify + argv-preservation (run: npx tsx scripts/test-runner-update.mts) */
import { verifyRunnerUpdate, buildPreservedArgv, RUNNER_PUBLIC_KEY } from "./runner-lib.mjs";
import { generateKeyPairSync, sign, createHash } from "node:crypto";

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
}

// Ephemeral keypair so the test doesn't depend on the committed/gitignored key.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

const bytes = Buffer.from("// runner code v9 ...\nconst VERSION = 9;\n");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const sig = sign(null, bytes, privateKey).toString("base64");

// ── verifyRunnerUpdate ───────────────────────────────────────────────────────
check("valid signed update accepted", verifyRunnerUpdate(bytes, { sha256, sig }, pubPem).ok === true);

const tampered = verifyRunnerUpdate(Buffer.from("evil bytes"), { sha256, sig }, pubPem);
check("tampered bytes rejected", tampered.ok === false);
check("  reason = sha256 mismatch", tampered.reason === "sha256 mismatch");

const otherSig = sign(null, Buffer.from("different content"), privateKey).toString("base64");
check("bad signature rejected", verifyRunnerUpdate(bytes, { sha256, sig: otherSig }, pubPem).ok === false);

const unsigned = verifyRunnerUpdate(bytes, { sha256 }, pubPem);
check("unsigned release rejected", unsigned.ok === false);
check("  reason = unsigned release", unsigned.reason === "unsigned release");

check("no manifest hash rejected", verifyRunnerUpdate(bytes, {} as { sha256: string }, pubPem).ok === false);

// Pinned key did NOT sign these bytes → must reject (defends against host swap).
check("wrong (pinned) key rejected", verifyRunnerUpdate(bytes, { sha256, sig }, RUNNER_PUBLIC_KEY).ok === false);

// ── buildPreservedArgv ───────────────────────────────────────────────────────
const argv = buildPreservedArgv({ root: "/proj", port: 8787, token: "abc", mcp: [{ name: "pw", command: "npx x" }] });
check("argv root first", argv[0] === "/proj");
check("argv emits --port even if omitted originally", argv[argv.indexOf("--port") + 1] === "8787");
check("argv emits --token even if omitted originally", argv[argv.indexOf("--token") + 1] === "abc");
check("argv reproduces --mcp", argv[argv.indexOf("--mcp") + 1] === "pw=npx x");
check("argv omits --host when not set", !argv.includes("--host"));

const argv2 = buildPreservedArgv({ root: "/p", port: 9, token: "t", host: "0.0.0.0", appOrigins: ["https://x.com"] });
check("argv emits --host when set", argv2[argv2.indexOf("--host") + 1] === "0.0.0.0");
check("argv emits --app-origin", argv2[argv2.indexOf("--app-origin") + 1] === "https://x.com");

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
