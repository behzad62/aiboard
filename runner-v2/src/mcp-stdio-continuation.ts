import { appUri } from "./mcp-chat-app.js";
import { CreateTaskResultV2Schema, GetTaskResultV2Schema, InputRequiredCallToolResultV2Schema, ElicitResultV2Schema, UpdateTaskResultV2Schema } from "@modelcontextprotocol/ext-tasks/core/v2";

const MAX_LINE = 1024 * 1024;
const VERSION = "2026-07-28";
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function frame(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    if (bytes.byteLength > MAX_LINE) return;
    const raw = Buffer.from(bytes).toString("utf8");
    if (!Buffer.from(raw).equals(Buffer.from(bytes))) return;
    const value = JSON.parse(raw);
    if (obj(value) && value.jsonrpc === "2.0") return value;
  } catch { /* malformed */ }
}
const canonical = (bytes: Uint8Array) => {
  const f = frame(bytes);
  return f && Buffer.from(JSON.stringify(f) + "\n").equals(Buffer.from(bytes)) ? f : undefined;
};
const methodParams = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).filter(([k])=>k!=="_meta"));
const meta = (p: Record<string, unknown>) => obj(p._meta) ? Object.fromEntries(Object.entries(p._meta).filter(([k])=>k!=="progressToken")) : undefined;

/** A private per-operation wire fence. Only actual owned stdout can grant the
 * next step; a manager callback alone cannot widen the original tool effect. */
export class McpStdioContinuation {
  private buffer = Buffer.alloc(0);
  private pending?: { id: number; method: string };
  private lastId = 0;
  private invalid = false;
  private original?: Record<string, unknown>;
  private originalMeta?: Record<string, unknown>;
  private next: "none" | "continue" | "poll" | "update" | "app" = "none";
  private taskId?: string;
  private taskCreatedAt?: number;
  private requests?: Record<string, unknown>;
  private state?: string;
  private rounds = 0;
  private polls = 0;
  private updates = 0;
  private cancelled = false;

  constructor(private readonly app?: Readonly<{ toolName: string; uri: string }>) {}

  private completed(value: unknown) {
    if (this.app && this.original?.name === this.app.toolName && appUri(this.app.uri) &&
      obj(value) && Array.isArray(value.content) && value.isError !== true &&
      (value.resultType === undefined || value.resultType === "complete")) this.next = "app";
  }

