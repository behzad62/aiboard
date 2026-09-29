import type {
  GeneratedArtifactRef,
  ProviderArtifactPayload,
  ProviderArtifactSink,
} from "../providers/provider-events";
import type { ProviderArtifactStorage } from "./storage-adapter";

function toBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array
    ? value.slice()
    : new Uint8Array(value.slice(0));
}

function defaultArtifactId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `artifact-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class StorageProviderArtifactSink implements ProviderArtifactSink {
  constructor(
    private readonly storage: ProviderArtifactStorage,
    private readonly createId: () => string = defaultArtifactId,
  ) {}

  async persist(payload: ProviderArtifactPayload): Promise<GeneratedArtifactRef> {
    const id = payload.id ?? this.createId();
    const bytes = toBytes(payload.bytes);
    const storageRef = await this.storage.saveProviderArtifact(id, bytes);
    return {
      id,
      ...(payload.mimeType ? { mimeType: payload.mimeType } : {}),
      ...(payload.filename ? { filename: payload.filename } : {}),
      size: bytes.byteLength,
      storageRef,
    };
  }
}
