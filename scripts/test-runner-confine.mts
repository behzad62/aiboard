/* confine()/listDirs/driveRoots checks (run: npx tsx scripts/test-runner-confine.mts) */
import { confine, listDirs, driveRoots } from "./runner-lib.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
}
function expectThrow(name: string, fn: () => unknown) {
  try {
    fn();
    failures++;
    console.log(`FAIL ${name} — did not throw`);
  } catch {
    console.log(`PASS ${name}`);
  }
}

// Build a temp tree:  root/{sub/inner, file.txt}  and a sibling  rootEVIL/secret
const base = fs.mkdtempSync(path.join(os.tmpdir(), "confine-"));
fs.mkdirSync(path.join(base, "root", "sub", "inner"), { recursive: true });
const root = fs.realpathSync(path.join(base, "root"));
fs.writeFileSync(path.join(root, "file.txt"), "x");
const evil = path.join(base, "rootEVIL");
fs.mkdirSync(evil, { recursive: true });
fs.writeFileSync(path.join(evil, "secret"), "s");

check("confine(root, root) === realpath(root)", confine(root, ".") === fs.realpathSync(root));
check("confine sub ok", confine(root, "sub") === path.join(root, "sub"));
check("confine nested ok", confine(root, "sub/inner") === path.join(root, "sub", "inner"));
check("confine new file (nonexistent tail) ok", confine(root, "sub/new.txt") === path.join(root, "sub", "new.txt"));
expectThrow("confine escape via ..", () => confine(root, "../rootEVIL"));
expectThrow("confine escape to sibling secret", () => confine(root, "../rootEVIL/secret"));
expectThrow("confine null byte", () => confine(root, "a\0b"));
expectThrow("confine reserved name CON", () => confine(root, "CON"));

// Trailing-separator boundary: an absolute sibling that shares the root prefix.
expectThrow("confine rootEVIL prefix trick", () => confine(root, evil));

// Symlink escape (best-effort; Windows may forbid symlink creation without privilege).
let symlinkMade = false;
try {
  fs.symlinkSync(evil, path.join(root, "link"), "dir");
  symlinkMade = true;
} catch {
  console.log("SKIP symlink escape test (symlink creation not permitted)");
}
if (symlinkMade) {
  expectThrow("confine symlink escape", () => confine(root, "link/secret"));
}

// listDirs
const dirs = listDirs(root).map((d) => d.name);
check("listDirs finds sub", dirs.includes("sub"));
check("listDirs excludes files", !dirs.includes("file.txt"));

// driveRoots
const roots = await driveRoots();
check("driveRoots non-empty", roots.length > 0);
if (process.platform === "win32") {
  check("driveRoots has a drive", roots.some((r) => /^[A-Za-z]:$/.test(r.name)));
} else {
  check("driveRoots is /", roots[0].path === "/");
}

fs.rmSync(base, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
