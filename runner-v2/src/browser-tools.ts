import type { Browser, BrowserContext, Page } from "playwright";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  NativeTool,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { EvidenceStore } from "./evidence-store.js";

export interface BrowserConsoleEvent {
  type: string;
  text: string;
  occurredAt: string;
}

export interface BrowserNetworkEvent {
  method: string;
  url: string;
  status?: number;
  failure?: string;
  occurredAt: string;
}

export interface BrowserBackend {
  open(sessionId: string, input: { url: string; width: number; height: number }): Promise<{ url: string; title: string }>;
  navigate(sessionId: string, url: string): Promise<{ url: string; title: string }>;
  snapshot(sessionId: string): Promise<{ url: string; title: string; text: string; html: string }>;
  click(sessionId: string, selector: string): Promise<void>;
  fill(sessionId: string, selector: string, value: string): Promise<void>;
  screenshot(sessionId: string): Promise<Buffer>;
  events(sessionId: string): Promise<{ console: BrowserConsoleEvent[]; network: BrowserNetworkEvent[] }>;
  close(sessionId: string): Promise<void>;
  closeAll(): Promise<void>;
}

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  console: BrowserConsoleEvent[];
  network: BrowserNetworkEvent[];
  width: number;
  height: number;
}

interface PersistedBrowserSession {
  url: string;
  width: number;
  height: number;
}

export class PlaywrightBrowserBackend implements BrowserBackend {
  private browser: Browser | undefined;
  private readonly sessions = new Map<string, BrowserSession>();

  constructor(private readonly stateDirectory?: string) {}

  async open(sessionId: string, input: { url: string; width: number; height: number }) {
    await this.discard(sessionId);
    const browser = await this.browserInstance();
    const context = await browser.newContext({
      viewport: { width: input.width, height: input.height },
    });
    const page = await context.newPage();
    const session: BrowserSession = {
      context,
      page,
      console: [],
      network: [],
      width: input.width,
      height: input.height,
    };
    this.observe(session);
    this.sessions.set(sessionId, session);
    await page.goto(input.url, { waitUntil: "domcontentloaded" });
    await settlePage(page);
    await this.persist(sessionId, session);
    return { url: page.url(), title: await page.title() };
  }

  async navigate(sessionId: string, url: string) {
    const session = await this.require(sessionId);
    const page = session.page;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await settlePage(page);
    await this.persist(sessionId, session);
    return { url: page.url(), title: await page.title() };
  }

  async snapshot(sessionId: string) {
    const session = await this.require(sessionId);
    const page = session.page;
    await this.persist(sessionId, session);
    return {
      url: page.url(),
      title: await page.title(),
      text: (await page.locator("body").innerText()).slice(0, 64 * 1024),
      html: await page.content(),
    };
  }

  async click(sessionId: string, selector: string): Promise<void> {
    const session = await this.require(sessionId);
    await session.page.locator(selector).click();
    await this.persist(sessionId, session);
  }

  async fill(sessionId: string, selector: string, value: string): Promise<void> {
    const session = await this.require(sessionId);
    await session.page.locator(selector).fill(value);
    await this.persist(sessionId, session);
  }

  async screenshot(sessionId: string): Promise<Buffer> {
    const session = await this.require(sessionId);
    const bytes = Buffer.from(await session.page.screenshot({ fullPage: true }));
    await this.persist(sessionId, session);
    return bytes;
  }

  async events(sessionId: string) {
    const session = await this.require(sessionId);
    return { console: [...session.console], network: [...session.network] };
  }

  async close(sessionId: string): Promise<void> {
    await this.discard(sessionId);
  }

