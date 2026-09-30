import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { contractPaths, suitePaths } from "../benchmarks/recoverable-job-service/private/identity.mjs";

const root = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "rjs-checkout-"));
const repository = join(scratch, "repository");
const validation = JSON.parse(await readFile(join(root, "docs/benchmarks/recoverable-job-service/design-validation.json"), "utf8"));
const paths = [...new Set<string>([
  ".gitattributes",
  ...[...contractPaths, ...suitePaths].map((path: string) => `benchmarks/recoverable-job-service/${path}`),
  ...validation.files.map((file: { path: string }) => file.path),
  "benchmarks/recoverable-job-service/private/calibration/final-acceptance-review.md",
])];

try {
  await mkdir(repository);
  for (const path of paths) {
    const destination = join(repository, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, path), destination);
  }
  execFileSync("git", ["init", "--quiet", repository]);
  execFileSync("git", ["-C", repository, "-c", "core.autocrlf=true", "add", "."], { stdio: "pipe" });
  for (const autocrlf of ["false", "true"]) {
    const output = join(scratch, `checkout-${autocrlf}`);
    await mkdir(output);
    execFileSync("git", ["-C", repository, "-c", `core.autocrlf=${autocrlf}`,
      "checkout-index", "--all", `--prefix=${output.replaceAll("\\", "/")}/`], { stdio: "pipe" });
    for (const path of paths.filter((path) => path !== ".gitattributes")) {
      assert.deepEqual(await readFile(join(output, path)), await readFile(join(root, path)),
        `qualified bytes survive core.autocrlf=${autocrlf}: ${path}`);
    }
  }
  console.log("PASS qualified RJS bytes survive Windows and Linux Git checkout policies");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
