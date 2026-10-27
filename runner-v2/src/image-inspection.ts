import { createHash } from "node:crypto";
import { crc32, deflateSync, inflateSync } from "node:zlib";

/**
 * Local image inspection (N4). Content type is detected from bytes, never from a file name.
 * PNG is decoded (bounded) so it can be cropped/downscaled; JPEG and WebP are probed from their
 * headers and delivered unchanged when already within delivery limits. SVG is text and is never
 * executed or rasterized here.
 */
export type InspectableImageType = "image/png" | "image/jpeg" | "image/webp";

export const IMAGE_LIMITS = Object.freeze({
  maxSourceBytes: 20 * 1024 * 1024,
  maxSourcePixels: 50_000_000,
  maxSourceSide: 20_000,
  /** Raw bytes delivered to a provider (≈5 MiB once base64-encoded). */
  maxDeliveredBytes: 3_750_000,
  /** Providers reject or silently rescale beyond this side. */
  maxDeliveredSide: 8_000,
  defaultMaxDimension: 1_568,
  minMaxDimension: 64,
  maxMaxDimension: 2_048,
});

export interface ImageProbe {
  readonly mediaType: InspectableImageType;
  readonly width: number;
  readonly height: number;
  /** EXIF orientation 1-8 when present (JPEG); 1 means upright. */
  readonly orientation?: number;
  readonly interlaced?: boolean;
}

export interface ImageCrop { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export interface PreparedImage {
  readonly bytes: Buffer;
  readonly mediaType: InspectableImageType;
  readonly width: number;
  readonly height: number;
  readonly sourceDigest: string;
  readonly digest: string;
  readonly source: ImageProbe & { readonly byteLength: number };
  /** Applied transforms, in order. Empty when the original bytes are delivered. */
  readonly transforms: readonly string[];
  readonly notes: readonly string[];
}

export class ImageInspectionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ImageInspectionError"; }
}

export function detectImageType(bytes: Uint8Array): InspectableImageType | "image/svg+xml" | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 1024))).toString("utf8").replace(/^﻿/, "").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return undefined;
}

export function probeImage(bytes: Uint8Array): ImageProbe {
  if (bytes.byteLength > IMAGE_LIMITS.maxSourceBytes) throw new ImageInspectionError("image_too_large", `Image exceeds ${IMAGE_LIMITS.maxSourceBytes} bytes.`);
  const type = detectImageType(bytes);
  if (type === "image/svg+xml") throw new ImageInspectionError("image_format_unsupported", "SVG is text, not a raster image: read it with fs.read, or open it in the browser and use browser.screenshot to see it rendered. SVG content is never executed here.");
  if (!type) throw new ImageInspectionError("image_format_unsupported", "Not a PNG, JPEG or WebP image (content was checked, not the file name).");
  const probe = type === "image/png" ? probePng(bytes) : type === "image/jpeg" ? probeJpeg(bytes) : probeWebp(bytes);
  if (!Number.isSafeInteger(probe.width) || !Number.isSafeInteger(probe.height) || probe.width < 1 || probe.height < 1) throw new ImageInspectionError("image_corrupt", "Image dimensions are invalid.");
  if (probe.width > IMAGE_LIMITS.maxSourceSide || probe.height > IMAGE_LIMITS.maxSourceSide || probe.width * probe.height > IMAGE_LIMITS.maxSourcePixels)
    throw new ImageInspectionError("image_too_large", `Image dimensions ${probe.width}x${probe.height} exceed the decompression limits (${IMAGE_LIMITS.maxSourceSide}px side, ${IMAGE_LIMITS.maxSourcePixels} pixels).`);
  return probe;
}

