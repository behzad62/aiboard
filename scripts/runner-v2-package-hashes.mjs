import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const archiveNames = [
  "aiboard-account-provider-runner.zip",
  "aiboard-runner-v2.zip",
  "aiboard-workbench-runner.zip",
];

const [command] = process.argv.slice(2);
const option = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`Missing --${name}.`);
  return process.argv[index + 1];
};

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

if (command === "write") {
  const input = path.resolve(option("input-dir"));
  const output = path.resolve(option("output"));
  const label = option("label");
  const archives = {};
  for (const name of archiveNames) {
    const file = path.join(input, name);
    if (!fs.existsSync(file)) throw new Error(`Missing archive ${file}.`);
    const stat = fs.statSync(file);
    archives[name] = { sha256: sha256(file), bytes: stat.size };
  }  fs.writeFileSync(output, `${JSON.stringify({ label, archives }, null, 2)}\n`);
  console.log(`Wrote ${path.basename(output)} for ${label}.`);
} else if (command === "compare") {
  const input = path.resolve(option("input-dir"));
  const expectedLabels = option("expected-labels").split(",").filter(Boolean).sort();
  const reports = fs.readdirSync(input)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(input, name), "utf8")));
  const labels = reports.map((report) => report.label).sort();
  if (JSON.stringify(labels) !== JSON.stringify(expectedLabels)) {
    throw new Error(`Expected reports for ${expectedLabels.join(", ")}; got ${labels.join(", ")}.`);
  }
  const reference = reports[0];
  if (!reference) throw new Error("No package hash reports found.");
  for (const report of reports.slice(1)) {
    for (const name of archiveNames) {
      const expected = reference.archives?.[name];
      const actual = report.archives?.[name];
      if (!expected || !actual) throw new Error(`Missing ${name} hash in ${report.label}.`);
      if (expected.sha256 !== actual.sha256 || expected.bytes !== actual.bytes) {
        throw new Error(`${name} differs between ${reference.label} and ${report.label}.`);
      }
    }
  }
  console.log(`Cross-host package hashes match for ${labels.join(", ")}.`);
} else {
  throw new Error("Usage: runner-v2-package-hashes.mjs write|compare ...");
}
