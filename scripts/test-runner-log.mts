/* createLog/createNonceStore checks (run: npx tsx scripts/test-runner-log.mts) */
import { createLog, createNonceStore } from "./runner-lib.mjs";

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
}

// ── createLog ────────────────────────────────────────────────────────────────
const L = createLog({ capacity: 3 });
const e1 = L.log({ level: "info", category: "sys", msg: "hello" });
check("log returns event with seq 1", e1.seq === 1);
check("log sets ts", typeof e1.ts === "string" && e1.ts.length > 0);
check("format reproduces legacy line", L.format(e1) === "hello");

L.log({ msg: "two" });
L.log({ msg: "three" });
check("snapshot(0) returns all 3", L.snapshot(0).length === 3);
check("snapshot(1) returns 2", L.snapshot(1).length === 2);
check("lastSeq is 3", L.lastSeq === 3);

L.log({ msg: "four" }); // capacity 3 → evicts seq 1
const snap = L.snapshot(0);
check("ring buffer capped at 3", snap.length === 3);
check("oldest evicted (first is seq 2)", snap[0].seq === 2);

// subscribe
let got: string | null = null;
const unsub = L.subscribe((e) => {
  got = e.msg;
});
L.log({ msg: "live" });
check("subscriber received event", got === "live");
unsub();
got = null;
L.log({ msg: "after-unsub" });
check("unsubscribed receives nothing", got === null);

// defaults
const d = L.log({ msg: "x" });
check("default level info", d.level === "info");
check("default category sys", d.category === "sys");

// ── createNonceStore ─────────────────────────────────────────────────────────
const N = createNonceStore({ ttlMs: 1000 });
const n = N.mint();
check("nonce minted", typeof n === "string" && n.length > 0);
check("nonce consumes once", N.consume(n) === true);
check("nonce single-use (2nd fails)", N.consume(n) === false);
check("unknown nonce fails", N.consume("nope") === false);
check("non-string nonce fails", N.consume(undefined as unknown as string) === false);

const N2 = createNonceStore({ ttlMs: -1 }); // already expired
const expired = N2.mint();
check("expired nonce fails", N2.consume(expired) === false);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
