import { randomUUID } from "node:crypto";

type Scalar = string | number | boolean;
type Field = { key: string; type: "string" | "number" | "integer" | "boolean"; title: string; description?: string; required: boolean; choices?: Scalar[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number };
export type McpChatPrompt = { id: string; source: string; message: string; fields: Field[] };
type Pending = { session: string; prompt: McpChatPrompt; settle: (answer: unknown) => void };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const decline = { action: "decline" } as const;
const scalar = (v: unknown, type: Field["type"]): v is Scalar => type === "integer" ? Number.isSafeInteger(v) : type === "number" ? typeof v === "number" && Number.isFinite(v) : typeof v === type;

function parseForm(request: Readonly<Record<string, unknown>>): Omit<McpChatPrompt, "id" | "source"> | undefined {
  const p = request.params;
  if (request.method !== "elicitation/create" || !record(p) || (p.mode !== undefined && p.mode !== "form") || typeof p.message !== "string" || p.message.length > 4000) return;
  const schema = p.requestedSchema;
  if (!record(schema) || schema.type !== "object" || !record(schema.properties)) return;
  if (Object.keys(schema).some(k => !["type", "properties", "required", "additionalProperties", "title", "description", "$schema"].includes(k))) return;
  const entries = Object.entries(schema.properties);
  if (entries.length > 16) return;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(k => typeof k !== "string" || !Object.hasOwn(schema.properties as object, k)))) return;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields: Field[] = [];
  for (const [key, value] of entries) {
    if (!key || key.length > 120 || ["__proto__", "prototype", "constructor"].includes(key) || !record(value) || !["string","number","integer","boolean"].includes(String(value.type))) return;
    if (Object.keys(value).some(k => !["type","title","description","enum","default","minimum","maximum","minLength","maxLength"].includes(k))) return;
    const type = value.type as Field["type"];
    const field: Field = { key, type, title: typeof value.title === "string" ? value.title.slice(0,160) : key, required: required.has(key) };
    if (typeof value.description === "string") field.description = value.description.slice(0,500);
    if (value.enum !== undefined) {
      if (!Array.isArray(value.enum) || value.enum.length < 1 || value.enum.length > 30 || !value.enum.every(v => scalar(v,type) && (typeof v !== "string" || v.length <= 500))) return;
      field.choices = value.enum as Scalar[];
    }
    for (const bound of ["minimum","maximum","minLength","maxLength"] as const) {
      if (value[bound] === undefined) continue;
      const v = value[bound];
      if (typeof v !== "number" || !Number.isFinite(v) || (bound.endsWith("Length") && (!Number.isSafeInteger(v) || v < 0))) return;
      field[bound] = v;
    }
    fields.push(field);
  }
  return { message: p.message, fields };
}

/** In-memory, session-bound, single-use human responses. Never persisted or inserted into chat text. */
export class McpChatInputs {
  private readonly pending = new Map<string, Pending>();
  list(session: string): McpChatPrompt[] {
    return [...this.pending.values()].filter(p => p.session === session).map(p => structuredClone(p.prompt));
  }
  async resolve(session: string, request: Readonly<Record<string, unknown>>, signal: AbortSignal, source = "Managed MCP server"): Promise<unknown> {
    const form = parseForm(request);
    if (!form || signal.aborted || this.pending.size >= 32 || this.list(session).length >= 4) return decline;
    const id = randomUUID();
    const prompt = { ...form, id, source: source.slice(0, 200) };
    return await new Promise(resolve => {
      const finish = (answer: unknown) => {
        this.pending.delete(id);
        signal.removeEventListener("abort", abort);
        resolve(answer);
      };
      const abort = () => finish({ action: "cancel" });
      this.pending.set(id, { session, prompt, settle: finish });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  answer(session: string, id: string, answer: unknown): "accepted" | "missing" | "invalid" {
    const pending = this.pending.get(id);
    if (!pending || pending.session !== session) return "missing";
    if (!record(answer) || !["accept","decline","cancel"].includes(String(answer.action))) return "invalid";
    if (answer.action !== "accept") {
      pending.settle({ action: answer.action });
      return "accepted";
    }
    const data = answer.content;
    if (!record(data) || Object.keys(data).some(k => !pending.prompt.fields.some(f => f.key === k))) return "invalid";
    const content = Object.create(null) as Record<string, Scalar>;
    for (const f of pending.prompt.fields) {
      if (!Object.hasOwn(data, f.key)) { if (f.required) return "invalid"; continue; }
      const v = data[f.key];
      if (!scalar(v, f.type) || (f.choices && !f.choices.includes(v))) return "invalid";
      if (typeof v === "string" && ([...v].length > 8000 || (f.minLength !== undefined && [...v].length < f.minLength) || (f.maxLength !== undefined && [...v].length > f.maxLength))) return "invalid";
      if (typeof v === "number" && ((f.minimum !== undefined && v < f.minimum) || (f.maximum !== undefined && v > f.maximum))) return "invalid";
      content[f.key] = v;
    }
    pending.settle({ action: "accept", content });
    return "accepted";
  }
}


// A remote job exposes only the validated scalar form, not downstream requestState
// or arbitrary server metadata. Input IDs are random, single-use prompt IDs.
export class RemoteMcpInputs {
  private readonly forms = new McpChatInputs();
  resolve(jobId: string, request: Readonly<Record<string, unknown>>, signal: AbortSignal, source?: string): Promise<unknown> {
    return this.forms.resolve(jobId, request, signal, source);
  }
  read(jobId: string): Record<string, unknown> | undefined {
    const prompt = this.forms.list(jobId)[0];
    if (!prompt) return;
    const properties = Object.fromEntries(prompt.fields.map(({key,type,title,description,choices,minimum,maximum,minLength,maxLength}) => [key, {
      type, title, ...(description === undefined ? {} : {description}), ...(choices === undefined ? {} : {enum:choices}),
      ...(minimum === undefined ? {} : {minimum}), ...(maximum === undefined ? {} : {maximum}),
      ...(minLength === undefined ? {} : {minLength}), ...(maxLength === undefined ? {} : {maxLength}),
    }]));
    return { [prompt.id]: { method:"elicitation/create", params: { mode:"form",
      message: ("Downstream MCP server " + prompt.source + " requests input. Review before responding. Do not provide secrets. " + prompt.message).slice(0,4500),
      requestedSchema: { type:"object", properties, required:prompt.fields.filter(f=>f.required).map(f=>f.key) } } } };
  }
  answer(jobId: string, responses: unknown): boolean {
    if (!record(responses) || Object.keys(responses).length !== 1) return false;
    const [id, answer] = Object.entries(responses)[0];
    if (!record(answer) || !["accept","decline","cancel"].includes(String(answer.action)) ||
      Object.keys(answer).some(key=>key!=="action"&&key!=="content") ||
      (answer.action!=="accept" && answer.content!==undefined)) return false;
    if (Buffer.byteLength(JSON.stringify(responses)) > 65536) return false;
    return this.forms.answer(jobId, id, answer) === "accepted";
  }
}
