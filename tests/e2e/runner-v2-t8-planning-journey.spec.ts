import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArtifactStore } from "../../runner-v2/src/artifact-store.js";
import { ControlServer } from "../../runner-v2/src/control-server.js";
import { createExecutionHost } from "../../runner-v2/src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../../runner-v2/src/native-build-factory.js";
import { NativeBuildManager } from "../../runner-v2/src/native-build-manager.js";
import type {
  PlanningExportDocument,
  PlanningReadinessSnapshot,
} from "../../runner-v2/src/planning-controls.js";
import { RunSupervisor } from "../../runner-v2/src/run-supervisor.js";
import type { SchedulerProjection } from "../../runner-v2/src/scheduler-store.js";
import type { ApprovedSourceManifest } from "../../runner-v2/src/source-manifest.js";
import { SqliteBuildSpecStore } from "../../runner-v2/src/sqlite-build-spec-store.js";
import { SqliteEventStore } from "../../runner-v2/src/sqlite-event-store.js";
import {
  NativeBuildFactory as FixtureNativeBuildFactory,
  captureGitBaseline,
} from "../../runner-v2/test/support/git-fixture.js";
import {
  T8_CLOCK,
  T8_SOURCE,
  T8_VALUE_TEST,
  T8JourneyArchitect,
  T8JourneyCoverageReviewer,
  T8JourneyWorker,
  t8JourneyScenario,
  t8JourneySections,
  t8Provider,
  t8SourceInput,
} from "../../runner-v2/test/support/t8-planning-journey.js";
import { displayedPlanStart } from "../../lib/client/native-planning-view";
import {
  exportNativePlanning,
  getNativeContextManifests,
  getNativePlanningSchedule,
} from "../../lib/client/runner-v2";

const RUN_ID = "run_t8_planning_journey_e2e";
const DISCUSSION_ID = "discussion-t8-planning-journey-e2e";
const TOKEN = "t8-planning-journey-e2e-token";

