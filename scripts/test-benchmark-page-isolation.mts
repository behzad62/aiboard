import { readFileSync } from "node:fs";

const page = readFileSync("components/BenchmarkPage.tsx", "utf8");
const lenses = readFileSync("components/benchmark/results/LensTabs.tsx", "utf8");

if (!page.includes('<TabsTrigger value="build">Build</TabsTrigger>')) {
  throw new Error("missing Build tab");
}
if (!page.includes('<TabsContent value="build"')) {
  throw new Error("missing Build content");
}
if (lenses.includes('key: "live"') || lenses.includes("Live builds")) {
  throw new Error("Results still includes Build lens");
}

console.log("PASS");
