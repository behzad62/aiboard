/* Provider raw document input formatting (run: npx tsx scripts/test-provider-document-inputs.mts) */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { buildOpenAIMessages } from "../lib/providers/openai-compat";
import { buildOpenAIResponsesInput } from "../lib/providers/openai";
import type { AttachmentPayload } from "../lib/attachments/types";
import type { ModelCapabilities } from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const pdfAttachment: AttachmentPayload = {
  id: "doc-raw",
  filename: "brief.pdf",
  mimeType: "application/pdf",
  category: "document",
  base64Data: "JVBERi0xLjQKJQ==",
};

const documentCaps: ModelCapabilities = {
  image: false,
  document: true,
  audio: false,
  video: false,
};

const noDocumentCaps: ModelCapabilities = {
  image: false,
  document: false,
  audio: false,
  video: false,
};

function firstUserContent(messages: Array<{ role?: string; content?: unknown }>): unknown {
  return messages.find((message) => message.role === "user")?.content;
}

function hasOpenAIFilePart(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((part) => {
      const file = part?.file;
      return (
        part?.type === "file" &&
        file?.filename === "brief.pdf" &&
        file?.file_data === "data:application/pdf;base64,JVBERi0xLjQKJQ=="
      );
    })
  );
}

function hasOpenAITextOnlyFallback(content: unknown): boolean {
  return (
    typeof content === "string" &&
    content.includes("[Attached document: brief.pdf (application/pdf)")
  );
}

function hasOpenAIResponsesInputFilePart(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (part) =>
        part?.type === "input_file" &&
        part.filename === "brief.pdf" &&
        part.file_data === "data:application/pdf;base64,JVBERi0xLjQKJQ=="
    )
  );
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  await once(req, "end");
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function withServer(
  handler: http.RequestListener
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function waitForRunnerReady(
  child: ChildProcessWithoutNullStreams,
  url: string,
  token: string
): Promise<void> {
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode != null) {
      throw new Error(`runner exited early: ${stderr}`);
    }
    try {
      const response = await fetch(`${url}/health`, {
        headers: { "x-runner-token": token },
      });
      if (response.ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`runner did not become ready: ${stderr}`);
}

async function testOpenAICompatibleDocumentParts(): Promise<void> {
  const withDocs = buildOpenAIMessages(
    {
      apiKey: "unused",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Read the file." }],
      attachments: [pdfAttachment],
    },
    documentCaps
  );
  const withoutDocs = buildOpenAIMessages(
    {
      apiKey: "unused",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Read the file." }],
      attachments: [pdfAttachment],
    },
    noDocumentCaps
  );

  check(
    "OpenAI-compatible document-capable models send raw PDF file parts",
    hasOpenAIFilePart(firstUserContent(withDocs as Array<{ role?: string; content?: unknown }>)),
    withDocs
  );
  check(
    "OpenAI-compatible text-only models keep raw PDFs as prompt references",
    hasOpenAITextOnlyFallback(
      firstUserContent(withoutDocs as Array<{ role?: string; content?: unknown }>)
    ),
    withoutDocs
  );
}

async function testOpenAIResponsesDocumentParts(): Promise<void> {
  const input = buildOpenAIResponsesInput(
    {
      apiKey: "unused",
      model: "gpt-5.3-codex",
      messages: [{ role: "user", content: "Read the file." }],
      attachments: [pdfAttachment],
    },
    documentCaps
  );

  check(
    "OpenAI Responses document-capable models send raw PDFs as input_file parts",
    hasOpenAIResponsesInputFilePart(firstUserContent(input)),
    input
  );
}

async function testAccountRunnerRawDocumentInputFile(): Promise<void> {
  let upstreamBody: Record<string, unknown> | undefined;
  const { server: upstream, url: upstreamUrl } = await withServer(async (req, res) => {
    upstreamBody = await readJsonBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      [
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"ok"}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed"}',
        "",
      ].join("\n")
    );
  });

  const tmp = await mkdtemp(path.join(os.tmpdir(), "aiboard-account-runner-docs-"));
  const authFile = path.join(tmp, "auth.json");
  const token = "test-token";
  const runnerPort = 18_000 + Math.floor(Math.random() * 10_000);
  const runnerUrl = `http://127.0.0.1:${runnerPort}`;
  let child: ChildProcessWithoutNullStreams | null = null;

  try {
    await writeFile(
      authFile,
      JSON.stringify({
        chatgpt: {
          type: "oauth",
          refresh: "unused",
          access: "fake-access",
          expires: Date.now() + 3_600_000,
          accountId: "acct-test",
          updatedAt: new Date().toISOString(),
        },
      })
    );
    child = spawn(
      process.execPath,
      [
        "lib/account-provider-runner.mjs",
        "--host",
        "127.0.0.1",
        "--port",
        String(runnerPort),
        "--token",
        token,
        "--auth-file",
        authFile,
        "--chatgpt-codex-endpoint",
        upstreamUrl,
      ],
      { cwd: process.cwd() }
    );
    await waitForRunnerReady(child, runnerUrl, token);

    const response = await fetch(`${runnerUrl}/providers/chatgpt/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-runner-token": token,
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Read the PDF." }],
        attachments: [pdfAttachment],
      }),
    });
    const responseText = await response.text();
    const input = upstreamBody?.input as Array<{ role?: string; content?: unknown }> | undefined;
    const content = firstUserContent(input ?? []);

    check("account runner accepts raw PDF attachments", response.ok, responseText);
    check(
      "account runner forwards raw PDFs as Responses input_file parts",
      Array.isArray(content) &&
        content.some(
          (part) =>
            part?.type === "input_file" &&
            part.filename === "brief.pdf" &&
            part.file_data === "data:application/pdf;base64,JVBERi0xLjQKJQ=="
        ),
      upstreamBody
    );
  } finally {
    const upstreamClosed = once(upstream, "close");
    const childClosed = child ? once(child, "close") : Promise.resolve();
    if (child && child.exitCode === null) {
      if (process.platform === "win32" && child.pid) {
        spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        child.kill("SIGTERM");
      }
    }
    upstream.closeAllConnections?.();
    upstream.close();
    await Promise.allSettled([
      upstreamClosed,
      childClosed,
    ]);
    await rm(tmp, { recursive: true, force: true });
  }
}

await testOpenAICompatibleDocumentParts();
await testOpenAIResponsesDocumentParts();
await testAccountRunnerRawDocumentInputFile();

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exitCode = failures === 0 ? 0 : 1;
