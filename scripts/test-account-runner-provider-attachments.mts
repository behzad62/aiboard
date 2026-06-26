/** Account-runner provider attachment forwarding checks (run: npx tsx scripts/test-account-runner-provider-attachments.mts) */
import { createAccountRunnerProvider } from "../lib/providers/account-runner";
import type { AttachmentPayload } from "../lib/attachments/types";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const attachments: AttachmentPayload[] = [
  {
    id: "img-1",
    filename: "red.png",
    mimeType: "image/png",
    category: "image",
    base64Data: "AAECAw==",
  },
  {
    id: "doc-1",
    filename: "note.txt",
    mimeType: "text/plain",
    category: "document",
    textContent: "AIBOARD_DOCUMENT_SECRET=blue-river",
  },
];

const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  calls.push({ url: String(url), init: init ?? {}, body });
  return new Response(JSON.stringify({ ok: true, content: "ok" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

try {
  const provider = createAccountRunnerProvider({
    id: "chatgpt",
    name: "ChatGPT",
    runnerPath: "chatgpt",
    models: [],
  });

  const chunks = [];
  for await (const chunk of provider.streamChat({
    model: "gpt-5.5",
    apiKey: "runner-token",
    baseURL: "http://127.0.0.1:1455",
    messages: [{ role: "user", content: "Read the attachments." }],
    attachments,
  })) {
    chunks.push(chunk);
  }

  check("provider calls account runner when image/document attachments are present", calls.length === 1, {
    calls,
    chunks,
  });
  check("provider forwards attachments to account runner", JSON.stringify(calls[0]?.body.attachments) === JSON.stringify(attachments), calls[0]?.body);
  check("provider does not emit text-only error", !chunks.some((chunk) => chunk.type === "error" && /text-only/i.test(chunk.error)), chunks);
} finally {
  globalThis.fetch = originalFetch;
}

process.exit(failed === 0 ? 0 : 1);
