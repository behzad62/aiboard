# Runner V2 Download Design

## Problem

The published AI Board app requires native Runner V2, but it only explains the repository-only `npm run runner:v2` command. Deployment publishes the account-provider and benchmark transports while deliberately retiring the legacy browser Build runner. No native Runner V2 distribution replaces it, so a user of the hosted app cannot obtain the required process.

## Decision

Publish `/aiboard-runner-v2.zip` as a source distribution of the native kernel. The archive contains Runner V2 source, built-in skills, a standalone package manifest, setup/start scripts, and a README. It does not contain or restore the retired browser runner.

The package supports Node.js 24.18.0 or newer and requires Git. Installation uses pinned `tsx` and `playwright` dependencies. A setup command installs Chromium; a start command launches `src/cli.ts` and forwards the user's `--project`, `--state-dir`, and `--port` arguments.

## Product experience

Both the inline Build setup and `/runner-guide` expose a prominent Runner V2 ZIP download. Instructions are written for a hosted-app user: download, extract, run `npm install`, run the browser setup command, then start Runner V2 from the extracted directory. Repository contributor instructions remain valid but are secondary.

## Deployment and failure behavior

`scripts/publish-downloads.mjs` creates the ZIP deterministically enough for deployment validation and fails the build if required Runner V2 files are absent. Static export copies it from `public/` to `out/`. Deployment tests inspect both archives and require the package manifest, README, CLI source, and built-in skills. Existing checks continue proving the legacy browser runner stays retired.

## Scope

This change distributes the existing native kernel. It does not build a platform-specific executable, bundle Node.js or Git, auto-start a process from the browser, or change Runner V2 scheduling/runtime behavior.