test.describe("Runner V2 T8 evidence-gated planning browser journey", () => {
  test("Runner V2 T8 source->plan->review->export->explicit-start proves integrated browser surface", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const root = mkdtempSync(join(tmpdir(), "runner-v2-t8-planning-journey-"));
    let server: ControlServer | undefined;
    let supervisor: RunSupervisor | undefined;
    let factory: FixtureNativeBuildFactory | undefined;
    let manager: NativeBuildManager | undefined;
    let executionHost: ReturnType<typeof createExecutionHost> | undefined;
    let runtime:
      | { step: () => Promise<{ status: string; action?: string }>; projection: () => SchedulerProjection }
      | undefined;
    const worker = new T8JourneyWorker();
    const reviewer = new T8JourneyCoverageReviewer();
    try {
      const project = join(root, "project");
      const state = join(root, "state");
      mkdirSync(join(project, "test"), { recursive: true });
      mkdirSync(state, { recursive: true });
      writeFileSync(
        join(project, "package.json"),
        JSON.stringify(
          { name: "t8-journey-fixture", version: "1.0.0", type: "module", scripts: { test: "node --test" } },
          null,
          2,
        ),
      );
      writeFileSync(join(project, "test", "value.test.mjs"), T8_VALUE_TEST);
      const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: RUN_ID });
      executionHost = createExecutionHost({
        projectRoot: project,
        stateDirectory: state,
        artifacts: new ArtifactStore(join(state, "artifacts")),
        ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
      });
      supervisor = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")), {
        clock: () => T8_CLOCK,
      });
      const architect = new T8JourneyArchitect(() => runtime!.projection(), t8JourneyScenario(RUN_ID));
      factory = new FixtureNativeBuildFactory({
        projectRoot: project,
        stateDirectory: state,
        providerConfigs: {
          load: () => [
            t8Provider("arch:architect", 1),
            t8Provider("work:worker", 2),
            t8Provider("rev:reviewer", 3),
          ],
          save: () => undefined,
          close: () => undefined,
        },
        executionHost,
        baselineFor: () => baseline.revision,
        providerModelFactory: (config) => {
          if (config.runtimeId === "arch:architect") return architect;
          if (config.runtimeId === "work:worker") return worker;
          return reviewer;
        },
      });
      manager = new NativeBuildManager({
        specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
        createRuntime: (spec) =>
          factory!.create(spec).then((handle) => {
            runtime = handle.runtime as typeof runtime;
            return handle;
          }),
        prepareSpec: (spec, options) => factory!.prepareSpec(spec, options),
      });
      server = new ControlServer({
        supervisor,
        token: TOKEN,
        builds: manager,
        buildProvisioner: manager,
        checkGit: async () => ({ available: true, version: "fixture-git", code: "git_ready", reason: null }),
        bootstrapRun: async () => ({ baselineRevision: baseline.revision, baselineRef: baseline.ref }),
      });
      const address = await server.start(0);
      const connection = { url: address.url, token: TOKEN };

      const body = {
        runId: RUN_ID,
        projectPath: project,
        permissionProfile: "full",
        idempotencyKey: "t8-journey",
        build: {
          projectId: DISCUSSION_ID,
          objective: "Deliver the value module.",
          architectRuntimeId: "arch:architect",
          workerRuntimeIds: ["work:worker"],
          verifierRuntimeIds: ["rev:reviewer"],
          alwaysRequireIndependentVerifier: false,
          maxConcurrency: 1,
          runPolicy: "finish",
          budgetLimits: {},
          planningPolicy: { version: 1 },
          specCopy: false,
          handoffFiles: "export_only",
          answerReview: true,
        },
      };
      const created = await fetch(`${address.url}/v2/runs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(created.status).toBe(201);
      const savedSpec = manager.listSpecs()[0]!;
      expect(savedSpec.specCopy).toBe(false);
      expect(savedSpec.handoffFiles).toBe("export_only");
      expect(savedSpec.answerReview).toBe(true);

      const control = (path: string, input?: unknown, token = TOKEN) =>
        fetch(`${address.url}/v2/runs/${RUN_ID}/build/${path}`, {
          method: input === undefined ? "GET" : "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
        });
      const approve = {
        approvedSource: t8SourceInput(T8_SOURCE, [...t8JourneySections()]),
        idempotencyKey: "approve-source",
      };
      expect((await control("source", approve, "wrong-token")).status).toBe(401);
      const approved = await control("source", approve);
      expect(approved.status).toBe(200);

      const registered = manager
        .events(RUN_ID)
        .find((event) => event.type === "planning.source_registered")!;
      expect(registered).toBeTruthy();
      const manifest = (registered.payload as { manifest: ApprovedSourceManifest }).manifest;
      expect(manifest.artifactDigest).toBe(createHash("sha256").update(T8_SOURCE, "utf8").digest("hex"));
      expect(manifest.byteLength).toBe(Buffer.byteLength(T8_SOURCE, "utf8"));
      expect(manifest.authority).toBe("user:local-user");
      const storedBytes = await new ArtifactStore(join(state, "artifacts")).get(manifest.artifactDigest);
      expect(Buffer.from(storedBytes).toString("utf8")).toBe(T8_SOURCE);

      for (let step = 0; step < 200; step += 1) {
        const projection = runtime!.projection();
        if (projection.planning?.readiness === "ready") break;
        if (projection.status === "paused" || projection.status === "failed") {
          throw new Error(`ready plan: run ${projection.status} unexpectedly`);
        }
        await runtime!.step();
        if (step === 199) throw new Error("ready plan: not reached within 200 steps");
      }
      expect(worker.requests.length).toBe(0);
      expect(runtime!.projection().specCopy).toBe(false);
      expect(runtime!.projection().handoffFiles).toBe("export_only");

      const beforePreview = manager.events(RUN_ID);
      const readyResponse = await control("planning-readiness");
      expect(readyResponse.status).toBe(200);
      const ready = (await readyResponse.json()) as PlanningReadinessSnapshot;
      expect(ready.status).toBe("ready_start_required");
      const exportedResponse = await control("planning-export");
      expect(exportedResponse.status).toBe(200);
      const serverExport = (await exportedResponse.json()) as PlanningExportDocument;
      expect(serverExport.snapshot.digestValid).toBe(true);
      expect(serverExport.snapshot.text).toContain("REQ-1");
      expect(manager.events(RUN_ID)).toEqual(beforePreview);
      expect(worker.requests.length).toBe(0);

      const start = displayedPlanStart(ready, "t8-start-key");
      expect((await control("plan-start", { ...start, planDigest: "f".repeat(64) })).status).toBe(409);
      expect((await control("plan-start", { ...start, ownerChoice: "preview" })).status).toBe(400);
      expect((await control("plan-start", start, "wrong-token")).status).toBe(401);
      expect(manager.events(RUN_ID)).toEqual(beforePreview);
      expect(worker.requests.length).toBe(0);

      await page.addInitScript(
        "window.copied=[]; Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.copied.push(text)}});",
      );
      await page.goto("/");
      await seedBuildDiscussion(page, {
        discussionId: DISCUSSION_ID,
        runId: RUN_ID,
        runnerUrl: address.url,
        runnerToken: TOKEN,
      });
      await page.goto(`/discussion?id=${DISCUSSION_ID}`);

      const planningPanel = page.getByLabel("Evidence-gated planning");
      await expect(planningPanel).toBeVisible();
      await expect(planningPanel.getByText(/Plan ready — delivery incomplete/)).toBeVisible();
      await expect(planningPanel.getByText(/Requirements: 0 accepted \/ 1 applicable/)).toBeVisible();
      await expect(planningPanel.getByText(/distinct_model/).first()).toBeVisible();
      await expect(planningPanel.getByText(/has no explicit owner start authorization/)).toBeVisible();
      const startButton = planningPanel.getByRole("button", { name: "Start current plan", exact: true });
      await expect(startButton).toBeVisible();
      await expect(startButton).toBeEnabled();

      await planningPanel.getByText("Requirements and owning phases", { exact: true }).click();
      await expect(planningPanel.getByText("REQ-1", { exact: false }).first()).toBeVisible();
      await planningPanel.getByText("Phase exits and task dependencies", { exact: true }).click();
      await expect(planningPanel.getByText(/Phase incomplete/).first()).toBeVisible();
      await expect(planningPanel.getByText("Model passes and token cost", { exact: true })).toBeVisible();
      await planningPanel.getByText("Model passes and token cost", { exact: true }).click();
      await expect(planningPanel.getByText(/coverage:derive/).first()).toBeVisible();
      await expect(planningPanel.getByText(/coverage:verdict/).first()).toBeVisible();

      const packs = await getNativeContextManifests(connection, RUN_ID);
      const schedule = await getNativePlanningSchedule(connection, RUN_ID);
      expect(packs.length).toBeGreaterThan(0);
      expect(schedule?.lastSequence).toBe(runtime!.projection().lastSequence);
      expect(manager.events(RUN_ID)).toEqual(beforePreview);
      expect(worker.requests.length).toBe(0);

      await planningPanel.getByRole("button", { name: "Inspect export", exact: true }).click();
      const exportView = planningPanel.getByLabel("Planning export snapshot");
      await expect(exportView).toBeVisible();
      await expect(planningPanel.getByRole("alert")).toHaveCount(0);
      await exportView.getByText("STATE snapshot", { exact: true }).click();
      await expect(exportView.getByText("REQ-1", { exact: false }).first()).toBeVisible();
      const exportedViaClient = await exportNativePlanning(connection, RUN_ID);
      expect(exportedViaClient.snapshot.text).toBe(serverExport.snapshot.text);

      await exportView.getByRole("button", { name: "Copy STATE snapshot", exact: true }).click();
      expect(((await page.evaluate("window.copied")) as string[])[0]).toBe(serverExport.snapshot.text);
      await exportView.getByText("Copy-ready reference cards", { exact: true }).click();
      await exportView.getByRole("button", { name: "Copy worker card T1", exact: true }).click();
      expect(((await page.evaluate("window.copied")) as string[])[1]).toBe(
        serverExport.references!.cards.find((card) => card.kind === "worker")!.text,
      );
      await exportView.getByRole("button", { name: "Copy controller card", exact: true }).click();
      expect(((await page.evaluate("window.copied")) as string[])[2]).toBe(
        serverExport.references!.cards.find((card) => card.kind === "controller")!.text,
      );

      const downloadPromise = page.waitForEvent("download");
      await exportView.getByRole("button", { name: "Download planning export", exact: true }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe("aiboard-planning-export.json");
      const stream = await download.createReadStream();
      const bytes: Buffer[] = [];
      for await (const chunk of stream!) bytes.push(Buffer.from(chunk));
      const downloaded = JSON.parse(Buffer.concat(bytes).toString("utf8")) as PlanningExportDocument;
      expect(downloaded.snapshot.text).toBe(serverExport.snapshot.text);
      expect(downloaded.references).toEqual(serverExport.references);
      expect(manager.events(RUN_ID)).toEqual(beforePreview);
      expect(worker.requests.length).toBe(0);

      await startButton.click();
      await expect(startButton).toBeDisabled();
      await expect(planningPanel.getByRole("alert")).toHaveCount(0);
      expect(worker.requests.length).toBe(0);
      const authorizedResponse = await control("planning-readiness");
      expect(authorizedResponse.status).toBe(200);
      const authorized = (await authorizedResponse.json()) as PlanningReadinessSnapshot;
      expect(authorized.status).toBe("ready_authorized");
      expect(authorized.explicitStartAuthorized).toBe(true);
      const afterStart = manager.events(RUN_ID);
      expect(afterStart.length).toBe(beforePreview.length + 1);
      expect(afterStart[afterStart.length - 1]!.type).toBe("planning.execution_authorized");

      await runtime!.step();
      const afterOneStep = manager.events(RUN_ID);
      expect(afterOneStep.length).toBeGreaterThan(afterStart.length);
      for (let i = 0; i < 20 && worker.requests.length === 0; i += 1) {
        await runtime!.step();
      }
      expect(worker.requests.length).toBeGreaterThan(0);
      expect(manager.events(RUN_ID).length).toBeGreaterThan(afterOneStep.length);
    } finally {
      await server?.close().catch(() => undefined);
      supervisor?.close();
      await manager?.close().catch(() => undefined);
      await factory?.close().catch(() => undefined);
      await executionHost?.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function seedBuildDiscussion(
  page: Page,
  input: { discussionId: string; runId: string; runnerUrl: string; runnerToken: string },
): Promise<void> {
  await page.evaluate(async (seed) => {
    const now = "2026-10-07T00:00:00.000Z";
    const store = {
      discussions: [
        {
          id: seed.discussionId,
          topic: "Supervise the T8 evidence-gated planning journey",
          mode: "build",
          effort: "medium",
          status: "running",
          modelIds: "[]",
          judgeModelId: null,
          reviewerModelId: null,
          attachmentIds: null,
          projectFolderName: null,
          runnerUrl: seed.runnerUrl,
          runnerToken: seed.runnerToken,
          runnerAccess: "full",
          nativeBuildRunId: seed.runId,
          nativeBuildRequestedAt: null,
          buildRunPolicy: "finish",
          buildSkillMode: "balanced",
          buildBudgetUsd: 0,
          buildTimeLimitMinutes: 120,
          buildStopReason: null,
          buildStoppedAt: null,
          currentRound: 0,
          maxRounds: 0,
          convergenceScore: null,
          verbosity: "balanced",
          styleNote: "",
          reasoningEffort: "default",
          createdAt: now,
          updatedAt: now,
        },
      ],
      messages: [],
      finalResults: [],
      attachments: [],
      buildFiles: [],
      buildCheckpoints: [],
      contextBlobs: [],
      buildMemories: [],
      providerKeys: [],
      customModels: [],
      gameSessions: [],
      gameMatchRecords: [],
      gameStatsLegacyImportAttempted: false,
      modelStats: [],
    };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("ai-discussion-board", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("kv")) {
          request.result.createObjectStore("kv");
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("kv", "readwrite");
        transaction.objectStore("kv").put(
          JSON.stringify({ v: 1, encrypted: false, data: JSON.stringify(store) }),
          "store",
        );
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => {
          database.close();
          reject(transaction.error);
        };
      };
    });
  }, input);
}
