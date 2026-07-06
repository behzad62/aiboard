/** Runner MCP image extraction (run: npx tsx scripts/test-runner-mcp-image.mts) */
import { extractMcpImageContent } from "./runner-lib.mjs";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

{
  // First qualifying image among text items wins.
  const content = [
    { type: "text", text: "some accessibility tree output" },
    { type: "image", data: "AAAAfirst", mimeType: "image/png" },
    { type: "image", data: "BBBBsecond", mimeType: "image/png" },
  ];
  const image = extractMcpImageContent(content);
  check(
    "picks the first image among text items",
    !!image && image.dataBase64 === "AAAAfirst" && image.mimeType === "image/png",
    image
  );
}

{
  // Oversized base64 is SKIPPED entirely; a later smaller image is returned.
  const big = "X".repeat(50);
  const content = [
    { type: "image", data: big, mimeType: "image/png" },
    { type: "image", data: "small", mimeType: "image/jpeg" },
  ];
  const image = extractMcpImageContent(content, 10);
  check(
    "skips oversized base64 and returns a later smaller image",
    !!image && image.dataBase64 === "small" && image.mimeType === "image/jpeg",
    image
  );
}

{
  // Oversized-only content → null (never truncate base64).
  const big = "X".repeat(50);
  const content = [{ type: "image", data: big, mimeType: "image/png" }];
  const image = extractMcpImageContent(content, 10);
  check("oversized-only content returns null (no truncation)", image === null, image);
}

{
  // Missing mimeType defaults to image/png.
  const content = [{ type: "image", data: "abc" }];
  const image = extractMcpImageContent(content);
  check(
    "defaults mimeType to image/png when missing",
    !!image && image.mimeType === "image/png" && image.dataBase64 === "abc",
    image
  );
}

{
  // Non-image mimeType (e.g. application/octet-stream) defaults to image/png.
  const content = [{ type: "image", data: "abc", mimeType: "application/octet-stream" }];
  const image = extractMcpImageContent(content);
  check(
    "defaults mimeType to image/png when mimeType is not image/*",
    !!image && image.mimeType === "image/png",
    image
  );
}

{
  // A valid image/jpeg mimeType is preserved.
  const content = [{ type: "image", data: "abc", mimeType: "image/jpeg" }];
  const image = extractMcpImageContent(content);
  check("keeps a valid image/jpeg mimeType", !!image && image.mimeType === "image/jpeg", image);
}

{
  // A valid image/webp mimeType is preserved.
  const content = [{ type: "image", data: "abc", mimeType: "image/webp" }];
  const image = extractMcpImageContent(content);
  check("keeps a valid image/webp mimeType", !!image && image.mimeType === "image/webp", image);
}

check("non-array content returns null", extractMcpImageContent("nope" as unknown as unknown[]) === null);
check("undefined content returns null", extractMcpImageContent(undefined as unknown as unknown[]) === null);

{
  // Array with only text items → null.
  const content = [
    { type: "text", text: "one" },
    { type: "text", text: "two" },
  ];
  check("array with only text items returns null", extractMcpImageContent(content) === null);
}

{
  // Image item with non-string data → skipped → null.
  const content = [{ type: "image", data: 12345, mimeType: "image/png" }];
  check("image item with non-string data returns null", extractMcpImageContent(content) === null);
}

{
  // Image item with empty-string data → skipped → null.
  const content = [{ type: "image", data: "", mimeType: "image/png" }];
  check("image item with empty-string data returns null", extractMcpImageContent(content) === null);
}

{
  // A null/garbage item does not throw; a later valid image is still found.
  const content = [null, { type: "image", data: "abc", mimeType: "image/png" }];
  const image = extractMcpImageContent(content);
  check(
    "tolerates a null item and still finds a later image",
    !!image && image.dataBase64 === "abc",
    image
  );
}

console.log(failed === 0 ? "\nAll runner MCP image checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
