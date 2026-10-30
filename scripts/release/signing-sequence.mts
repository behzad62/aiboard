// Signing-time monotonicity; historical manifests are authenticated even when expired.
import { verifyHistoricalReleaseManifest, verifyReleaseManifest, type ReleaseChannelConfig } from "../../runner-v2/src/release-manifest.js";

export function selectReleaseSequence(
  option: string,
  config: ReleaseChannelConfig,
  previous: { bytes: Uint8Array; signature: string } | undefined,
  now: Date,
): number {
  const prior = previous ? verifyHistoricalReleaseManifest(previous.bytes, previous.signature, config, now) : undefined;
  if (option === "auto") {
    if (previous) verifyReleaseManifest(previous.bytes, previous.signature, config, { now });
    const next = prior ? prior.sequence + 1 : config.minSequence;
    if (!Number.isSafeInteger(next) || next > 2 ** 40) throw new Error("No higher release sequence is available.");
    return next;
  }
  if (!/^[0-9]+$/.test(option)) throw new Error("--sequence must be an integer.");
  const sequence = Number(option);
  if (!Number.isSafeInteger(sequence) || sequence < config.minSequence || sequence > 2 ** 40) {
    throw new Error(`--sequence must be an integer >= ${config.minSequence} and <= ${2 ** 40}.`);
  }
  if (prior && sequence <= prior.sequence) throw new Error(`--sequence must be higher than the authenticated previous sequence ${prior.sequence}.`);
  return sequence;
}