/** Validate, optionally crop/downscale (PNG), and bound an image for model delivery. Source bytes are never modified. */
export function prepareImageForModel(bytes: Uint8Array, options: Readonly<{ crop?: ImageCrop; maxDimension?: number }> = {}): PreparedImage {
  const source = Buffer.from(bytes);
  const probe = probeImage(source);
  const maxDimension = options.maxDimension ?? IMAGE_LIMITS.defaultMaxDimension;
  if (!Number.isSafeInteger(maxDimension) || maxDimension < IMAGE_LIMITS.minMaxDimension || maxDimension > IMAGE_LIMITS.maxMaxDimension)
    throw new ImageInspectionError("invalid_arguments", `maxDimension must be ${IMAGE_LIMITS.minMaxDimension}..${IMAGE_LIMITS.maxMaxDimension}.`);
  if (options.crop) validateCrop(options.crop, probe);
  const sourceDigest = sha256(source);
  const notes: string[] = [];
  const needsResize = Math.max(options.crop?.width ?? probe.width, options.crop?.height ?? probe.height) > maxDimension;
  if (probe.orientation && probe.orientation !== 1) notes.push(`EXIF orientation ${probe.orientation} was not applied (${orientationHint(probe.orientation)}).`);
  if (probe.mediaType !== "image/png") {
    if (options.crop) throw new ImageInspectionError("image_transform_unsupported", `Cropping ${probe.mediaType} is not supported (only PNG is decoded locally). Inspect the whole image or use a PNG.`);
    if (source.byteLength > IMAGE_LIMITS.maxDeliveredBytes || Math.max(probe.width, probe.height) > IMAGE_LIMITS.maxDeliveredSide)
      throw new ImageInspectionError("image_too_large", `This ${probe.mediaType} (${probe.width}x${probe.height}, ${source.byteLength} bytes) exceeds delivery limits and cannot be downscaled locally; use a smaller or PNG image.`);
    if (needsResize) notes.push(`Delivered at original ${probe.width}x${probe.height}; ${probe.mediaType} is not resized locally and the provider may downscale it.`);
    return Object.freeze({ bytes: source, mediaType: probe.mediaType, width: probe.width, height: probe.height, sourceDigest, digest: sourceDigest,
      source: Object.freeze({ ...probe, byteLength: source.byteLength }), transforms: Object.freeze([]), notes: Object.freeze(notes) });
  }
  if (!options.crop && !needsResize && source.byteLength <= IMAGE_LIMITS.maxDeliveredBytes) {
    return Object.freeze({ bytes: source, mediaType: "image/png", width: probe.width, height: probe.height, sourceDigest, digest: sourceDigest,
      source: Object.freeze({ ...probe, byteLength: source.byteLength }), transforms: Object.freeze([]), notes: Object.freeze(notes) });
  }
  let image = decodePng(source);
  const transforms: string[] = [];
  if (options.crop) { image = cropRgba(image, options.crop); transforms.push(`crop ${options.crop.x},${options.crop.y} ${options.crop.width}x${options.crop.height}`); }
  let limit = maxDimension, encoded: Buffer;
  for (;;) {
    let current = image;
    if (Math.max(current.width, current.height) > limit) {
      const scale = limit / Math.max(current.width, current.height);
      current = resizeRgba(current, Math.max(1, Math.round(current.width * scale)), Math.max(1, Math.round(current.height * scale)));
    }
    encoded = encodePng(current);
    if (encoded.byteLength <= IMAGE_LIMITS.maxDeliveredBytes || limit <= IMAGE_LIMITS.minMaxDimension) {
      if (current !== image) transforms.push(`resize ${current.width}x${current.height}`);
      image = current; break;
    }
    limit = Math.max(IMAGE_LIMITS.minMaxDimension, Math.floor(limit * 0.75));
  }
  if (encoded.byteLength > IMAGE_LIMITS.maxDeliveredBytes) throw new ImageInspectionError("image_too_large", "The image cannot be reduced below the delivery byte limit.");
  return Object.freeze({ bytes: encoded, mediaType: "image/png", width: image.width, height: image.height, sourceDigest, digest: sha256(encoded),
    source: Object.freeze({ ...probe, byteLength: source.byteLength }), transforms: Object.freeze(transforms), notes: Object.freeze(notes) });
}

// ---------------------------------------------------------------- probes

function probePng(bytes: Uint8Array): ImageProbe {
  if (bytes.length < 33 || ascii(bytes, 12, 16) !== "IHDR") throw new ImageInspectionError("image_corrupt", "PNG header is invalid.");
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { mediaType: "image/png", width: view.readUInt32BE(16), height: view.readUInt32BE(20), interlaced: view[28] === 1 };
}

function probeJpeg(bytes: Uint8Array): ImageProbe {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2, orientation: number | undefined;
  while (offset + 4 <= view.length) {
    if (view[offset] !== 0xff) throw new ImageInspectionError("image_corrupt", "JPEG marker stream is invalid.");
    const marker = view[offset + 1]!;
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { offset += 2; continue; }
    const length = view.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > view.length) throw new ImageInspectionError("image_corrupt", "JPEG segment length is invalid.");
    if (marker === 0xe1 && ascii(view, offset + 4, offset + 8) === "Exif") orientation = exifOrientation(view.subarray(offset + 10, offset + 2 + length));
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { mediaType: "image/jpeg", height: view.readUInt16BE(offset + 5), width: view.readUInt16BE(offset + 7), ...(orientation ? { orientation } : {}) };
    }
    if (marker === 0xda) break;
    offset += 2 + length;
  }
  throw new ImageInspectionError("image_corrupt", "JPEG has no frame header.");
}

