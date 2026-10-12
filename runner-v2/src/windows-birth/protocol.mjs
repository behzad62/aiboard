// External compiler-free prototype. Execution is held pending exact static review.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { connect } from 'node:net';
import { performance } from 'node:perf_hooks';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

export const FRAME_MAX = 4096;
export const SAB_BYTES = 8192;
export const WAITING = 1, RESULT = 2, EXPIRED = 3, CLOSED = 4;
const TYPES = new Set(['HELLO', 'READY', 'QUERY', 'RESULT', 'HANG', 'BLOCKED']);
const hex = (s, n) => typeof s === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
export function errorFacts(error, depth = 0) {
  const value = { class: String(error?.name ?? 'Error').slice(0, 80), code: String(error?.code ?? 'UNKNOWN').slice(0, 80), message: String(error?.message ?? error).slice(0, 512) };
  if (typeof error?.stack === 'string') value.stack = error.stack.slice(0, 2048);
  if (depth < 3 && error?.cause instanceof Error) value.cause = errorFacts(error.cause, depth + 1);
  if (depth < 3 && error instanceof AggregateError) value.errors = error.errors.slice(0,4).map(e => errorFacts(e, depth + 1));
  return value;
}
export function validTuple(t) {
  if (!t || Object.keys(t).sort().join(',') !== 'generation,nonce,payload,pid,seq,source,type' || !TYPES.has(t.type) || !hex(t.source, 64) || !hex(t.generation, 64) || !hex(t.nonce, 32)) throw new Error('Invalid tuple');
  const handshake = t.type === 'HELLO' || t.type === 'READY';
  if (!Number.isSafeInteger(t.seq) || (handshake ? t.seq !== 0 : t.seq < 1 || t.seq > 999999999)) throw new Error('Invalid sequence');
  if (!Number.isSafeInteger(t.pid) || (handshake ? t.pid !== 0 : t.pid < 1 || t.pid > 2147483647)) throw new Error('Invalid PID');
  if (typeof t.payload !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(t.payload) || t.payload.includes('|')) throw new Error('Invalid payload');
  if (['HELLO', 'QUERY', 'HANG'].includes(t.type) && t.payload !== '-') throw new Error('Invalid request payload');
  if (['READY', 'BLOCKED'].includes(t.type) && t.payload !== '0:0') throw new Error('Invalid zero counters');
  if (t.type === 'RESULT' && !(/^SAME:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(t.payload) || /^UNKNOWN:[A-Za-z0-9_-]{1,480}$/.test(t.payload))) throw new Error('Invalid result payload');
  return t;
}
export function encodeFrame(t, secret, direction) {
  validTuple(t);
  if (!hex(secret, 64) || !['c2s', 's2c'].includes(direction)) throw new Error('Invalid auth context');
  const body = ['v1', t.type, t.source, t.generation, String(t.seq), t.nonce, String(t.pid), t.payload].join('|');
  const mac = createHmac('sha256', Buffer.from(secret, 'hex')).update(direction + '\0' + body, 'ascii').digest('hex');
  const raw = Buffer.from(body + '|' + mac, 'ascii');
  if (raw.length > FRAME_MAX) throw new Error('Oversize frame');
  const out = Buffer.alloc(raw.length + 4); out.writeUInt32LE(raw.length); raw.copy(out, 4); return out;
}
export function decodeFrame(raw, secret, direction) {
  if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > FRAME_MAX || raw.some(b => b < 33 || b > 126)) throw new Error('Invalid frame bytes');
  const parts = raw.toString('ascii').split('|');
  if (parts.length !== 9 || parts[0] !== 'v1' || !hex(parts[8], 64) || !hex(secret, 64) || !['c2s', 's2c'].includes(direction)) throw new Error('Invalid frame shape');
  if (!/^(0|[1-9]\d{0,8})$/.test(parts[4]) || !/^(0|[1-9]\d{0,9})$/.test(parts[6])) throw new Error('Noncanonical number');
  const mac = createHmac('sha256', Buffer.from(secret, 'hex')).update(direction + '\0' + parts.slice(0, 8).join('|'), 'ascii').digest();
  if (!timingSafeEqual(mac, Buffer.from(parts[8], 'hex'))) throw new Error('Bad MAC');
  return validTuple({ type: parts[1], source: parts[2], generation: parts[3], seq: Number(parts[4]), nonce: parts[5], pid: Number(parts[6]), payload: parts[7] });
}
export class FrameReader {
  constructor(onFrame) { this.onFrame = onFrame; this.header = Buffer.alloc(4); this.headerUsed = 0; this.body = null; this.bodyUsed = 0; }
  push(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.body) {
        const take = Math.min(4 - this.headerUsed, chunk.length - offset);
        chunk.copy(this.header, this.headerUsed, offset, offset + take); this.headerUsed += take; offset += take;
        if (this.headerUsed !== 4) continue;
        const length = this.header.readUInt32LE();
        if (length < 1 || length > FRAME_MAX) throw new Error('Oversize/empty length before allocation');
        this.body = Buffer.alloc(length); this.bodyUsed = 0;
      }
      const take = Math.min(this.body.length - this.bodyUsed, chunk.length - offset);
      chunk.copy(this.body, this.bodyUsed, offset, offset + take); this.bodyUsed += take; offset += take;
      if (this.bodyUsed === this.body.length) {
        const complete = this.body; this.body = null; this.headerUsed = 0; this.bodyUsed = 0; this.onFrame(complete);
      }
    }
  }
  finish() { if (this.headerUsed || this.body) throw new Error('Partial frame at EOF'); }
}
export function publishResult(sab, result, now, deadline) {
  const state = new Int32Array(sab, 0, 4);
  if (Atomics.load(state, 0) !== WAITING) return false;
  if (now >= deadline) { Atomics.compareExchange(state, 0, WAITING, EXPIRED); Atomics.notify(state, 0); return false; }
  const bytes = Buffer.from(JSON.stringify(result), 'utf8');
  if (bytes.length > sab.byteLength - 16) throw new Error('SAB result overflow');
  // A private non-reused slot has one writer. Payload precedes the release CAS.
  new Uint8Array(sab, 16).set(bytes); Atomics.store(state, 1, bytes.length);
  const won = Atomics.compareExchange(state, 0, WAITING, RESULT) === WAITING;
  Atomics.notify(state, 0); return won;
}
export function normalizeUtc7(value) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{7})Z$/.exec(value);
  if (!match) throw new Error('Bad UTC witness');
  const ms = Date.parse(match[1] + '.' + match[2].slice(0, 3) + 'Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== match[1] + '.' + match[2].slice(0, 3) + 'Z') throw new Error('Noncanonical UTC calendar');
  return `${match[1]}.${match[2].slice(0, 6)}Z`;
}
export function parseNativeError(payload) {
  if (!/^UNKNOWN:[A-Za-z0-9_-]{1,480}$/.test(payload)) throw new Error('Invalid error payload');
  const encoded = payload.slice(8), raw = Buffer.from(encoded, 'base64url');
  if (raw.toString('base64url') !== encoded) throw new Error('Noncanonical error encoding');
  const text = raw.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(raw) || !/^\{"code":"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*","class":"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*","message":"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"\}$/.test(text)) throw new Error('Nonfixed error JSON');
  const value = JSON.parse(text);
  if (!value || Object.keys(value).join(',') !== 'code,class,message' || !['code', 'class', 'message'].every(k => typeof value[k] === 'string') || value.code.length > 80 || value.class.length > 80 || value.message.length > 160) throw new Error('Invalid native error facts');
  return value;
}

