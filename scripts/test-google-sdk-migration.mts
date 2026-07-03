/* Google provider SDK migration checks (run: npx tsx scripts/test-google-sdk-migration.mts) */
import { readFileSync } from "node:fs";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies?: Record<string, string>;
};
const googleProviderSource = readFileSync("lib/providers/google.ts", "utf8");
const structuredOutputSource = readFileSync(
  "lib/providers/structured-output.ts",
  "utf8"
);

check(
  "Google provider depends on current @google/genai SDK",
  typeof packageJson.dependencies?.["@google/genai"] === "string" &&
    !("@google/generative-ai" in (packageJson.dependencies ?? {})),
  packageJson.dependencies
);
check(
  "Google provider imports GoogleGenAI from @google/genai",
  googleProviderSource.includes('from "@google/genai"') &&
    googleProviderSource.includes("GoogleGenAI") &&
    !googleProviderSource.includes("@google/generative-ai"),
  googleProviderSource.slice(0, 300)
);
check(
  "Google provider uses generateContentStream from the current SDK",
  googleProviderSource.includes(".models.generateContentStream(") &&
    !googleProviderSource.includes("sendMessageStream("),
  googleProviderSource
);
check(
  "Google structured output uses responseJsonSchema for current SDK JSON Schema",
  structuredOutputSource.includes("responseJsonSchema") &&
    !structuredOutputSource.includes("responseSchema"),
  structuredOutputSource
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
