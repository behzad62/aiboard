// Publish only the browser-downloadable transports that remain part of the
// product. Build execution itself belongs to the mandatory Runner V2 process
// and is started from this repository with `npm run runner:v2`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scripts, "..");
const publicDirectory = path.join(root, "public");
const downloads = [
  [path.join(root, "lib", "account-provider-runner.mjs"), path.join(publicDirectory, "account-provider-runner.mjs")],
  [path.join(scripts, "bench-runner.mjs"), path.join(publicDirectory, "bench-runner.mjs")],
];

fs.mkdirSync(publicDirectory, { recursive: true });
for (const retired of ["runner.mjs", "runner-manifest.json"]) {
  fs.rmSync(path.join(publicDirectory, retired), { force: true });
}
for (const [source, destination] of downloads) {
  if (!fs.existsSync(source)) continue;
  fs.copyFileSync(source, destination);
  console.log(`Published ${path.relative(root, destination)}.`);
}