// The actual Worker uses this same lane; pure controls can exercise its authority checks.
export class ResponseLane {
  constructor(cfg, hooks = {}, clock = () => performance.now()) {
    this.cfg=cfg; this.hooks=hooks; this.clock=clock; this.ready=false; this.active=null; this.lastSequence=0; this.usedNonces=new Set();
    this.handshake={type:'HELLO',source:cfg.source,generation:cfg.generation,seq:0,nonce:cfg.challenge,pid:0,payload:'-'};
  }
  poison(error) {
    Atomics.store(new Int32Array(this.cfg.generationState),0,1);
    if(this.active){const s=new Int32Array(this.active.sab,0,4);Atomics.compareExchange(s,0,WAITING,CLOSED);Atomics.notify(s,0);}
    throw error;
  }
  begin(m) {
    try {
      const cfg=this.cfg;
      if(!m||m.type!=='request'||!this.ready||this.active||Atomics.load(new Int32Array(cfg.generationState),0)!==0||m.generation!==cfg.generation||!(m.sab instanceof SharedArrayBuffer)||m.sab.byteLength!==SAB_BYTES||!Number.isFinite(m.deadline))throw Error('Unusable generation/request');
      const t=validTuple(m.tuple);
      if(!['QUERY','HANG'].includes(t.type)||t.source!==cfg.source||t.generation!==cfg.generation||t.seq!==this.lastSequence+1||this.usedNonces.has(t.nonce)||(t.type==='HANG'&&!['G3','G4'].includes(cfg.case)))throw Error('Request authority/domain');
      if(Atomics.load(new Int32Array(m.sab,0,4),0)!==WAITING||this.clock()>=m.deadline)throw Error('Expired request before dispatch');
      this.lastSequence=t.seq;this.usedNonces.add(t.nonce);this.active={sab:m.sab,tuple:t,deadline:m.deadline,blocked:false};return t;
    }catch(error){this.poison(error);}
  }
  accept(raw) {
    try {
      const cfg=this.cfg,t=decodeFrame(raw,cfg.secret,'s2c'),exact=e=>t.source===cfg.source&&t.generation===cfg.generation&&t.seq===e.seq&&t.nonce===e.nonce&&t.pid===e.pid;
      if(Atomics.load(new Int32Array(cfg.generationState),0)!==0)throw Error('Reply to poisoned generation');
      if(!this.ready){if(t.type!=='READY'||!exact(this.handshake)||t.payload!=='0:0')throw Error('Foreign READY');this.ready=true;this.hooks.ready?.();return;}
      if(!this.active||!exact(this.active.tuple))throw Error('Unsolicited/duplicate/foreign response');
      if(t.type==='BLOCKED'&&this.active.tuple.type==='HANG'&&!this.active.blocked){this.active.blocked=true;this.hooks.blocked?.(t.seq);return;}
      if(t.type!=='RESULT'||this.active.tuple.type!=='QUERY')throw Error('Invalid reply domain');
      const result=t.payload.startsWith('SAME:')?{status:'same',fingerprint:normalizeUtc7(t.payload.slice(5)),utc7:t.payload.slice(5)}:{status:'unknown',reason:'native_error',nativeErrorFacts:parseNativeError(t.payload)};
      const won=publishResult(this.active.sab,{...result,generation:cfg.generation,seq:t.seq,nonce:t.nonce,pid:t.pid,raw:raw.toString('ascii')},this.clock(),this.active.deadline);
      this.active=null;if(!won)throw Error('Late response poisoned generation');
    }catch(error){this.poison(error);}
  }
}
