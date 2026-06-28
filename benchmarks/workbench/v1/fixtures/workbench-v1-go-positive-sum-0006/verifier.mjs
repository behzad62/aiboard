import { readFileSync, writeFileSync } from "node:fs";

const meta = JSON.parse(readFileSync("case-meta.json", "utf8"));
const source = readFileSync(meta.filePath, "utf8");
const assertions = meta.checks.map((check) => ({
  id: check.id,
  label: check.label,
  passed: source.includes(check.contains),
  weight: check.weight ?? 1,
  message: source.includes(check.contains)
    ? undefined
    : `Expected ${meta.filePath} to contain ${JSON.stringify(check.contains)}`,
}));
const totalWeight = assertions.reduce((sum, item) => sum + item.weight, 0);
const passedWeight = assertions
  .filter((item) => item.passed)
  .reduce((sum, item) => sum + item.weight, 0);
const passed = assertions.every((item) => item.passed);
const result = {
  passed,
  score: totalWeight > 0 ? passedWeight / totalWeight : passed ? 1 : 0,
  summary: passed
    ? "Fixture satisfies the WorkBench verifier."
    : "Fixture does not satisfy the WorkBench verifier.",
  assertions,
};

writeFileSync("verifier-result.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
process.exit(passed ? 0 : 1);
