// Every module a shipped bundle file imports must be shipped. Run: npx tsx scripts/release/test-bundle-closure.mts
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { importClosureGaps, importSpecifiers, PEER_FILES, RUNTIME_PACKAGES } from "./bundle-contents.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

assert.deepEqual(importSpecifiers([
  'import { a } from "./a.js";',
  'import type { B } from "./types.js";',
  'export type { C } from "./c-types.js";',
  'export * from "./d.js";',
  'import "./side-effect.js";',
  'const e = await import("./e.mjs");',
  'const f = require("f-package");',
  "const g = await import(pathToFileURL(dynamic).href);",
  '// import "./commented-out.js";',
  '/* import "./block-comment.js"; */',
  'x.import("./member-call.js");',
  'import { h } from "./h.js"; export { i } from "./i.js";',
  "export {",
  "  j,",
  '} from "./j.js";',
  // A shell script in a string is not an import (0.3.16 release).
  `const script = '  for p in $list; do export "\${p%%:*}=$(decode "\${p#*:}")"; done';`,
  '"import x from \\"./in-a-string.js\\""',
].join("\n")).sort(), ["./a.js", "./d.js", "./e.mjs", "./h.js", "./i.js", "./j.js", "./side-effect.js", "f-package"]);

assert.deepEqual(importClosureGaps(root), [], "the release bundle ships every module its files import");

// The bundle reviewed at ef529ff6 left out the Copilot SDK adapter and its package; the check names both gaps.
const before = importClosureGaps(root, {
  peerFiles: PEER_FILES.filter((path) => path !== "lib/account-provider-copilot-sdk.mjs"),
  runtimePackages: RUNTIME_PACKAGES.filter((name) => name !== "@github/copilot-sdk"),
});
assert.ok(before.some((gap) => /lib\/account-provider-runner\.mjs imports \.\/account-provider-copilot-sdk\.mjs/.test(gap)), before.join("\n"));
assert.ok(importClosureGaps(root, { runtimePackages: RUNTIME_PACKAGES.filter((name) => name !== "@github/copilot-sdk") })
  .some((gap) => /account-provider-copilot-sdk\.mjs imports package @github\/copilot-sdk/.test(gap)));
console.log("PASS the release bundle's import closure is complete");
