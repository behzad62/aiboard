/** Runner output cap helpers (run: npx tsx scripts/test-runner-output-cap.mts) */
import {
  appendTextToUtf8ByteCap,
  capTextToUtf8Bytes,
} from "./runner-lib.mjs";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

{
  const capped = capTextToUtf8Bytes("abcde", 3);
  check(
    "capTextToUtf8Bytes marks truncation when bytes are dropped",
    capped.text === "abc" && capped.truncated === true && capped.bytes <= 3,
    capped
  );
}

{
  const emoji = "🙂".repeat(4);
  const capped = capTextToUtf8Bytes(emoji, 5);
  check(
    "capTextToUtf8Bytes respects UTF-8 byte limit for multi-byte text",
    Buffer.byteLength(capped.text, "utf8") <= 5 &&
      capped.truncated === true &&
      !capped.text.includes("\uFFFD"),
    { capped, bytes: Buffer.byteLength(capped.text, "utf8") }
  );
}

{
  const appended = appendTextToUtf8ByteCap("1234", "5678", 6);
  check(
    "appendTextToUtf8ByteCap reports truncation when final chunk crosses cap",
    appended.text === "123456" && appended.truncated === true && appended.bytes <= 6,
    appended
  );
}

{
  const appended = appendTextToUtf8ByteCap("1234", "56", 6);
  check(
    "appendTextToUtf8ByteCap does not mark exact cap as truncated",
    appended.text === "123456" && appended.truncated === false && appended.bytes === 6,
    appended
  );
}

console.log(failed === 0 ? "\nAll runner output cap checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
