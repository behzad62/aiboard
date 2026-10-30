# Release sequence recovery: design proposal (2026-10-31)

Status: **proposal for owner review.** Nothing here is implemented yet.

## What the sequence protects

Every signed release manifest carries a `sequence` (integer, 1 to 2^40). Installers and installed Runners refuse a manifest whose sequence is lower than:
- the installer's baked-in `minSequence`; or
- the highest sequence this machine already accepted, stored in `<install root>/sequence`.

This stops an attacker from re-serving an old, signed but vulnerable release. Signing now reserves each sequence with a `release-sequence/<channel>/<n>` tag, so two drafts can never share a number. `check-publication-order.mts` refuses to publish a manifest that goes backwards.

Normal releases never exhaust the space: 2^40 is about 1.1 trillion.

## How it can go wrong

| Case | Cause | Effect today |
|---|---|---|
| **A. Key compromise with a maximum sequence** | Someone holding the signing key also gets a manifest to users (needs control of `aiboard.me/release/...` or a delivery channel) with sequence 2^40, or any very high number. | Every machine that accepted it refuses every later legitimate release, forever. Updates cannot fix it, because the fix would need a higher sequence. |
| **B. Owner mistake** | The manual `--sequence` option accepts any value up to 2^40, so a typo (an extra digit, a timestamp) burns most of the space. | It cannot be undone after publication, and later releases must stay above it. This is recoverable only while space remains above the mistake, which is usually the case, but it is bad hygiene. |
| **C. Key compromise without exhaustion** | The signing key leaks, but the sequence is fine. | Covered by the existing key-compromise steps: pin a new key, and machines that trust only the old key must reinstall. |

Case A is the one with no procedure. Today it degrades into case C, except that a reinstall over the same install root still refuses: `install.ps1` and `install.sh` read the old `<root>/sequence` high-water mark. The user must delete the install root by hand.

## Proposal

### 1. Epochs: order by (epoch, sequence), not by sequence alone

- Add an integer `epoch` (default 0) to the manifest, `release/channel.json` and the local high-water record (`<root>/sequence` becomes `epoch:sequence`; a bare number reads as epoch 0).
- A manifest is newer when its epoch is higher, or when the epochs are equal and its sequence is higher.
- A new epoch may restart sequences at 1.

### 2. A separate, offline recovery key that alone can open a new epoch

- `channel.json` gains a `recoveryKeys` list, holding only public keys, which never sign ordinary releases.
- A manifest whose epoch is higher than the machine's current epoch is accepted only if it is signed by a recovery key. Ordinary signing keys stay valid within their epoch.
- The recovery key's private half is generated and kept offline, like a TUF root key: hardware token or paper, never in GitHub secrets, used only during a declared incident.
- An epoch-bump manifest also carries the new signing key set. Installed Runners therefore move to a new key and a new epoch through an ordinary update, with no reinstall, as long as the recovery key itself was not compromised.

**Why this matters:** without a pre-installed recovery key, every installed Runner trusts only keys that shipped with it, so recovering from case A always needs a reinstall. Recovery keys have to ship before an incident, which means in the first signed release, to help at all.

### 3. Reinstall resets the high-water mark only for a new trust anchor

- Store, next to the high-water record, a digest of the trust anchor that accepted it (channel keys plus recovery keys plus epoch).
- An installer with a different anchor ignores the old high-water mark instead of refusing. One with the same anchor keeps enforcing it, so replay protection still holds.
- Remove the "delete the install root by hand" step from case A, so user state (which lives in the state directory, not the install root) is never at risk.

### 4. A guard on large sequence jumps (case B)

- `sign-manifest --sequence N` refuses `N > previous + 1000`, unless `--allow-sequence-jump <reason>` is given. The reason is recorded in the reservation tag message.
- Automatic selection is already `max(previous + 1, highest reservation + 1)`; it is unaffected.

## Owner procedure after implementation (case A)

1. Declare the incident, and stop the release workflow by disabling it.
2. Generate a new signing key offline, then pin it with `release-keys.mts pin`.
3. Using the offline recovery key, sign an epoch-bump manifest with `epoch = current + 1` and `sequence = 1`, carrying the new signing key set and a release built from known-good source.
4. Publish it. Installed Runners update into the new epoch and drop the compromised key.
5. Rotate the GitHub `AIBOARD_RELEASE_SIGNING_KEY` secret to the new key, and remove the compromised key from `channel.json`.
6. If the recovery key itself is suspected compromised: reinstall-only. Publish new installers with a new recovery key, and announce the reinstall. This is today's case C procedure, plus decision 3.

## Decisions needed from the owner

1. Adopt epochs plus an offline recovery key (recommended), or accept reinstall-only recovery for case A?
2. If adopted: the recovery key must be generated and pinned **before the first signed release**, so that release ships it. This adds one offline key ceremony to the L2 first-release steps.
3. The threshold for the sequence-jump guard (proposed: 1000).

## Implementation outline (once approved)

- `release-manifest.ts`: add the `epoch` field and the `recoveryKeys` config; use (epoch, sequence) ordering; accept an epoch bump only with a recovery signature.
- `self-update.ts`: store the `epoch:sequence` high-water mark and the anchor digest.
- `install.ps1` and `install.sh`: the same ordering, plus the anchor-digest reset rule.
- `sign-manifest.mts`, `signing-sequence.mts` and `sequence-reservation.mts`: add epoch-aware reservation tags (`release-sequence/<channel>/<epoch>/<n>`) and the jump guard.
- `release-keys.mts`: add the `pin-recovery` and `sign-epoch` commands, and `verify` support for epochs.
- Tests:
  - a replay within an epoch is refused;
  - an epoch bump without a recovery signature is refused;
  - an epoch bump with one is accepted and resets the sequence;
  - a reinstall with a new anchor ignores the old high-water mark, while the same anchor still enforces it;
  - the jump guard works.
