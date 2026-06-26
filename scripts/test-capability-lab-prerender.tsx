/** Capability Lab static prerender regression (run: npx tsx scripts/test-capability-lab-prerender.tsx) */
import React from "react";
import { renderToString } from "react-dom/server";
import { CapabilityLab } from "../components/CapabilityLab";
import { __clearClientStoreForTests } from "../lib/client/store";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

__clearClientStoreForTests();

try {
  const html = renderToString(<CapabilityLab providers={[]} />);
  check("CapabilityLab prerenders without an initialized client store", html.length > 0, {
    htmlLength: html.length,
  });
} catch (err) {
  check(
    "CapabilityLab prerenders without an initialized client store",
    false,
    err instanceof Error ? err.message : String(err)
  );
}

process.exit(failed === 0 ? 0 : 1);
