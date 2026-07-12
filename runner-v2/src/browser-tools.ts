import type { Browser, BrowserContext, Page } from "playwright";

import type {
  NativeTool,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";

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
}

export class PlaywrightBrowserBackend implements BrowserBackend {
  private browser: Browser | undefined;
  private readonly sessions = new Map<string, BrowserSession>();

  async open(sessionId: string, input: { url: string; width: number; height: number }) {
    await this.close(sessionId);
    const browser = await this.browserInstance();
    const context = await browser.newContext({
      viewport: { width: input.width, height: input.height },
    });
    const page = await context.newPage();
    const session: BrowserSession = { context, page, console: [], network: [] };
    this.observe(session);
    this.sessions.set(sessionId, session);
    await page.goto(input.url, { waitUntil: "domcontentloaded" });
    return { url: page.url(), title: await page.title() };
  }

  async navigate(sessionId: string, url: string) {
    const page = this.require(sessionId).page;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return { url: page.url(), title: await page.title() };
  }

  async snapshot(sessionId: string) {
    const page = this.require(sessionId).page;
    return {
      url: page.url(),
      title: await page.title(),
      text: (await page.locator("body").innerText()).slice(0, 64 * 1024),
      html: await page.content(),
    };
  }

  async click(sessionId: string, selector: string): Promise<void> {
    await this.require(sessionId).page.locator(selector).click();
  }

  async fill(sessionId: string, selector: string, value: string): Promise<void> {
    await this.require(sessionId).page.locator(selector).fill(value);
  }

  async screenshot(sessionId: string): Promise<Buffer> {
    return Buffer.from(await this.require(sessionId).page.screenshot({ fullPage: true }));
  }

  async events(sessionId: string) {
    const session = this.require(sessionId);
    return { console: [...session.console], network: [...session.network] };
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    await session.context.close();
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.keys()];
    for (const sessionId of sessions) await this.close(sessionId);
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

  private require(sessionId: string): BrowserSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Browser session is not open; call browser.open first.");
    return session;
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

export interface BrowserToolsOptions {
  backend: BrowserBackend;
  artifacts: ArtifactStore;
  taskId: string;
  maximumDomBytes?: number;
}

export function createBrowserTools(options: BrowserToolsOptions): NativeTool<unknown>[] {
  const sessionFor = (runId: string) => `${runId}:${options.taskId}`;
  const external = (capability: string) => () => ({ capability, external: true });
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
      return json({ artifactHash: artifact.hash, mediaType: "image/png", byteLength: bytes.byteLength });
    }, external("browser.screenshot")),
    tool("browser.events", "Read bounded console and network observations", emptySchema(), validateEmpty, async (_input, context) =>
      json(await options.backend.events(sessionFor(context.runId))), external("browser.events")),
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