function exifOrientation(tiff: Buffer): number | undefined {
  if (tiff.length < 8) return undefined;
  const little = ascii(tiff, 0, 2) === "II";
  const read16 = (at: number) => little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
  const read32 = (at: number) => little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
  const ifd = read32(4);
  if (ifd + 2 > tiff.length) return undefined;
  const count = read16(ifd);
  for (let index = 0; index < count && ifd + 2 + index * 12 + 12 <= tiff.length; index++) {
    const entry = ifd + 2 + index * 12;
    if (read16(entry) === 0x0112) { const value = read16(entry + 8); return value >= 1 && value <= 8 ? value : undefined; }
  }
  return undefined;
}

function probeWebp(bytes: Uint8Array): ImageProbe {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.length < 30) throw new ImageInspectionError("image_corrupt", "WebP header is invalid.");
  const chunk = ascii(view, 12, 16);
  if (chunk === "VP8 ") return { mediaType: "image/webp", width: view.readUInt16LE(26) & 0x3fff, height: view.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = view.readUInt32LE(21);
    return { mediaType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { mediaType: "image/webp", width: view.readUIntLE(24, 3) + 1, height: view.readUIntLE(27, 3) + 1 };
  throw new ImageInspectionError("image_corrupt", "WebP chunk is not recognized.");
}

// ---------------------------------------------------------------- PNG codec (bounded)

export interface RgbaImage { readonly width: number; readonly height: number; readonly data: Uint8Array }

export function decodePng(bytes: Uint8Array): RgbaImage {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const probe = probePng(view);
  if (probe.width * probe.height > IMAGE_LIMITS.maxSourcePixels) throw new ImageInspectionError("image_too_large", "PNG exceeds the pixel limit.");
  let offset = 8, bitDepth = 0, colorType = 0, interlace = 0, palette: Buffer | undefined, transparency: Buffer | undefined;
  const idat: Buffer[] = [];
  let idatBytes = 0, ended = false;
  while (offset + 12 <= view.length) {
    const length = view.readUInt32BE(offset), type = ascii(view, offset + 4, offset + 8);
    if (offset + 12 + length > view.length) throw new ImageInspectionError("image_corrupt", "PNG chunk is truncated.");
    const data = view.subarray(offset + 8, offset + 8 + length);
    if ((crc32(view.subarray(offset + 4, offset + 8 + length)) >>> 0) !== view.readUInt32BE(offset + 8 + length)) throw new ImageInspectionError("image_corrupt", `PNG ${type} chunk checksum is invalid.`);
    if (type === "IHDR") { bitDepth = data[8]!; colorType = data[9]!; interlace = data[12]!; }
    else if (type === "PLTE") palette = data;
    else if (type === "tRNS") transparency = data;
    else if (type === "IDAT") { idat.push(data); idatBytes += length; if (idatBytes > IMAGE_LIMITS.maxSourceBytes) throw new ImageInspectionError("image_too_large", "PNG data exceeds its bound."); }
    else if (type === "IEND") { ended = true; break; }
    offset += 12 + length;
  }
  if (!ended || !idat.length) throw new ImageInspectionError("image_corrupt", "PNG is incomplete.");
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels || ![1, 2, 4, 8, 16].includes(bitDepth) || (colorType === 3 && !palette)) throw new ImageInspectionError("image_corrupt", "PNG color format is invalid.");
  if (interlace !== 0) throw new ImageInspectionError("image_transform_unsupported", "Interlaced PNG cannot be cropped or resized locally; inspect it whole or re-save it non-interlaced.");
  const bitsPerPixel = channels * bitDepth, stride = Math.ceil(probe.width * bitsPerPixel / 8), bpp = Math.max(1, bitsPerPixel >> 3);
  const expected = probe.height * (stride + 1);
  let raw: Buffer;
  // The exact decompressed size is known from the header: anything larger is a decompression bomb.
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected }); }
  catch { throw new ImageInspectionError("image_corrupt", "PNG pixel data does not match its header (or exceeds it)."); }
  if (raw.length !== expected) throw new ImageInspectionError("image_corrupt", "PNG pixel data length does not match its header.");
  const out = new Uint8Array(probe.width * probe.height * 4);
  let previous = new Uint8Array(stride);
  for (let row = 0; row < probe.height; row++) {
    const filter = raw[row * (stride + 1)]!;
    const line = new Uint8Array(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)));
    for (let index = 0; index < stride; index++) {
      const left = index >= bpp ? line[index - bpp]! : 0, up = previous[index]!, upLeft = index >= bpp ? previous[index - bpp]! : 0;
      const value = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, upLeft) : -1;
      if (value < 0) throw new ImageInspectionError("image_corrupt", "PNG filter type is invalid.");
      line[index] = (line[index]! + value) & 0xff;
    }
    for (let x = 0; x < probe.width; x++) {
      const sample = (channel: number) => {
        if (bitDepth === 8) return line[x * channels + channel]!;
        if (bitDepth === 16) return line[(x * channels + channel) * 2]!;
        const bit = (x * channels + channel) * bitDepth, byte = line[bit >> 3]!, shift = 8 - bitDepth - (bit & 7);
        const value = (byte >> shift) & ((1 << bitDepth) - 1);
        return colorType === 3 ? value : Math.round(value * 255 / ((1 << bitDepth) - 1));
      };
      const target = (row * probe.width + x) * 4;
      if (colorType === 3) {
        const index = sample(0);
        if (index * 3 + 2 >= palette!.length) throw new ImageInspectionError("image_corrupt", "PNG palette index is out of range.");
        out[target] = palette![index * 3]!; out[target + 1] = palette![index * 3 + 1]!; out[target + 2] = palette![index * 3 + 2]!;
        out[target + 3] = transparency && index < transparency.length ? transparency[index]! : 255;
      } else if (colorType === 0 || colorType === 4) {
        const gray = sample(0); out[target] = gray; out[target + 1] = gray; out[target + 2] = gray; out[target + 3] = colorType === 4 ? sample(1) : 255;
      } else {
        out[target] = sample(0); out[target + 1] = sample(1); out[target + 2] = sample(2); out[target + 3] = colorType === 6 ? sample(3) : 255;
      }
    }
    previous = line;
  }
  return { width: probe.width, height: probe.height, data: out };
}

