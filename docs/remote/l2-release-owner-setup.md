# L2 — Release signing: owner setup and release checklist

Plan packet L2, ADR-E, owner decision D18 (GitHub Releases + CI signing in a protected environment).

## How trust flows
- **One signing key.** An RSA-3072 key signs `manifest.json`, which lists the six bundles with their size and SHA-256. Its private half lives only in:
  - the `release` GitHub environment secret;
  - your encrypted offline backups.
- **One separate offline recovery key.** Its public half is pinned in `recoveryKeys` before the first signed release. It can open a new epoch and replace ordinary signing keys, but cannot sign an ordinary release in the same epoch. Keep the private half offline, never in GitHub secrets.
- **The public half is pinned in `release/channel.json`.** From there it reaches every client in two ways:
  - **Installers.** `npm run publish-downloads` renders `public/install.ps1` and `public/install.sh` with the pinned keys baked in. This happens on every deploy of aiboard.me.
  - **Updater.** Every bundle carries `app/runner-v2/release-channel.json`, which `aiboard update` trusts. An installed Runner therefore trusts the keys that were pinned when *its* version was built.
- **Where the files are served:**
  - The signed manifest is served by aiboard.me from `public/release/stable/manifest.json` and `manifest.json.sig`. You commit these by hand. Every epoch-opening manifest and its signature also remain at sibling paths `epoch-<n>.json` and `epoch-<n>.json.sig` permanently.
  - The bundles are served from the GitHub release `v<version>` of `behzad62/aiboard`.
- **What gets verified:**
  - Installers and the updater verify the signature *before* parsing.
  - They then check expiry and replay (sequence).
  - Then the size and SHA-256 of the bundle.
  - Then the `release.json` inventory of the extracted files.
  - Then a smoke run.
  - Only after all of these does `current` switch. There is no unverified fallback: without `openssl`, `install.sh` stops.
- **Limit (ADR-E).** The one-line script itself (`irm | iex`, `curl | sh`) runs as soon as it arrives. It relies on HTTPS and on the integrity of aiboard.me. The manifest signature protects what the script downloads, not the script.

Until a key is pinned, `release/channel.json` has `"keys": []`. Both installers then print "AI Board Runner has not been released through the installer yet" and exit 1. Today's deploy is safe as-is.

## One-time setup

Do steps 1–3 on a machine you trust, ideally offline. Never paste key material into chat, an issue or the repository.

