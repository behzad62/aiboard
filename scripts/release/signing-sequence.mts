// Signing-time monotonicity; historical manifests are authenticated even when expired.
// `reservedFloor` is the highest sequence already reserved by any signing run (sequence-reservation.mts),
// so a draft cut before the previous draft's manifest was committed still gets a fresh sequence.
import { verifyHistoricalReleaseManifest, type ReleaseChannelConfig, type ReleaseManifest } from "../../runner-v2/src/release-manifest.js";

export function selectReleaseSequence(
  option: string,
  config: ReleaseChannelConfig,
  previous: { bytes: Uint8Array; signature: string } | undefined,
  now: Date,
  historicalConfig?: ReleaseChannelConfig,
  reservedFloor = 0,
  jumpReason?: string,
): number {
  if (historicalConfig && historicalConfig.channel !== config.channel) throw new Error("The historical channel must match the current channel.");
  let prior;
  if (previous) {
    try { prior = verifyHistoricalReleaseManifest(previous.bytes, previous.signature, config, now); }
    catch (currentError) {
      if (!historicalConfig) throw currentError;
      prior = verifyHistoricalReleaseManifest(previous.bytes, previous.signature, historicalConfig, now);
    }
  }
  const epoch = config.epoch ?? 0;
  const priorEpoch = prior?.epoch ?? 0;
  if (prior && priorEpoch > epoch) throw new Error("The previous manifest belongs to a newer epoch.");
  const priorSequence = prior && priorEpoch === epoch ? prior.sequence : 0;
  if (option === "auto") {
    if (prior && priorEpoch === epoch && Date.parse(prior.expiresAt) <= now.getTime()) throw new Error("The previous manifest has expired.");
    const next = Math.max(priorSequence + 1, reservedFloor + 1, config.minSequence);
    if (!Number.isSafeInteger(next) || next > 2 ** 40) throw new Error("No higher release sequence is available.");
    return next;
  }
  if (!/^[0-9]+$/.test(option)) throw new Error("--sequence must be an integer.");
  const sequence = Number(option);
  if (!Number.isSafeInteger(sequence) || sequence < config.minSequence || sequence > 2 ** 40) {
    throw new Error(`--sequence must be an integer >= ${config.minSequence} and <= ${2 ** 40}.`);
  }
  if (prior && priorEpoch === epoch && sequence <= prior.sequence) throw new Error(`--sequence must be higher than the authenticated previous sequence ${prior.sequence}.`);
  if (sequence <= reservedFloor) throw new Error(`--sequence must be higher than the highest reserved sequence ${reservedFloor}.`);
  if (sequence > priorSequence + 1000 && !jumpReason?.trim()) throw new Error("--sequence jumps more than 1000; supply --allow-sequence-jump with a reason.");
  return sequence;
}

/** Publication order: a manifest may replace the committed one only with a strictly higher sequence on the same channel. */
export function assertPublicationOrder(candidate: ReleaseManifest, committed: ReleaseManifest | undefined): void {
  if (!committed) return;
  if (candidate.channel !== committed.channel) throw new Error(`The manifest is for channel ${candidate.channel}, not ${committed.channel}.`);
  if ((candidate.epoch ?? 0) < (committed.epoch ?? 0) || ((candidate.epoch ?? 0) === (committed.epoch ?? 0) && candidate.sequence <= committed.sequence)) {
    throw new Error(`Sequence ${candidate.sequence} is not higher than the committed manifest's ${committed.sequence}; publish drafts in sequence order and never republish an older one.`);
  }
}
