import { writeFileSync } from "node:fs";
import { formatReport, rows } from "./src/report.mjs";

const expectedJson = JSON.stringify(rows);
const expectedCsv = [
  "name,score",
  "Ada Lovelace,5",
  "\"Grace \"\"Amazing\"\" Hopper\",7"
].join("\n");

const jsonOutput = formatReport("json");
const csvOutput = formatReport("csv");
const assertions = [
  {
    id: "json-unchanged",
    label: "JSON output is unchanged",
    passed: jsonOutput === expectedJson,
    weight: 0.4
  },
  {
    id: "csv-added",
    label: "CSV output is available",
    passed: csvOutput === expectedCsv,
    weight: 0.4,
    message: csvOutput === expectedCsv ? undefined : `Expected ${expectedCsv}, got ${csvOutput}`
  },
  {
    id: "csv-quotes",
    label: "CSV quotes are escaped",
    passed: csvOutput.includes("\"Grace \"\"Amazing\"\" Hopper\""),
    weight: 0.2
  }
];
const totalWeight = assertions.reduce((sum, item) => sum + item.weight, 0);
const passedWeight = assertions
  .filter((item) => item.passed)
  .reduce((sum, item) => sum + item.weight, 0);
const score = totalWeight > 0 ? passedWeight / totalWeight : 0;
const result = {
  passed: assertions.every((item) => item.passed),
  score,
  summary: assertions.every((item) => item.passed)
    ? "CSV report output works."
    : "CSV report output is incomplete.",
  assertions
};

writeFileSync("verifier-result.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
process.exit(result.passed ? 0 : 1);