1. **Generate the key.** Choose a key id, such as `aiboard-release-2026a`.
   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out aiboard-release-2026a.pem
   openssl pkey -in aiboard-release-2026a.pem -pubout -out aiboard-release-2026a.pub.pem
   ```
   `genpkey` writes PKCS#8 (`BEGIN PRIVATE KEY`), which is what the workflow expects.
2. **Make an encrypted offline backup.**
   - Encrypt the key:
     ```bash
     openssl pkcs8 -topk8 -v2 aes-256-cbc -in aiboard-release-2026a.pem -out aiboard-release-2026a.enc.pem
     ```
   - Store `aiboard-release-2026a.enc.pem` on two offline media, for example two USB drives kept in different places.
   - Keep the passphrase separately, for example in your password manager.
   - Test once that the backup decrypts: `openssl pkey -in aiboard-release-2026a.enc.pem -noout`.
3. **Pin the public key.** Run this in a branch of this repository:
   ```bash
   npx tsx scripts/release/release-keys.mts pin --key-id aiboard-release-2026a --public-key aiboard-release-2026a.pub.pem
   ```
   - This adds `{keyId, n, e}` to `release/channel.json`.
   - It refuses a file containing `PRIVATE KEY`.
   - Commit the change, then check `npx tsx scripts/release/test-installers.mts`.
3a. **Generate and pin the recovery key offline before the first signed release.** On an offline trusted machine, generate a separate RSA-3072 key and public half, using the same commands as step 1 with a different name such as `aiboard-recovery-2026a`. Encrypt and test two offline backups as in step 2. Keep the private key and backups offline; never add it to GitHub secrets. Transfer only the public half to the repository and run:
   ```bash
   npx tsx scripts/release/release-keys.mts pin-recovery --key-id aiboard-recovery-2026a --public-key aiboard-recovery-2026a.pub.pem
   ```
   Review and commit the public `recoveryKeys` entry. The release workflow refuses to sign while the list is empty.
4. **Create the `release` environment.** In GitHub, open behzad62/aiboard → Settings → Environments → New environment → `release`.
   - **Required reviewers:** add yourself (`behzad62`). Leave "Prevent self-review" off, because you both dispatch and approve.
   - **Deployment branches and tags:** choose "Selected branches", then add `main` only.
   - **Environment secret** `AIBOARD_RELEASE_SIGNING_KEY`: the full PEM text of `aiboard-release-2026a.pem`. Set it from the file, so the key never passes through a clipboard or chat:
     ```bash
     gh secret set AIBOARD_RELEASE_SIGNING_KEY --env release --repo behzad62/aiboard < aiboard-release-2026a.pem
     ```
   - Then delete the unencrypted `aiboard-release-2026a.pem` from the machine. The encrypted backups remain.
5. **Protect the sequence reservations.** In GitHub, Settings → Rules → Rulesets → New tag ruleset:
   - target `release-sequence/**`;
   - restrict updates and deletions (bypass: nobody);
   - leave creation allowed, because the release workflow creates one tag per signing run.

   This keeps the reservation history durable. Without it, a deleted reservation tag could let a later run reuse that sequence.
6. **Merge to main.** Merge the L2 branch and the key pin to `main`. Pushing `main` redeploys aiboard.me.
   - The deployed installers now carry the key.
   - Until the first manifest is published, they fail closed: the manifest download fails, and nothing is installed.
   - To avoid that window, push the pin together with step 4 of the release checklist.

## Release checklist (every release)
1. **Prepare main.**
   - `main` has the code to ship.
   - The "Runner installer (L2)" workflow is green on its last PR. It is the T11 test against a locally signed test release, on Windows (both shells), macOS and Linux.
   - Check **rollback compatibility:** `aiboard update --rollback` runs the previous version against the state the new version wrote. A release must not change persisted state in a way the previous release cannot read, or its notes must say rollback is unsupported.
2. **Run the release workflow.** Actions → "Runner release (L2, manual)" → Run workflow on `main`.
   - **version:** `0.2.0`, for example. Tag `v0.2.0` must not exist yet.
   - **sequence:** `auto` picks one more than the highest committed and reserved sequence in the current epoch, or 1 for the first release in an epoch. An explicit sequence must be higher than both. A jump over 1000 from the previous committed sequence is refused unless the signing command receives `--allow-sequence-jump <reason>`; the reason is recorded in the reservation tag. The workflow does not supply an override.
   - **expires_days:** 180.

   The workflow then:
   - builds all six bundles on Linux and on Windows and requires them to be byte-identical;
   - runs `aiboard version` and `aiboard doctor` from each bundle on its own OS and CPU (`macos-15-intel` for darwin-x64, `windows-11-arm` for the win-arm64 preview);
   - waits for **your approval** of the `release` environment.
3. **Approve the signing job.** The signing job:
   - signs with `--require-commit`, which refuses bundles that were not built from a clean checkout of the dispatched commit;
   - refuses to sign if `main` has moved since the dispatch, so a queued run cannot sign with an older key policy; re-dispatch from the current `main`;
   - reserves its sequence before signing by creating the tag `release-sequence/stable/epoch-<epoch>/<n>` on the repository. Legacy `release-sequence/stable/<n>` tags count in epoch 0. Every run gets a different sequence, even if a draft is later deleted. A run whose reservation fails stops before signing; sequences may have gaps;
   - checks the signature again with `openssl`, exactly as `install.sh` does;
   - creates a **draft** release `v<version>` with the six bundles, `manifest.json` and `manifest.json.sig`.

   It never publishes the release and never touches aiboard.me.
4. **Publish.**
   - Review the draft, then publish it. This makes the bundle URLs in the manifest live.
   - Publish drafts in sequence order only. If a newer draft already exists, delete the older draft instead of publishing it.
   - Download the workflow artifact `signed-manifest-<version>` (or take `manifest.json` and `manifest.json.sig` from the release) and verify it. `verify` also refuses a manifest whose sequence is not higher than the committed one:
     ```bash
     npx tsx scripts/release/release-keys.mts verify --manifest manifest.json --bundles <folder with the six downloaded archives>
     ```
   - Copy both files to `public/release/stable/` and commit them.
   - Push `main`. This needs your approval because it redeploys aiboard.me. `publish-downloads` raises the installers' replay floor to this manifest's sequence. The deploy workflow first runs `check-publication-order.mts` and stops if a committed manifest went backwards or was removed since the previous deploy.
5. **Check.** On a clean machine or user account:
   - Windows: `irm https://aiboard.me/install.ps1 | iex`.
   - macOS/Linux: `curl -fsSL https://aiboard.me/install.sh | sh`.
   - Then open a new terminal and run `aiboard version`, then `aiboard remote`.
   - Existing installs pick the release up with `aiboard update`.

## Expiry
- A manifest is valid for `expires_days`, 180 by default. After that, installers and `aiboard update` refuse it: an expired manifest is treated as a possible replay.
- Cut a new release before expiry. A patch release with no changes is fine.
- Permanent epoch-opening files are trust history and may expire; the updater still verifies their recovery signatures when following a missed epoch. The currently served release must remain unexpired.
- The site keeps serving the newest manifest, so an expired manifest means no new installs until the next release.
- If the committed manifest has already expired, `sequence: auto` cannot verify it and stops. Dispatch with an explicit sequence instead: the expired manifest's sequence + 1.

## Interrupted install or update
- Install, update and uninstall share an `install.lock` directory. An existing lock is never deleted automatically: an empty, old, or malformed lock does not prove that its owner has stopped.
- If an operation reports that the lock exists, first confirm that no AIBoard installation, update, or uninstall is running for that user. Only then remove `install.lock` and retry. It is under `%LOCALAPPDATA%\AIBoard` on Windows and `~/.aiboard` on macOS/Linux.
- On Windows, `aiboard uninstall` hands its lock to `uninstall-pending.cmd`, which the command shim runs after Node exits. The lock is released only after that cleanup. If uninstall was started without the shim, it prints the script's path: run that script to finish. Until then, installs report the lock.
- An installer that cannot stop a hung staged process (the inventory check or the version smoke) keeps the lock, the staging folder and its work folder, and names the process. End that process before removing them.

## Key rotation (planned)
1. Generate a new key, back it up and pin it next to the old one (step 3). `release/channel.json` then lists both keys.
2. Cut a release still signed with the **old** key. Its bundles carry both keys, so updated installs trust the new key.
3. Replace the `AIBOARD_RELEASE_SIGNING_KEY` secret with the new key. From now on, releases are signed with the new key.
4. After most installs have updated, remove the old key from `release/channel.json` and cut another release. Before removing it, copy the channel configuration that authenticated the currently committed manifest to `release/previous-channel.json` and commit it. This file is a signing-time history witness only; installers and new bundles still trust only `release/channel.json`.

## Key compromise
Epoch-qualified reservation tags use `epoch-<n>`, so they do not collide with legacy sequence tags. Do not remove protected legacy tags.

1. Declare the incident and disable the release workflow. Preserve the current channel configuration as `release/previous-channel.json` for authentication of the published history. Keep the current installer anchor in place while the opening manifest is served.
2. Generate and back up a new ordinary signing key offline. Prepare a new channel configuration with `epoch` increased by one, only the replacement ordinary keys in `keys`, the same `recoveryKeys` and `manifestUrl`, and `minSequence: 1`. Keep the compromised key out of the new set.
3. Build known-good bundles. Create a schema-2 manifest template for those bundles using the new ordinary key and the new channel configuration, with sequence 1; keep that ordinary signature private and do not publish it. For example, use `sign-manifest.mts --channel-config <new-channel.json> --version <version> --bundles <bundle-dir> --out <template-dir> --sequence 1 --key-file <new-signing-key.pem>` with `release/previous-channel.json` present. Transfer the template and public configuration to the offline recovery machine. Create an output directory there and run:
   ```bash
   npx tsx scripts/release/release-keys.mts sign-epoch --config release/previous-channel.json --new-config <new-channel.json> --manifest <template-dir>/manifest.json --key-file <offline-recovery-key.pem> --out <recovery-output-dir>
   ```
   The output contains identical `manifest.json` / `epoch-<n>.json` bytes and corresponding `.sig` files. Verify `epoch-<n>.json` against `release/previous-channel.json` and the known-good archives using `release-keys.mts verify --config release/previous-channel.json --manifest <recovery-output-dir>/epoch-<n>.json --bundles <bundle-dir>`. Publish the bundles, then copy all four files into `public/release/stable/` and commit them together. Preserve the signed bytes exactly; use a checkout with `core.autocrlf=false` so Git does not convert manifest line endings. The `epoch-<n>.json` pair must remain byte-identical and available permanently, even after `manifest.json` is replaced; never overwrite or delete it. The deploy guard requires the opening files and rejects changes to previously deployed history, including on manual deploys. Protect and record this manual reservation in the release log before any other signing in the new epoch.
4. Keep the old-anchor installers and recovery-signed current manifest available for the opening deployment. The accepted opening replaces installed clients' ordinary signing keys. Updaters with this follow-up can also fetch permanent opening files in order after a later ordinary release replaces the current manifest. Verify the two `epoch-<n>.json` URLs after deployment. Missing or invalid history, a gap of more than 16 epochs, clients predating epoch support, or clients that never received the recovery public key require a reinstall with a new installer. Epoch-aware clients without this history-following follow-up also need to reinstall if they missed the opening.
5. Rotate the GitHub `AIBOARD_RELEASE_SIGNING_KEY` secret to the new ordinary key. Publish a subsequent ordinary release in the new epoch, then deploy its manifest together with the new channel configuration and installers. Coordinate or temporarily pause automatic site deployment so new-epoch installers are not served while the site still serves only the recovery-signed opening manifest: those installers correctly refuse a recovery signature within their own epoch. Resume the release workflow after the new policy is in place.
6. If the recovery key itself is suspected compromised, publish installers with a new recovery key and announce a reinstall. A reinstall with a different trust anchor ignores the previous install root's high-water mark; an older installation with no recorded anchor is also treated as unbound on reinstall. The installed updater still enforces its legacy bare-integer high-water mark. User state remains in its separate state directory.

## Bumping the bundled Node
1. Download `SHASUMS256.txt` and `SHASUMS256.txt.asc` for the new Node 24 version.
2. Verify the signature against a Node.js release key from https://github.com/nodejs/release-keys (24.18.0 was signed by C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C).
3. Copy the six sha256 values into `release/node-runtime.json`.

`build-bundle.mts` refuses any Node archive whose hash does not match the pins.
