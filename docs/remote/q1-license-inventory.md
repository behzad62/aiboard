# Q1 license and provenance inventory

Taken 2026-11-05 from each repo's `package-lock.json` and installed `package.json` files, following the same dependency walk the release build uses (`scripts/release/build-bundle.mts`). This isn't legal advice, and license fields can be wrong: only the one license that needed a judgment was read in full. The others come from package metadata.

## Result

Nothing found blocks distribution. There's no GPL, AGPL, LGPL, SSPL or unknown license among the npm packages of either product.

One thing to keep doing: the Copilot package has its own license with conditions, listed below.

## Runner bundle

The bundle's root packages are `@github/copilot-sdk`, `@modelcontextprotocol/server`, `playwright` and `typescript`.

| License | Packages in the walk |
|---|---|
| Apache-2.0 | 6 |
| MIT | 4 |
| GitHub Copilot CLI License | 9 (1 shipped, 8 platform packages not shipped) |

Also shipped:
- **Node.js** runtime, with its own `LICENSE` file included as `node/LICENSE`. Hashes are pinned in `release/node-runtime.json`.
- AIBoard's own `LICENSE`, `NOTICE` and `TRADEMARKS.md`.

Not shipped:
- **Playwright's browser** isn't in the bundle.
- **The Copilot platform packages** (about 270 MB) are downloaded on first use and verified against a pin (`runner-v2/src/copilot-runtime.ts`).

### GitHub Copilot CLI License

`@github/copilot` isn't under an open-source license. It allows redistribution only if all of these hold, and how we ship it appears to meet each one:

| Condition | How the bundle meets it |
|---|---|
| Unmodified | Files are copied as installed, and the build checks each version against the lockfile |
| Part of an application with substantial functionality of its own | It's one optional provider inside the Runner |
| Not distributed alone or as the main product | Same |
| Includes the license and keeps notices | The build copies the whole package folder, including `LICENSE.md` |
| Our application is licensed separately | AIBoard Community Source License |

This was checked from the build code, not by unpacking a released bundle. The license ends automatically if its terms are broken, so re-read it when upgrading this package.

## Relay image

| License | Packages |
|---|---|
| MIT | 42 |
| Apache-2.0 | 3 |
| ISC | 2 |

Also in the image:
- **Fonts**: Inter, Fraunces and JetBrains Mono under the SIL Open Font License 1.1, listed in `packages/relay/assets/fonts/LICENSE.md`.
- **Node base image**, pinned by digest. **Its operating system packages weren't inventoried.** They come with the base image under their own licenses, some of them GPL. That's normal for a container image. Users aren't given this image: it comes from a private repo, and only we run it.

## Plugin defaults

None found: a search of the Runner source shows no plugin installed by default. The plugin catalog is planned for after launch (X1) and needs its own check when built.

## Provenance

| Item | How it's pinned |
|---|---|
| npm packages | `package-lock.json` with integrity hashes |
| Node in the Runner | Official builds, with hashes from GPG-verified `SHASUMS` |
| Runner release | Signed manifest, and bundles must be byte-identical across Linux and Windows builds |
| Relay image | Digest-pinned base, deployed by digest |

## Not checked

- Whether package metadata matches each package's actual license text, apart from Copilot.
- Licenses of code vendored inside packages.
- Known vulnerabilities: this is a license check, not `npm audit`.

## Repeating it

Rerun when dependencies change materially, and before Stage 2. The walk is short: start from `RUNTIME_PACKAGES` in `scripts/release/bundle-contents.mts` and from each relay package's `dependencies`, then read `license` from the lockfile.