  private async discard(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      await session.context.close();
    }
    if (this.stateDirectory) {
      await rm(this.metadataPath(sessionId), { force: true });
      await rm(this.storagePath(sessionId), { force: true });
    }
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.entries()];
    for (const [sessionId, session] of sessions) {
      await this.persist(sessionId, session);
      await session.context.close();
      this.sessions.delete(sessionId);
    }
    await this.browser?.close();
    this.browser = undefined;
  }

  private async browserInstance(): Promise<Browser> {
    if (!this.browser) {
      const { chromium } = await import("playwright");
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser;
  }

  private async require(sessionId: string): Promise<BrowserSession> {
    const session = this.sessions.get(sessionId);
    if (session) return session;
    const recovered = await this.recover(sessionId);
    if (!recovered) throw new Error("Browser session is not open; call browser.open first.");
    return recovered;
  }

  private async recover(sessionId: string): Promise<BrowserSession | undefined> {
    if (!this.stateDirectory) return undefined;
    let metadata: PersistedBrowserSession;
    try {
      metadata = JSON.parse(await readFile(this.metadataPath(sessionId), "utf8")) as PersistedBrowserSession;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const browser = await this.browserInstance();
    const context = await browser.newContext({
      viewport: { width: metadata.width, height: metadata.height },
      storageState: this.storagePath(sessionId),
    });
    const page = await context.newPage();
    const session: BrowserSession = {
      context,
      page,
      console: [],
      network: [],
      width: metadata.width,
      height: metadata.height,
    };
    this.observe(session);
    this.sessions.set(sessionId, session);
    await page.goto(metadata.url, { waitUntil: "domcontentloaded" });
    await settlePage(page);
    return session;
  }

  private async persist(sessionId: string, session: BrowserSession): Promise<void> {
    if (!this.stateDirectory) return;
    await mkdir(resolve(this.stateDirectory), { recursive: true });
    await session.context.storageState({
      path: this.storagePath(sessionId),
      indexedDB: true,
    });
    const destination = this.metadataPath(sessionId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({
      url: session.page.url(),
      width: session.width,
      height: session.height,
    } satisfies PersistedBrowserSession));
    await rename(temporary, destination);
  }

  private metadataPath(sessionId: string): string {
    return join(resolve(this.stateDirectory!), `${safeSession(sessionId)}.json`);
  }

  private storagePath(sessionId: string): string {
    return join(resolve(this.stateDirectory!), `${safeSession(sessionId)}.storage.json`);
  }

  private observe(session: BrowserSession): void {
    session.page.on("console", (message) => {
      pushBounded(session.console, {
        type: message.type(),
        text: message.text(),
        occurredAt: new Date().toISOString(),
      });
    });
    session.page.on("response", (response) => {
      pushBounded(session.network, {
        method: response.request().method(),
        url: response.url(),
        status: response.status(),
        occurredAt: new Date().toISOString(),
      });
    });
    session.page.on("requestfailed", (request) => {
      pushBounded(session.network, {
        method: request.method(),
        url: request.url(),
        failure: request.failure()?.errorText ?? "request failed",
        occurredAt: new Date().toISOString(),
      });
    });
  }
}

async function settlePage(page: Page): Promise<void> {
  try {
    await page.waitForLoadState("networkidle", { timeout: 10_000 });
  } catch {
    // A bounded timeout is a mechanical observation boundary, not a page verdict.
  }
}

export interface BrowserToolsOptions {
  backend: BrowserBackend;
  artifacts: ArtifactStore;
  evidenceStore?: EvidenceStore;
  taskId: string;
  maximumDomBytes?: number;
  clock?: () => string;
}

export function createBrowserTools(options: BrowserToolsOptions): NativeTool<unknown>[] {
  const sessionFor = (runId: string) => `${runId}:${options.taskId}`;
  const external = (capability: string) => () => ({ capability, external: true });
  const clock = options.clock ?? (() => new Date().toISOString());
  return [
    tool("browser.open", "Open a runner-managed browser session", openSchema(), validateOpen, async (input, context) =>
      json(await options.backend.open(sessionFor(context.runId), input)), external("browser.open")),
    tool("browser.navigate", "Navigate the managed browser", urlSchema(), validateUrlOnly, async (input, context) =>
      json(await options.backend.navigate(sessionFor(context.runId), input.url)), external("browser.navigate")),
    tool("browser.snapshot", "Capture visible text and DOM from the managed browser", emptySchema(), validateEmpty, async (_input, context) => {
      const snapshot = await options.backend.snapshot(sessionFor(context.runId));
      const encoded = Buffer.from(snapshot.html);
      const maximum = options.maximumDomBytes ?? 8 * 1024 * 1024;
      const bytes = encoded.subarray(0, maximum);
      const artifact = await options.artifacts.put(bytes, "text/html", `Browser DOM ${options.taskId}`);
      const capturedAt = clock();
      options.evidenceStore?.record({
        runId: context.runId,
        taskId: options.taskId,
        actor: context.actor,
        fact: {
          kind: "browser_snapshot",
          label: `Browser snapshot ${options.taskId}`,
          url: snapshot.url,
          title: snapshot.title,
          capturedAt,
          htmlArtifactHash: artifact.hash,
          htmlBytes: encoded.byteLength,
          truncated: encoded.byteLength > bytes.byteLength,
        },
        createdAt: capturedAt,
        idempotencyKey: `evidence:${context.sessionId}:${context.callId}`,
      });
      return json({
        url: snapshot.url,
        title: snapshot.title,
        text: snapshot.text,
        htmlArtifactHash: artifact.hash,
        htmlBytes: encoded.byteLength,
        truncated: encoded.byteLength > bytes.byteLength,
      });
    }, external("browser.snapshot")),
    tool("browser.click", "Click one element by Playwright selector", selectorSchema(), validateSelector, async (input, context) => {
      await options.backend.click(sessionFor(context.runId), input.selector);
      return json({ clicked: input.selector });
    }, external("browser.click")),
    tool("browser.fill", "Fill one form control by Playwright selector", fillSchema(), validateFill, async (input, context) => {
      await options.backend.fill(sessionFor(context.runId), input.selector, input.value);
      return json({ filled: input.selector });
    }, external("browser.fill")),
    tool("browser.screenshot", "Capture a full-page PNG from the managed browser", emptySchema(), validateEmpty, async (_input, context) => {
      const bytes = await options.backend.screenshot(sessionFor(context.runId));
      const artifact = await options.artifacts.put(bytes, "image/png", `Browser screenshot ${options.taskId}`);
      const capturedAt = clock();
      options.evidenceStore?.record({
        runId: context.runId,
        taskId: options.taskId,
        actor: context.actor,
        fact: {
          kind: "browser_screenshot",
          label: `Browser screenshot ${options.taskId}`,
          capturedAt,
          screenshotArtifactHash: artifact.hash,
          mediaType: "image/png",
          byteLength: bytes.byteLength,
        },
        createdAt: capturedAt,
        idempotencyKey: `evidence:${context.sessionId}:${context.callId}`,
      });
      return {
        content: [
          {
            type: "json",
            value: {
              artifactHash: artifact.hash,
              mediaType: "image/png",
              byteLength: bytes.byteLength,
            },
          },
          {
            type: "artifact",
            hash: artifact.hash,
            mediaType: "image/png",
            label: `Browser screenshot ${options.taskId}`,
          },
        ],
        isError: false,
      };
    }, external("browser.screenshot")),
    tool("browser.events", "Read bounded console and network observations", emptySchema(), validateEmpty, async (_input, context) => {
      const events = await options.backend.events(sessionFor(context.runId));
      const artifact = await options.artifacts.put(
        Buffer.from(JSON.stringify(events)),
        "application/json",
        `Browser events ${options.taskId}`
      );
      const capturedAt = clock();
      options.evidenceStore?.record({
        runId: context.runId,
        taskId: options.taskId,
        actor: context.actor,
        fact: {
          kind: "browser_events",
          label: `Browser events ${options.taskId}`,
          capturedAt,
          eventsArtifactHash: artifact.hash,
          consoleEventCount: events.console.length,
          consoleErrorCount: events.console.filter((event) => event.type === "error").length,
          networkEventCount: events.network.length,
          networkFailureCount: events.network.filter(
            (event) => Boolean(event.failure) || (event.status !== undefined && event.status >= 400)
          ).length,
        },
        createdAt: capturedAt,
        idempotencyKey: `evidence:${context.sessionId}:${context.callId}`,
      });
      return json(events);
    }, external("browser.events")),
    tool("browser.close", "Close the managed task browser session", emptySchema(), validateEmpty, async (_input, context) => {
      await options.backend.close(sessionFor(context.runId));
      return json({ closed: true });
    }, external("browser.close")),
  ];
}

function tool<T>(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  validate: (input: unknown) => ValidationResult<T>,
  execute: NativeTool<T>["execute"],
  assessAccess: NativeTool<T>["assessAccess"]
): NativeTool<T> {
  return {
    definition: { name, description, inputSchema, readOnly: false, effect: "external" },
    validate,
    assessAccess,
    execute,
  };
}

function validateOpen(input: unknown): ValidationResult<{ url: string; width: number; height: number }> {
  const url = parsedHttpUrl(input);
  if (!url || !record(input)) return invalid("url must be an HTTP(S) URL");
  const width = input.width ?? 1280;
  const height = input.height ?? 720;
  return dimension(width) && dimension(height)
    ? { ok: true, value: { url, width, height } }
    : invalid("width and height must be integers from 320 to 4096");
}

function validateUrlOnly(input: unknown): ValidationResult<{ url: string }> {
  const url = parsedHttpUrl(input);
  return url ? { ok: true, value: { url } } : invalid("url must be an HTTP(S) URL");
}

function validateSelector(input: unknown): ValidationResult<{ selector: string }> {
  return record(input) && nonEmpty(input.selector)
    ? { ok: true, value: { selector: input.selector } }
    : invalid("selector must be a non-empty string");
}

function validateFill(input: unknown): ValidationResult<{ selector: string; value: string }> {
  return record(input) && nonEmpty(input.selector) && typeof input.value === "string"
    ? { ok: true, value: { selector: input.selector, value: input.value } }
    : invalid("selector and string value are required");
}

function validateEmpty(input: unknown): ValidationResult<Record<string, never>> {
  return record(input) && Object.keys(input).length === 0
    ? { ok: true, value: {} }
    : invalid("arguments must be an empty object");
}

function parsedHttpUrl(input: unknown): string | undefined {
  if (!record(input) || typeof input.url !== "string") return undefined;
  try {
    const url = new URL(input.url);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function json(value: unknown): ToolExecutionOutput {
  return { content: [{ type: "json", value }], isError: false };
}

function invalid<T>(issue: string): ValidationResult<T> {
  return { ok: false, issues: [issue] };
}

function emptySchema() { return { type: "object", additionalProperties: false }; }
function urlSchema() { return { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false }; }
function selectorSchema() { return { type: "object", properties: { selector: { type: "string" } }, required: ["selector"], additionalProperties: false }; }
function fillSchema() { return { type: "object", properties: { selector: { type: "string" }, value: { type: "string" } }, required: ["selector", "value"], additionalProperties: false }; }
function openSchema() { return { type: "object", properties: { url: { type: "string" }, width: { type: "integer", minimum: 320, maximum: 4096 }, height: { type: "integer", minimum: 320, maximum: 4096 } }, required: ["url"], additionalProperties: false }; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function dimension(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 320 && (value as number) <= 4096; }
function pushBounded<T>(items: T[], item: T): void { items.push(item); if (items.length > 1_000) items.shift(); }
function safeSession(sessionId: string): string { return createHash("sha256").update(sessionId).digest("hex").slice(0, 32); }