export function encodePng(image: RgbaImage): Buffer {
  const stride = image.width * 4;
  const raw = Buffer.alloc(image.height * (stride + 1));
  for (let row = 0; row < image.height; row++) {
    // Sub filter: cheap and compresses screenshots well.
    raw[row * (stride + 1)] = 1;
    for (let index = 0; index < stride; index++) {
      const value = image.data[row * stride + index]!, left = index >= 4 ? image.data[row * stride + index - 4]! : 0;
      raw[row * (stride + 1) + 1 + index] = (value - left) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0); header.writeUInt32BE(image.height, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

export function cropRgba(image: RgbaImage, crop: ImageCrop): RgbaImage {
  const data = new Uint8Array(crop.width * crop.height * 4);
  for (let row = 0; row < crop.height; row++) {
    const from = ((crop.y + row) * image.width + crop.x) * 4;
    data.set(image.data.subarray(from, from + crop.width * 4), row * crop.width * 4);
  }
  return { width: crop.width, height: crop.height, data };
}

/** Area-average downscale (box filter); never upscales. */
export function resizeRgba(image: RgbaImage, width: number, height: number): RgbaImage {
  if (width >= image.width && height >= image.height) return image;
  const data = new Uint8Array(width * height * 4);
  const xScale = image.width / width, yScale = image.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * yScale), y1 = Math.max(y0 + 1, Math.min(image.height, Math.floor((y + 1) * yScale)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * xScale), x1 = Math.max(x0 + 1, Math.min(image.width, Math.floor((x + 1) * xScale)));
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        const at = (sy * image.width + sx) * 4, alpha = image.data[at + 3]!;
        r += image.data[at]! * alpha; g += image.data[at + 1]! * alpha; b += image.data[at + 2]! * alpha; a += alpha;
      }
      const count = (y1 - y0) * (x1 - x0), target = (y * width + x) * 4;
      if (a > 0) { data[target] = Math.round(r / a); data[target + 1] = Math.round(g / a); data[target + 2] = Math.round(b / a); }
      data[target + 3] = Math.round(a / count);
    }
  }
  return { width, height, data };
}

function validateCrop(crop: ImageCrop, probe: ImageProbe): void {
  for (const key of ["x", "y", "width", "height"] as const) if (!Number.isSafeInteger(crop[key]) || crop[key] < 0) throw new ImageInspectionError("invalid_arguments", `crop.${key} must be a non-negative integer.`);
  if (crop.width < 1 || crop.height < 1 || crop.x + crop.width > probe.width || crop.y + crop.height > probe.height)
    throw new ImageInspectionError("invalid_arguments", `crop must lie within the ${probe.width}x${probe.height} image.`);
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft, pa = Math.abs(estimate - left), pb = Math.abs(estimate - up), pc = Math.abs(estimate - upLeft);
  return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}
function orientationHint(value: number): string {
  return ({ 2: "mirrored horizontally", 3: "rotated 180°", 4: "mirrored vertically", 5: "mirrored and rotated 90° counter-clockwise", 6: "rotate 90° clockwise to view upright", 7: "mirrored and rotated 90° clockwise", 8: "rotate 90° counter-clockwise to view upright" } as Record<number, string>)[value] ?? "unknown";
}
function ascii(bytes: Uint8Array, start: number, end: number): string { return Buffer.from(bytes.subarray(start, end)).toString("latin1"); }
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