  begin(bytes: Uint8Array): boolean {
    const f = canonical(bytes);
    if (!f || Object.keys(f).some(k=>!["jsonrpc","id","method","params"].includes(k)) || f.method !== "tools/call" || !Number.isSafeInteger(f.id) || Number(f.id)<1 || !obj(f.params)) return false;
    const p = f.params, m = meta(p);
    if (!m || m["io.modelcontextprotocol/protocolVersion"] !== VERSION ||
        typeof p.name !== "string" || !obj(p.arguments) || Object.keys(methodParams(p)).some(k=>k!=="name"&&k!=="arguments")) return false;
    this.original = methodParams(p); this.originalMeta = m;
    this.lastId = Number(f.id); this.pending = {id:this.lastId,method:"tools/call"};
    return true;
  }
  private answers(value: unknown): boolean {
    if (!this.requests || !obj(value) || Object.keys(value).length !== Object.keys(this.requests).length) return false;
    return Object.entries(this.requests).every(([key,req])=>Object.hasOwn(value,key) && obj(req) && req.method==="elicitation/create" && ElicitResultV2Schema.safeParse(value[key]).success);
  }
  permit(bytes: Uint8Array): boolean {
    if (this.invalid || this.pending || !this.original || this.cancelled || this.buffer.length) return false;
    const f = canonical(bytes);
    if (!f || Object.keys(f).some(k=>!["jsonrpc","id","method","params"].includes(k)) || !Number.isSafeInteger(f.id) || Number(f.id)<=this.lastId || !obj(f.params) || !same(meta(f.params),this.originalMeta)) return false;
    const p = methodParams(f.params);
    if (f.method === "tools/call" && this.next==="continue" && this.rounds<8) {
      const {inputResponses,requestState,...base}=p;
      if (!same(base,this.original) || requestState!==this.state || !this.answers(inputResponses)) return false;
      this.rounds++;
    } else if (f.method==="tasks/get" && this.next==="poll" && this.polls<240) {
      if (!same(p,{taskId:this.taskId})) return false;
      this.polls++;
    } else if (f.method==="tasks/update" && this.next==="update" && this.updates<8) {
      if (p.taskId!==this.taskId || Object.keys(p).length!==2 || !this.answers(p.inputResponses)) return false;
      this.updates++;
    } else if (f.method==="resources/read" && this.next==="app" && this.app) {
      if (!same(p,{uri:this.app.uri})) return false;
    } else if (f.method==="tasks/cancel" && this.taskId && (this.next==="poll"||this.next==="update")) {
      if (!same(p,{taskId:this.taskId})) return false;
      this.cancelled=true;
    } else return false;
    this.next="none";this.requests=undefined;this.state=undefined;
    this.lastId=Number(f.id);this.pending={id:this.lastId,method:String(f.method)};
    return true;
  }
  cancellation(bytes: Uint8Array): boolean {
    if (this.invalid || !this.pending || this.cancelled) return false;
    const f=canonical(bytes);
    if (!f || Object.keys(f).some(k=>!["jsonrpc","method","params"].includes(k)) || f.method!=="notifications/cancelled" || "id" in f || !obj(f.params) || !same(meta(f.params),this.originalMeta) ||
      !same(methodParams(f.params),{requestId:this.pending.id,reason:"Cancelled by caller"})) return false;
    this.cancelled=true;
    return true;
  }
  feed(bytes: Uint8Array): void {
    if (this.invalid || !this.original) return;
    if (this.buffer.length+bytes.byteLength>MAX_LINE) {this.invalid=true;return;}
    this.buffer=Buffer.concat([this.buffer,bytes]);
    for (;;) {
      const end=this.buffer.indexOf(10);
      if (end<0) return;
      const line=this.buffer.subarray(0,end);this.buffer=this.buffer.subarray(end+1);
      if (!line.length) continue;
      const f=frame(line);
      if (!f) {this.invalid=true;return;}
      if (!("id" in f) && typeof f.method==="string") continue; // notifications cannot grant a write
      const current=this.pending;
      if (!current || f.id!==current.id || "method" in f || !("result" in f) || "error" in f) {this.invalid=true;return;}
      this.pending=undefined;this.next="none";
      if (this.cancelled) continue;
      if (current.method==="tools/call") {
        const continuation=InputRequiredCallToolResultV2Schema.safeParse(f.result);
        if (continuation.success && continuation.data.inputRequests && Object.keys(continuation.data.inputRequests).length>0) {
          this.requests=continuation.data.inputRequests;this.state=continuation.data.requestState;this.next="continue";continue;
        }
        const task=CreateTaskResultV2Schema.safeParse(f.result);
        if (task.success && task.data.taskId.length>0 && task.data.taskId.length<=512 && Number.isFinite(Date.parse(task.data.createdAt))) {
          this.taskId=task.data.taskId;this.taskCreatedAt=Date.parse(task.data.createdAt);this.next="poll";
        } else this.completed(f.result);
      } else if (current.method==="tasks/get") {
        const status=GetTaskResultV2Schema.safeParse(f.result);
        if (!status.success || status.data.taskId!==this.taskId || Date.parse(status.data.createdAt)!==this.taskCreatedAt) {this.invalid=true;return;}
        if (status.data.status==="completed") this.completed(status.data.result);
        if (status.data.status==="working") this.next="poll";
        if (status.data.status==="input_required") {this.requests=status.data.inputRequests;this.next="update";}
      } else if (current.method==="tasks/update" && UpdateTaskResultV2Schema.safeParse(f.result).success) this.next="poll";
    }
  }
}
