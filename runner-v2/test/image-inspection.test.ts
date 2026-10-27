import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import test from "node:test";
import type { AgentMessage, AgentModelRequest, ToolResult } from "../src/agent-contracts.js";
import { AnthropicModel } from "../src/anthropic-model.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { GoogleModel } from "../src/google-model.js";
import { IMAGE_LIMITS, ImageInspectionError, decodePng, detectImageType, encodePng, prepareImageForModel, probeImage } from "../src/image-inspection.js";
import { createImageTools } from "../src/image-tools.js";
import { OpenAICompatibleModel } from "../src/openai-compatible-model.js";
import { ToolBroker } from "../src/tool-broker.js";
import { pendingVisualArtifacts, wrapModelWithToolVisuals } from "../src/tool-visual-input.js";

function checkerboard(width: number, height: number): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4, on = (x + y) % 2 === 0;
    data[at] = on ? 255 : 0; data[at + 1] = x % 256; data[at + 2] = y % 256; data[at + 3] = 255;
  }
  return encodePng({ width, height, data });
}

function jpegWithOrientation(width: number, height: number, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("MM", 0, "latin1"); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8); tiff.writeUInt16BE(0x0112, 10); tiff.writeUInt16BE(3, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(orientation, 18);
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), u16(exif.length + 2), exif]);
  const sof = Buffer.concat([Buffer.from([0xff, 0xc0]), u16(17), Buffer.from([8]), u16(height), u16(width), Buffer.from([3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9])]);
}
function u16(value: number) { const buffer = Buffer.alloc(2); buffer.writeUInt16BE(value); return buffer; }

