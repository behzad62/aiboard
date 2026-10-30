// Durable release-sequence reservations for the signing job (plan D18, ADR-E).
// Each signing run creates one annotated tag refs/tags/release-sequence/<channel>/<n> on the release
// repository BEFORE it signs. Creating a tag ref is atomic: a push never replaces an existing tag with a
// different object without --force, and each reservation is a unique tag object (run id + nonce), so two
// runs can never both hold the same sequence, even if the workflow's concurrency group were bypassed or
// the earlier draft was deleted. The next run's floor is the highest reservation, not only the committed
// manifest. The run also refuses to sign unless its commit is still the tip of the release branch, so a
// queued run from an older checkout cannot sign with obsolete key policy.
// Owner setup: protect refs/tags/release-sequence/** against update and deletion (docs/remote/l2-release-owner-setup.md).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export type GitRunner = (args: string[]) => string;

export const RESERVATION_PREFIX = "refs/tags/release-sequence/";
const MAX_SEQUENCE = 2 ** 40;

export function gitRunner(cwd: string): GitRunner {
  return (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
}

export function reservationRef(channel: string, sequence: number): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(channel)) throw new Error(`Invalid channel ${channel}.`);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_SEQUENCE) throw new Error(`Invalid sequence ${sequence}.`);
  return `${RESERVATION_PREFIX}${channel}/${sequence}`;
}

/** sequence -> tag object id of every reservation on the remote for this channel. */
export function listReservations(git: GitRunner, remote: string, channel: string): Map<number, string> {
  const prefix = `${RESERVATION_PREFIX}${channel}/`;
  const reservations = new Map<number, string>();
  for (const line of git(["ls-remote", "--refs", remote, `${prefix}*`]).split("\n")) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{40,64})\trefs\/tags\/release-sequence\/([^/]+)\/([^/]+)$/.exec(line.trim());
    if (!match || `${RESERVATION_PREFIX}${match[2]}/` !== prefix) throw new Error(`Unexpected reservation ref: ${line.trim()}`);
    if (!/^[1-9][0-9]*$/.test(match[3]!) || Number(match[3]) > MAX_SEQUENCE) throw new Error(`Malformed reservation ref ${prefix}${match[3]}; refusing to choose a sequence.`);
    reservations.set(Number(match[3]), match[1]!);
  }
  return reservations;
}

/** The commit being signed must still be the tip of the release branch (current key policy and floor). */
export function assertBranchTip(git: GitRunner, remote: string, branch: string, commit: string): void {
  const line = git(["ls-remote", "--heads", remote, `refs/heads/${branch}`]).trim();
  const tip = /^([0-9a-f]{40,64})\trefs\/heads\//.exec(line)?.[1];
  if (!tip) throw new Error(`Cannot read ${remote} ${branch}; refusing to sign.`);
  if (tip !== commit) throw new Error(`${branch} moved to ${tip} after this release was dispatched at ${commit}; re-dispatch from the current ${branch} so the current key policy and sequence floor apply.`);
}

export interface ReserveOptions {
  git: GitRunner;
  remote: string;
  branch: string;
  channel: string;
  commit: string;
  /** Picks the sequence given the highest existing reservation (0 if none); must throw if none is acceptable. */
  choose: (reservedFloor: number) => number;
  runLabel?: string;
}

/** Reserves a fresh sequence by atomically creating its tag; returns the reserved sequence. */
export function reserveReleaseSequence(options: ReserveOptions): number {
  const { git, remote, channel, commit } = options;
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("--require-commit must be a full commit id to reserve a sequence.");
  assertBranchTip(git, remote, options.branch, commit);
  const existing = listReservations(git, remote, channel);
  const floor = Math.max(0, ...existing.keys());
  const sequence = options.choose(floor);
  if (existing.has(sequence) || sequence <= floor) throw new Error(`Sequence ${sequence} is already reserved (highest reservation ${floor}).`);
  const ref = reservationRef(channel, sequence);
  const name = ref.slice("refs/tags/".length);
  const nonce = `${options.runLabel ?? "local"} ${randomUUID()} ${new Date().toISOString()}`;
  git(["-c", "user.name=AIBoard release", "-c", "user.email=release@aiboard.invalid", "tag", "--no-sign", "-a", "-m", `Reserve ${channel} release sequence ${sequence}\n\n${nonce}`, name, commit]);
  try {
    const object = git(["rev-parse", ref]).trim();
    try { git(["push", "--porcelain", remote, `${ref}:${ref}`]); }
    catch (error) { throw new Error(`Could not reserve sequence ${sequence}; another signing run may hold it. Re-dispatch the release. (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`); }
    // Confirm the remote now holds exactly this run's tag object, not an identical-looking one.
    if (listReservations(git, remote, channel).get(sequence) !== object) throw new Error(`Sequence ${sequence} is reserved by another signing run; refusing to sign.`);
    return sequence;
  } finally {
    try { git(["tag", "-d", name]); } catch { /* local scratch tag only */ }
  }
}
