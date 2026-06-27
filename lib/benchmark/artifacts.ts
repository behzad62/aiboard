import type { BenchmarkArtifact } from "./types";

type ArtifactKindInput = BenchmarkArtifact["kind"] | "patch";

export interface CreateBenchmarkArtifactInput {
  id: string;
  kind: ArtifactKindInput;
  label: string;
  content: string;
  mimeType?: string;
  createdAt?: string;
  runId?: string;
  caseId?: string;
  attemptId?: string;
}

export interface CreateJsonArtifactInput
  extends Omit<CreateBenchmarkArtifactInput, "kind" | "content" | "mimeType"> {
  content: unknown;
}

export interface CreateLogArtifactInput
  extends Omit<CreateBenchmarkArtifactInput, "kind" | "mimeType"> {
  maxChars?: number;
}

export function createBenchmarkArtifact(
  input: CreateBenchmarkArtifactInput
): BenchmarkArtifact {
  return {
    id: input.id,
    runId: input.runId,
    caseId: input.caseId,
    attemptId: input.attemptId,
    kind: input.kind as BenchmarkArtifact["kind"],
    label: input.label,
    mimeType: input.mimeType ?? defaultMimeTypeForArtifactKind(input.kind),
    content: input.content,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function createJsonArtifact(
  input: CreateJsonArtifactInput
): BenchmarkArtifact {
  return createBenchmarkArtifact({
    ...input,
    kind: "json",
    mimeType: "application/json",
    content:
      typeof input.content === "string"
        ? input.content
        : JSON.stringify(input.content, null, 2),
  });
}

export function createMarkdownArtifact(
  input: Omit<CreateBenchmarkArtifactInput, "kind" | "mimeType">
): BenchmarkArtifact {
  return createBenchmarkArtifact({
    ...input,
    kind: "markdown",
    mimeType: "text/markdown",
  });
}

export function createLogArtifact(input: CreateLogArtifactInput): BenchmarkArtifact {
  return createBenchmarkArtifact({
    ...input,
    kind: "log",
    mimeType: "text/plain",
    content:
      input.maxChars === undefined
        ? input.content
        : capArtifactContent(input.content, input.maxChars),
  });
}

export function createPatchArtifact(
  input: Omit<CreateBenchmarkArtifactInput, "kind" | "mimeType">
): BenchmarkArtifact {
  return createBenchmarkArtifact({
    ...input,
    kind: "patch",
    mimeType: "text/x-patch",
  });
}

export function capArtifactContent(content: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars < 0) {
    throw new Error("Artifact content cap must be a non-negative number.");
  }

  if (content.length <= maxChars) return content;

  const omitted = content.length - maxChars;
  const suffix = `[truncated ${omitted} chars]`;
  if (maxChars === 0) return suffix;
  return `${content.slice(0, maxChars)}\n${suffix}`;
}

export function hashArtifactContent(content: string): string {
  return sha256Hex(new TextEncoder().encode(content));
}

function defaultMimeTypeForArtifactKind(kind: ArtifactKindInput): string {
  switch (kind) {
    case "json":
      return "application/json";
    case "markdown":
    case "transcript":
      return "text/markdown";
    case "patch":
      return "text/x-patch";
    case "screenshot":
      return "image/png";
    case "log":
    case "raw-response":
    default:
      return "text/plain";
  }
}

const SHA256_INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256Hex(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 1 + 8) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = [...SHA256_INITIAL_STATE];
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let word = 0; word < 16; word++) {
      words[word] = view.getUint32(offset + word * 4, false);
    }
    for (let word = 16; word < 64; word++) {
      const s0 =
        rotateRight(words[word - 15], 7) ^
        rotateRight(words[word - 15], 18) ^
        (words[word - 15] >>> 3);
      const s1 =
        rotateRight(words[word - 2], 17) ^
        rotateRight(words[word - 2], 19) ^
        (words[word - 2] >>> 10);
      words[word] =
        (words[word - 16] + s0 + words[word - 7] + s1) >>> 0;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];

    for (let word = 0; word < 64; word++) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[word] + words[word]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}
