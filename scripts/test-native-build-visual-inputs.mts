import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildUserMediaStore, validateVisualInputs } from "../runner-v2/src/build-user-media";
import { withVisualMedia } from "../runner-v2/src/provider-visual-input";
import { wrapModelWithBuildUserVisuals } from "../runner-v2/src/build-visual-model";
import { classifyBuildMessage, describeVisualEvidence } from "../runner-v2/src/build-message-intent";
import { initialBuildVisualInputs, validateBuildComposerFiles, visualFileMime } from "../lib/client/build-user-attachments";
import type { AgentMediaAttachment, AgentModel } from "../runner-v2/src/agent-contracts";

const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]);
const pdf = Buffer.from("%PDF-1.7\n1 0 obj\nendobj\n%%EOF\n");
const image = { filename: "error.png", mimeType: "image/png", base64Data: png.toString("base64") } as const;
const document = { filename: "spec.pdf", mimeType: "application/pdf", base64Data: pdf.toString("base64") } as const;
const entries = validateVisualInputs([image, document]);
assert.equal(entries.length, 2);
assert.equal(entries[0]?.media.mimeType, "image/png");
assert.throws(() => validateVisualInputs([{ ...image, mimeType: "application/pdf" }]), /do not match/);
assert.throws(() => validateVisualInputs([image, image, image, image]), /at most 3/);
assert.throws(() => validateVisualInputs([{ ...image, base64Data: "$$$" }]), /encoding/);
const large = Buffer.alloc(8 * 1024 * 1024 + 1, 0);
large.set(png);
assert.throws(() => validateVisualInputs([{ ...image, base64Data: large.toString("base64") }]), /size/);

const folder = await mkdtemp(join(tmpdir(), "visual-transport-"));
try {
  const store = new BuildUserMediaStore(folder);
  const refs = await store.save("run-1", "message-1", [image, document]);
  assert.equal(refs.length, 2);
  assert.match(refs[0]!.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(await store.save("run-1", "message-1", [image, document]), refs);
  assert.deepEqual(await store.load("run-1", "message-1", refs), [image, document]);
  assert.deepEqual(await store.loadByReference("run-1", store.referenceToken("message-1", refs[0]!.hash).split(":")[1]!, refs[0]!.hash), image);
  const presented: Array<readonly AgentMediaAttachment[] | undefined> = [];
  const delegate: AgentModel = { complete: async (request) => {
    presented.push(request.attachments);
    return { stopReason: "end_turn", blocks: [{ type: "text", text: "ok" }] };
  } };
  const tag = store.referenceToken("message-1", refs[0]!.hash);
  const turn = { sessionId: "worker-1", messages: [{ id: "task", role: "user" as const, content: `Please inspect ${tag}` }], tools: [] };
  await wrapModelWithBuildUserVisuals(delegate, store, "run-1", { image: true, document: false }).complete(turn);
  assert.deepEqual(presented.pop(), [image], "A vision worker receives the original screenshot");
  await wrapModelWithBuildUserVisuals(delegate, store, "run-1", { image: false, document: false }).complete(turn);
  assert.equal(presented.pop(), undefined, "Text-only workers receive the description without binary payload");
  await assert.rejects(wrapModelWithBuildUserVisuals(delegate, store, "run-2", { image: true, document: true }).complete(turn));
  await assert.rejects(store.save("run-1", "message-1", [document]), /different payload/);
  await assert.rejects(store.load("run-2", "message-1", refs));
  await assert.rejects(store.load("run-1", "message-1", refs.slice(0, 1)), /mismatch/);
} finally { await rm(folder, { recursive: true, force: true }); }

const media: AgentMediaAttachment[] = [image, document];
const user = [{ role: "system", content: "SYSTEM" }, { role: "user", content: "what error?" }];
const anthropic = withVisualMedia(user, media, "anthropic");
const anthParts = anthropic[1]!.content as Array<Record<string, unknown>>;
assert.equal(anthParts[1]?.type, "image");
assert.equal(anthParts[2]?.type, "document");
const gemini = withVisualMedia([{ role: "user", parts: [{ text: "A" }] }], media, "gemini");
assert.equal((gemini[0]!.parts as Array<{ inlineData?: { mimeType?: string } }>)[2]?.inlineData?.mimeType, "application/pdf");
const response = withVisualMedia([{ role: "user", content: "A" }], media, "openai-responses");
assert.equal((response[0]!.content as Array<Record<string, unknown>>)[2]?.type, "input_file");
const chat = withVisualMedia([{ role: "user", content: "A" }], [image], "openai-chat");
assert.equal((chat[0]!.content as Array<Record<string, unknown>>)[1]?.type, "image_url");
assert.throws(() => withVisualMedia([{ role: "user", content: "A" }], [document], "openai-chat"), /PDF input requires/);
assert.deepEqual(withVisualMedia(user, [], "anthropic"), user);
assert.deepEqual(user[1], { role: "user", content: "what error?" }, "Original message is not mutated");

const observed: Array<readonly AgentMediaAttachment[] | undefined> = [];
const model: AgentModel = { complete: async (req) => {
  observed.push(req.attachments);
  return { stopReason: "end_turn", blocks: [{ type: "text", text: observed.length === 1 ? '{"intent":"change"}' : "Screenshot says HTTP 500." }] };
}};
assert.equal(await classifyBuildMessage(model, "Fix this error", [], [image]), "change");
assert.match(await describeVisualEvidence(model, "Fix this error", [image]), /HTTP 500/);
assert.deepEqual(observed, [[image], [image]]);

assert.deepEqual(initialBuildVisualInputs([
  { id: "a", filename: "screenshot.png", mimeType: "image/png", category: "image", base64Data: image.base64Data },
  { id: "b", filename: "requirements.pdf", mimeType: "application/pdf", category: "document", base64Data: document.base64Data },
]), [{ filename: "screenshot.png", mimeType: "image/png", base64Data: image.base64Data },
  { filename: "requirements.pdf", mimeType: "application/pdf", base64Data: document.base64Data }]);
assert.throws(() => initialBuildVisualInputs([{ id: "x", filename: "slides.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", category: "document", base64Data: "AA==" }]), /Only PNG/);
assert.equal(visualFileMime({ name: "screenshot.png", type: "image/png" }), "image/png");
assert.equal(visualFileMime({ name: "spec.pdf", type: "" }), "application/pdf");
assert.equal(visualFileMime({ name: "fake.png", type: "application/pdf" }), null);
assert.match(validateBuildComposerFiles([new File([pdf], "spec.pdf", { type: "application/pdf" }),
  new File([png], "error.png", { type: "image/png" }),
  new File(["details"], "details.md", { type: "text/markdown" }),
  new File([""], "secret.exe", { type: "application/octet-stream" })]) ?? "", /Only text/);
assert.equal(validateBuildComposerFiles([new File([pdf], "spec.pdf", { type: "application/pdf" }), new File([png], "error.png", { type: "image/png" })]), null);
console.log("PASS Build visual media: signatures, durability, run isolation, role-aware original media delivery, payload formats, LLM delivery, client validation");