test("content detection, probes and limits do not trust file names", () => {
  const png = checkerboard(3, 2);
  assert.equal(detectImageType(png), "image/png");
  assert.deepEqual(probeImage(png), { mediaType: "image/png", width: 3, height: 2, interlaced: false });
  const jpeg = jpegWithOrientation(640, 480, 6);
  assert.deepEqual(probeImage(jpeg), { mediaType: "image/jpeg", width: 640, height: 480, orientation: 6 });
  const vp8x = Buffer.alloc(30); vp8x.write("RIFF", 0, "latin1"); vp8x.write("WEBP", 8, "latin1"); vp8x.write("VP8X", 12, "latin1"); vp8x.writeUIntLE(799, 24, 3); vp8x.writeUIntLE(599, 27, 3);
  assert.deepEqual(probeImage(vp8x), { mediaType: "image/webp", width: 800, height: 600 });
  assert.throws(() => probeImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")), (error: unknown) => (error as ImageInspectionError).code === "image_format_unsupported" && /never executed/.test((error as Error).message));
  assert.throws(() => probeImage(Buffer.from("not an image")), /Not a PNG, JPEG or WebP/);
  // Decompression bomb: a tiny file whose header claims an enormous canvas is refused before decoding.
  const bomb = Buffer.from(png); bomb.writeUInt32BE(30_000, 16); bomb.writeUInt32BE(30_000, 20);
  assert.throws(() => probeImage(bomb), (error: unknown) => (error as ImageInspectionError).code === "image_too_large");
});

test("PNG decode is bounded and integrity-checked; crop and downscale produce new bytes", () => {
  const png = checkerboard(40, 30);
  const decoded = decodePng(png);
  assert.equal(decoded.width, 40); assert.equal(decoded.data[0], 255); assert.equal(decoded.data[4], 0);
  const corrupt = Buffer.from(png); corrupt[corrupt.indexOf("IDAT") + 6]! ^= 0xff;
  assert.throws(() => decodePng(corrupt), /checksum|does not match/);
  // IDAT that inflates to more than the header allows is refused (bounded inflate).
  const header = png.subarray(0, 33);
  const oversized = deflateSync(Buffer.alloc(40 * 30 * 4 * 4 + 100));
  const chunk = (type: string, data: Buffer) => { const length = u32(data.length); const body = Buffer.concat([Buffer.from(type), data]); return Buffer.concat([length, body, u32(crc32(body) >>> 0)]); };
  const bomb = Buffer.concat([header, chunk("IDAT", oversized), chunk("IEND", Buffer.alloc(0))]);
  assert.throws(() => decodePng(bomb), /does not match its header/);
  const cropped = prepareImageForModel(png, { crop: { x: 1, y: 0, width: 4, height: 3 } });
  assert.equal(cropped.width, 4); assert.equal(cropped.height, 3); assert.deepEqual(cropped.transforms, ["crop 1,0 4x3"]);
  assert.notEqual(cropped.digest, cropped.sourceDigest);
  assert.equal(decodePng(cropped.bytes).data[0], 0, "crop starts at an off square");
  const large = checkerboard(2400, 300);
  const resized = prepareImageForModel(large, { maxDimension: 600 });
  assert.equal(resized.width, 600); assert.equal(resized.height, 75); assert.deepEqual(resized.transforms, ["resize 600x75"]);
  const untouched = prepareImageForModel(png);
  assert.equal(untouched.digest, untouched.sourceDigest); assert.deepEqual(untouched.transforms, []);
  const jpeg = jpegWithOrientation(320, 200, 6);
  const delivered = prepareImageForModel(jpeg);
  assert.match(delivered.notes.join(" "), /orientation 6 was not applied/);
  assert.throws(() => prepareImageForModel(jpeg, { crop: { x: 0, y: 0, width: 1, height: 1 } }), (error: unknown) => (error as ImageInspectionError).code === "image_transform_unsupported");
  assert.throws(() => prepareImageForModel(png, { crop: { x: 39, y: 0, width: 4, height: 1 } }), /within/);
});
function u32(value: number) { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value); return buffer; }

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "image-inspect-")));
  const workspace = join(root, "workspace"); mkdirSync(join(workspace, "private"), { recursive: true });
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  writeFileSync(join(workspace, "shot.png"), checkerboard(8, 8));
  writeFileSync(join(workspace, "private", "secret.png"), checkerboard(2, 2));
  writeFileSync(join(root, "outside.png"), checkerboard(2, 2));
  writeFileSync(join(workspace, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, artifacts });
  for (const tool of createImageTools({ artifacts, hiddenPaths: ["private"] })) broker.register(tool);
  let call = 0;
  const invoke = (args: Record<string, unknown>, imageInput = true) => broker.invoke({ type: "tool_call", callId: `img-${++call}`, name: "image.inspect", arguments: args },
    { runId: "run", sessionId: "s", actor: { role: "worker", id: "w" }, workspacePath: workspace, imageInput });
  return { root, workspace, artifacts, invoke };
}

