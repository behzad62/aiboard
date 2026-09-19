import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ownFiniteFixtureChild } from "./support/finite-fixture-child.js";

class Child extends EventEmitter {
  pid = 42; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null;
  signals = 0; accepted = true;
  kill() { this.signals++; return this.accepted; }
  finish() { this.exitCode = 0; this.emit("close", 0, null); }
}

test("finite fixture owner joins actual close and shares the retained direct-child stop", async () => {
  const child = new Child(); const owned = ownFiniteFixtureChild(child);
  let settled = false;
  const a = owned.close().then(() => { settled = true; }); const b = owned.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(child.signals, 1); assert.equal(owned.pid, 42);
  child.finish(); await Promise.all([a, b]); await owned.close(); assert.equal(child.signals, 1);
});

test("finite fixture owner observes close before caller cleanup without sending another signal", async () => {
  const child = new Child(); const owned = ownFiniteFixtureChild(child);
  child.finish(); await owned.close(); assert.equal(child.signals, 0);
});

test("finite fixture owner does not confuse exitCode with completed native close", async () => {
  const child = new Child(); const owned = ownFiniteFixtureChild(child);
  child.exitCode = 0;
  let settled = false; const pending = owned.close().then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(child.signals, 0);
  child.finish(); await pending;
});

test("finite fixture owner preserves its error while still joining close", async () => {
  const child = new Child(); const owned = ownFiniteFixtureChild(child);
  const error = new Error("spawn/transport failure"); child.emit("error", error);
  const pending = owned.close(); child.finish();
  await assert.rejects(pending, (reason: unknown) => reason instanceof AggregateError && reason.errors.includes(error));
});

test("finite fixture owner joins an already-exiting child even when its stop races native exit", async () => {
  const child = new Child(); const owned = ownFiniteFixtureChild(child);
  child.accepted = false;
  let settled = false; const pending = owned.close().then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "an unaccepted signal is not a release certificate");
  child.finish(); await pending;
  assert.equal(child.signals, 1, "native close, not an invented retry or PID signal, settles the owner");
});

test("finite fixture owner retains uncertainty when a stop is unaccepted and no native close follows", async () => {
  const child = new Child(); const owned = ownFiniteFixtureChild(child, 20);
  child.accepted = false;
  await assert.rejects(owned.close(), /close.*unconfirmed/i);
  assert.equal(child.signals, 1);
  child.finish(); await owned.close();
});

test("finite fixture owner retains the exact late close after its bounded caller expires", async () => {
  const child = new Child(); const owned = ownFiniteFixtureChild(child, 20);
  await assert.rejects(owned.close(), /close.*unconfirmed/i);
  assert.equal(child.signals, 1); child.finish();
  await owned.close(); assert.equal(child.signals, 1);
});

test("finite fixture owner never repeats stop while successive bounded callers still await native close", async () => {
  const child = new Child(); const owned = ownFiniteFixtureChild(child, 20);
  await assert.rejects(owned.close(), /close.*unconfirmed/i);
  await assert.rejects(owned.close(), /close.*unconfirmed/i);
  assert.equal(child.signals, 1);
  child.finish(); await owned.close(); assert.equal(child.signals, 1);
});
