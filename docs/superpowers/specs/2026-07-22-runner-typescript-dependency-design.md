# Runner TypeScript Runtime Dependency Design

## Problem

The downloadable Runner V2 archive contains TypeScript source that imports the
`typescript` package at runtime. Its generated `package.json` currently declares
only `tsx` and `playwright`, so the documented `npm install` leaves the runner
unable to start. Users see `ERR_MODULE_NOT_FOUND` unless they manually install
TypeScript.

## User contract

The existing installation flow remains unchanged:

1. Run `npm install` in the extracted runner directory.
2. Run `npm run setup:browser`.
3. Start with `npm start -- --project ... --state-dir ... --port 8787`.

After step 1, every package imported by Runner V2 at runtime must be installed.
Users must not need to discover or install TypeScript separately.

## Design

`scripts/publish-downloads.mjs` will read the root TypeScript version using the
same pinned-version validation already used for `tsx` and Playwright. The
publisher will add that exact version to the standalone archive's generated
`dependencies` object.

This keeps the current source-distribution architecture and changes only the
missing runtime dependency. The runner source, CLI arguments, browser setup,
and installation instructions remain unchanged.

## Verification

The deploy artifact test will inspect the generated archive and assert that its
`package.json` contains the pinned TypeScript dependency. The public Runner V2
ZIP will be regenerated so downloads immediately contain the corrected
manifest.

A clean-install smoke check will extract the regenerated ZIP into a temporary
directory, run `npm install`, and confirm that the `typescript` import resolves
from that extracted package. Existing artifact reproducibility and content
checks must continue to pass.

## Scope

This change does not create a bundled executable, remove the documented npm or
Playwright setup steps, restructure `runner-v2/package.json`, or change Runner
V2 runtime behavior beyond making its existing TypeScript intelligence module
load successfully.
