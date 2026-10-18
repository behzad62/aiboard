import assert from "node:assert/strict";
import {
  addBuildTextSections,
  buildGuidanceWithTextFiles,
  initialNativeBuildTextAttachments,
  isBuildTextFile,
  validateBuildTextFiles,
} from "../lib/client/build-guidance-files";

assert.equal(isBuildTextFile("request.md"), true);
assert.equal(isBuildTextFile("config.json", "application/json"), true);
assert.equal(isBuildTextFile("photo.png", "image/png"), false);
assert.equal(isBuildTextFile("document.pdf", "text/plain"), false);
assert.match(validateBuildTextFiles([{ name: "photo.png", type: "image/png", size: 20 }]) ?? "", /not images/i);
assert.match(validateBuildTextFiles([{ name: "large.md", type: "text/plain", size: 32769 }]) ?? "", /32 KB/);
assert.match(validateBuildTextFiles(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, type: "", size: 1 }))) ?? "", /at most 5/);
assert.equal(validateBuildTextFiles([{ name: "small.md", type: "text/markdown", size: 16 }]), null);

const textFile = new File(["# API requirements\nKeep /health"], "requirements.md", { type: "text/markdown" });
const delivered = await buildGuidanceWithTextFiles("Check the endpoint.", [textFile]);
assert.match(delivered, /Check the endpoint/);
assert.match(delivered, /requirements.md/);
assert.match(delivered, /Keep \/health/);
assert.match(delivered, /untrusted project data/);
assert.equal(await buildGuidanceWithTextFiles("Just text.", []), "Just text.");
await assert.rejects(buildGuidanceWithTextFiles("", [new File(["binary"], "a.png", { type: "image/png" })]), /not images/i);
await assert.rejects(buildGuidanceWithTextFiles("", [new File(["\0"], "bad.txt")]), /Binary data/);
assert.match(addBuildTextSections("", [{ name: "notes.txt", content: "SPEC" }]), /SPEC/);
assert.match(initialNativeBuildTextAttachments([{ id: "1", filename: "spec.md", mimeType: "text/markdown", category: "text_inline", textContent: "Initial content" }]), /Initial content/);
assert.equal(initialNativeBuildTextAttachments([]), "");
console.log("PASS native Build text file guidance, validation, and initial context.");
