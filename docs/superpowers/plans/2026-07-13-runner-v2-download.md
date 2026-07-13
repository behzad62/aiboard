# Runner V2 Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make native Runner V2 downloadable and usable from the published static app.

**Architecture:** The existing download publisher will assemble a standalone ZIP from `runner-v2/src` and `runner-v2/skills`, plus generated package metadata and user instructions. The static UI links to that artifact, and deployment tests inspect both the pre-export and exported ZIPs.

**Tech Stack:** Node.js 24+, JSZip, Next.js static export, React 19, TypeScript, Playwright

## Global Constraints

- Product Build mode remains native Runner V2 only; never restore `runner.mjs`.
- Support Node.js 24.18.0 or newer and require Git.
- Runner state must remain outside the project.
- The archive must include built-in skills and browser setup instructions.

---

### Task 1: Specify the downloadable archive contract

**Files:**
- Modify: `scripts/test-deploy-runner-artifacts.mts`
- Modify: `scripts/test-native-build-cutover.mts`

**Interfaces:**
- Consumes: `public/` and `out/` artifacts produced by publish/build.
- Produces: assertions for `/aiboard-runner-v2.zip` contents and UI download links.

- [ ] **Step 1: Write failing assertions**

Require the public/exported ZIPs and inspect `package.json`, `README.md`, `src/cli.ts`, and every built-in `SKILL.md`. Require both Runner setup surfaces to link to `/aiboard-runner-v2.zip`.

- [ ] **Step 2: Run tests to verify RED**

Run `npx tsx scripts/test-deploy-runner-artifacts.mts` and `npx tsx scripts/test-native-build-cutover.mts`. Expected: failure because the ZIP and UI links do not exist.

### Task 2: Publish the standalone native Runner

**Files:**
- Modify: `scripts/publish-downloads.mjs`

**Interfaces:**
- Consumes: `runner-v2/src/**`, `runner-v2/skills/**`, and root dependency versions.
- Produces: `public/aiboard-runner-v2.zip`.

- [ ] **Step 1: Add minimal archive generation**

Use JSZip to copy Runner V2 source and built-in skills, then add a generated standalone `package.json` with `start`, `setup:browser`, `tsx`, and `playwright`, plus a README with exact hosted-user commands.

- [ ] **Step 2: Run publisher and archive test to verify GREEN**

Run `npm run publish-downloads` then `npx tsx scripts/test-deploy-runner-artifacts.mts`. Before static build, public checks pass and exported checks may still require the build.

### Task 3: Expose the download in product UI

**Files:**
- Modify: `components/RunnerSetup.tsx`
- Modify: `app/runner-guide/page.tsx`

**Interfaces:**
- Consumes: `/aiboard-runner-v2.zip`.
- Produces: visible download actions and extraction/install/start instructions.

- [ ] **Step 1: Add download actions and hosted-user instructions**

Link both surfaces directly to `/aiboard-runner-v2.zip` with the `download` attribute. Replace repository-only startup copy with extracted-package commands while keeping contributor guidance secondary.

- [ ] **Step 2: Run cutover and type checks**

Run `npx tsx scripts/test-native-build-cutover.mts` and `npx tsc --noEmit`. Expected: PASS.

### Task 4: Verify the deployed artifact path

**Files:**
- Verify: `.github/workflows/deploy-aiboard.yml`

**Interfaces:**
- Consumes: static `out/` output.
- Produces: a deployment that serves the archive and linked guide.

- [ ] **Step 1: Build and run deployment checks**

Run `npm run build`, `npx tsx scripts/test-deploy-runner-artifacts.mts`, and the deployment workflow contract test. Expected: both ZIP copies pass content inspection and retired browser artifacts remain absent.

- [ ] **Step 2: Commit and push**

Commit the focused source/test/docs changes and generated public archive as required by existing download artifact policy, push `main`, monitor deployment, then verify the published guide and ZIP URL.