test("image.inspect returns a visual artifact for image-capable models and never base64 text", async () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.workspace, "shot.png"));
    const result = await f.invoke({ path: "shot.png", crop: { x: 0, y: 0, width: 4, height: 4 } });
    assert.equal(result.isError, false, JSON.stringify(result));
    const meta = result.content.find(block => block.type === "json")!.value as { shown: boolean; source: { path: string; width: number; sha256: string }; delivered: { artifactHash: string; width: number } };
    assert.equal(meta.shown, true); assert.equal(meta.source.path, "shot.png"); assert.equal(meta.source.width, 8); assert.equal(meta.delivered.width, 4);
    const visual = result.content.find(block => block.type === "artifact");
    assert.ok(visual?.type === "artifact" && visual.visual); assert.equal(visual.visual.sourceDigest, meta.source.sha256);
    assert.equal(visual.hash, meta.delivered.artifactHash);
    assert.doesNotMatch(JSON.stringify(result), /iVBORw0KGgo/, "no base64 image text in the tool result");
    assert.deepEqual(readFileSync(join(f.workspace, "shot.png")), before, "source file is unchanged");
    // Artifact references (e.g. screenshots) use the same route.
    const fromArtifact = await f.invoke({ artifactHash: meta.delivered.artifactHash });
    assert.equal(fromArtifact.isError, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("text-only models, hidden or outside paths, SVG and invalid images are explicit failures", async () => {
  const f = fixture();
  try {
    const textOnly = await f.invoke({ path: "shot.png" }, false);
    assert.equal(textOnly.isError, true); assert.equal(textOnly.error?.code, "image_input_unsupported");
    assert.equal(textOnly.content.some(block => block.type === "artifact"), false, "no image is attached for a text-only model");
    assert.match(textOnly.error!.message, /was not shown/);
    assert.equal((await f.invoke({ path: "private/secret.png" })).error?.code, "image_hidden_path");
    assert.equal((await f.invoke({ path: "../outside.png" })).error?.code, "image_outside_workspace");
    assert.equal((await f.invoke({ path: "logo.svg" })).error?.code, "image_format_unsupported");
    assert.equal((await f.invoke({ path: "missing.png" })).error?.code, "image_unreadable");
    assert.equal((await f.invoke({ path: "shot.png", artifactHash: "a".repeat(64) })).isError, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("only Runner image producers may mark artifacts as model-visible", async () => {
  const root = mkdtempSync(join(tmpdir(), "visual-strip-"));
  try {
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    const stored = await artifacts.put(checkerboard(2, 2), "image/png");
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: root, artifacts });
    broker.register({ definition: { name: "custom.picture", description: "x", inputSchema: { type: "object" }, readOnly: true, effect: "none" },
      validate: (input) => ({ ok: true, value: input }),
      execute: async () => ({ isError: false, content: [{ type: "artifact", hash: stored.hash, mediaType: "image/png", visual: { width: 2, height: 2, sourceDigest: stored.hash } }] }) });
    const result = await broker.invoke({ type: "tool_call", callId: "c1", name: "custom.picture", arguments: {} }, { runId: "r", sessionId: "s", actor: { role: "worker", id: "w" }, imageInput: true });
    const block = result.content.find(item => item.type === "artifact");
    assert.ok(block?.type === "artifact"); assert.equal(block.visual, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

async function visualRequest(artifacts: ArtifactStore) {
  const png = checkerboard(4, 4);
  const stored = await artifacts.put(png, "image/png", "Image shot.png");
  const result: ToolResult = { callId: "call-1", toolName: "image.inspect", isError: false,
    content: [{ type: "json", value: { shown: true } }, { type: "artifact", hash: stored.hash, mediaType: "image/png", label: "Image shot.png", visual: { width: 4, height: 4, sourceDigest: stored.hash } }] };
  const messages: AgentMessage[] = [
    { id: "u", role: "user", content: "Look at shot.png" },
    { id: "a", role: "assistant", content: [{ type: "tool_call", callId: "call-1", name: "image.inspect", arguments: { path: "shot.png" } }] },
    { id: "t", role: "tool", content: result },
  ];
  return { png, hash: stored.hash, messages, base64: png.toString("base64") };
}

test("a real local image reaches each provider request in native image form, once", async () => {
  const root = mkdtempSync(join(tmpdir(), "visual-adapters-"));
  try {
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    const { messages, base64 } = await visualRequest(artifacts);
    const read = (hash: string) => artifacts.get(hash);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- captured provider request bodies
    const bodies: Record<string, any> = {};
    const anthropic = wrapModelWithToolVisuals(new AnthropicModel({ apiKey: "k", modelId: "m", fetch: async (_i, init) => { bodies.anthropic = JSON.parse(String(init?.body)); return Response.json({ content: [], usage: {} }); } }), { image: true, readArtifact: read });
    const google = wrapModelWithToolVisuals(new GoogleModel({ apiKey: "k", modelId: "m", fetch: async (_i, init) => { bodies.google = JSON.parse(String(init?.body)); return Response.json({ candidates: [] }); } }), { image: true, readArtifact: read });
    const chat = wrapModelWithToolVisuals(new OpenAICompatibleModel({ baseUrl: "https://api.test/v1", apiKey: "k", modelId: "m", fetch: async (_i, init) => { bodies.chat = JSON.parse(String(init?.body)); return Response.json({ choices: [{ message: {} }] }); } }), { image: true, readArtifact: read });
    const responses = wrapModelWithToolVisuals(new OpenAICompatibleModel({ baseUrl: "https://api.test/v1", apiKey: "k", modelId: "m", protocol: "responses", fetch: async (_i, init) => { bodies.responses = JSON.parse(String(init?.body)); return Response.json({ status: "completed", output: [] }); } }), { image: true, readArtifact: read });
    const request: AgentModelRequest = { sessionId: "s", messages, tools: [] };
    for (const model of [anthropic, google, chat, responses]) { assert.equal(model.inputModalities?.image, true); await model.complete(request); }
    const toolResult = bodies.anthropic.messages.at(-1).content[0];
    assert.equal(toolResult.type, "tool_result");
    assert.deepEqual(toolResult.content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } });
    assert.doesNotMatch(toolResult.content[0].text, new RegExp(base64.slice(0, 24)), "image bytes are not serialized as tool text");
    const parts = bodies.google.contents.at(-1).parts;
    assert.ok(parts[0].functionResponse); assert.deepEqual(parts[1], { inlineData: { mimeType: "image/png", data: base64 } });
    const chatMessages = bodies.chat.messages;
    assert.equal(chatMessages.at(-2).role, "tool"); assert.equal(chatMessages.at(-1).role, "user");
    assert.equal(chatMessages.at(-1).content[1].image_url.url, `data:image/png;base64,${base64}`);
    assert.doesNotMatch(chatMessages.at(-2).content, new RegExp(base64.slice(0, 24)));
    const input = bodies.responses.input;
    assert.equal(input.at(-2).type, "function_call_output"); assert.equal(input.at(-1).content[1].type, "input_image");
    // After the model answers, the same image is not re-attached on later turns.
    const later: AgentModelRequest = { sessionId: "s", tools: [], messages: [...messages, { id: "a2", role: "assistant", content: [{ type: "text", text: "It is a checkerboard." }] }, { id: "u2", role: "user", content: "Thanks" }] };
    await anthropic.complete(later);
    assert.doesNotMatch(JSON.stringify(bodies.anthropic), new RegExp(base64.slice(0, 24)));
    assert.equal(pendingVisualArtifacts(later.messages).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("controls: a text-only model and a non-visual artifact never send image bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "visual-controls-"));
  try {
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    const { messages, base64 } = await visualRequest(artifacts);
    let body = "";
    const textOnly = wrapModelWithToolVisuals(new AnthropicModel({ apiKey: "k", modelId: "m", fetch: async (_i, init) => { body = String(init?.body); return Response.json({ content: [], usage: {} }); } }), { image: false, readArtifact: (hash) => artifacts.get(hash) });
    assert.equal(textOnly.inputModalities?.image, false);
    await textOnly.complete({ sessionId: "s", messages, tools: [] });
    assert.doesNotMatch(body, new RegExp(base64.slice(0, 24)));
    const opaque = messages.map(message => message.role !== "tool" ? message : { ...message, content: { ...(message.content as ToolResult), content: (message.content as ToolResult).content.map(block => block.type === "artifact" ? { type: "artifact" as const, hash: block.hash, mediaType: block.mediaType } : block) } });
    const capable = wrapModelWithToolVisuals(new AnthropicModel({ apiKey: "k", modelId: "m", fetch: async (_i, init) => { body = String(init?.body); return Response.json({ content: [], usage: {} }); } }), { image: true, readArtifact: (hash) => artifacts.get(hash) });
    await capable.complete({ sessionId: "s", messages: opaque, tools: [] });
    assert.doesNotMatch(body, /"type":"image"/, "an opaque artifact hash is not image input");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("delivery limits are explicit", () => {
  assert.ok(IMAGE_LIMITS.maxDeliveredBytes * 4 / 3 <= 5 * 1024 * 1024);
  assert.equal(IMAGE_LIMITS.defaultMaxDimension, 1568);
});
