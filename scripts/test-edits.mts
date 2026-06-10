/** Regression check for ```edit``` blocks (run: npx tsx scripts/test-edits.mts) */
import { applyEditOps, extractArtifacts } from "../lib/artifacts/extract";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

// 1. Edit block extraction — not mistaken for a full file.
const message = [
  "Small fix to the clock:",
  "```edit path=js/clock.js",
  "<<<<<<< SEARCH",
  "  timeEl.textContent = now.toLocaleTimeString();",
  "=======",
  "  const hours = String(now.getHours()).padStart(2, '0');",
  "  timeEl.textContent = `${hours}:00`;",
  ">>>>>>> REPLACE",
  "```",
  "And a brand new file:",
  "```js path=js/new.js",
  "export const x = 1;",
  "```",
].join("\n");

const { files, edits } = extractArtifacts(message);
check("edit block extracted", edits.length === 1 && edits[0].path === "js/clock.js" && edits[0].ops.length === 1, edits);
check("edit block NOT treated as a file", files.length === 1 && files[0].path === "js/new.js", files.map((f) => f.path));

// 2. Exact application.
const original = [
  "export function initClock(el) {",
  "  const update = () => {",
  "  timeEl.textContent = now.toLocaleTimeString();",
  "  };",
  "}",
].join("\n");
const applied = applyEditOps(original, edits[0].ops);
check("exact match applies", applied.applied === 1 && applied.failed === 0 && applied.content.includes("padStart"), applied);
check("untouched lines preserved", applied.content.startsWith("export function initClock(el) {"), applied.content);

// 3. Whitespace-tolerant fallback (model lost the indentation).
const sloppy = applyEditOps(original, [
  { search: "timeEl.textContent = now.toLocaleTimeString();", replace: "  CHANGED();" },
]);
check("fuzzy line match applies", sloppy.applied === 1 && sloppy.content.includes("CHANGED();"), sloppy);

// 4. Non-matching search fails safely without corrupting the file.
const miss = applyEditOps(original, [{ search: "not in the file at all", replace: "x" }]);
check("missing search fails safely", miss.applied === 0 && miss.failed === 1 && miss.content === original, miss);

// 5. Multiple ops in one block, applied in order.
const multi = extractArtifacts([
  "```edit path=a.txt",
  "<<<<<<< SEARCH",
  "one",
  "=======",
  "ONE",
  ">>>>>>> REPLACE",
  "<<<<<<< SEARCH",
  "two",
  "=======",
  "TWO",
  ">>>>>>> REPLACE",
  "```",
].join("\n"));
const multiApplied = applyEditOps("one\ntwo\nthree", multi.edits[0].ops);
check("multiple ops apply", multiApplied.content === "ONE\nTWO\nthree", multiApplied);

// 6. SEARCH/REPLACE ops under a normal language fence (observed in the wild:
// a worker fenced its edit as ```javascript path=js/main.js) must be treated
// as an edit — never written into the file as literal conflict markers.
const mislabeled = extractArtifacts([
  "```javascript path=js/main.js",
  "<<<<<<< SEARCH",
  "restartGame();",
  "=======",
  "resetAndStart();",
  ">>>>>>> REPLACE",
  "```",
].join("\n"));
check(
  "mislabeled edit fence treated as edit",
  mislabeled.files.length === 0 &&
    mislabeled.edits.length === 1 &&
    mislabeled.edits[0].path === "js/main.js",
  mislabeled
);

process.exit(failed === 0 ? 0 : 1);
