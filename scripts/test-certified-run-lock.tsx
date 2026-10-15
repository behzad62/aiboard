import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { PresetCards } from "../components/benchmark/run/PresetCards";
import { RunProgressList } from "../components/benchmark/run/RunProgressList";
import { createCertifiedTabRunCoordinator } from "../lib/benchmark/certified/run-session";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for coordinator state");
}

async function main() {
  const coordinator = createCertifiedTabRunCoordinator();
  const teardown = deferred<void>();
  const cancellation = new Error("cancel from remounted panel");
  let activeSignal: AbortSignal | undefined;
  let firstSubscriberCalls = 0;
  let remountedSubscriberCalls = 0;

  const idleSnapshot = coordinator.getSnapshot();
  assert.strictEqual(coordinator.getSnapshot(), idleSnapshot);
  const unsubscribeFirst = coordinator.subscribe(() => firstSubscriberCalls++);
  assert.equal(
    coordinator.tryStart("preset", { presetId: "model-iq" }, async (signal) => {
      activeSignal = signal;
      await teardown.promise;
    }),
    true
  );
  assert.deepEqual(coordinator.getSnapshot(), {
    owner: "preset",
    phase: "running",
    presetId: "model-iq",
    startedAt: coordinator.getSnapshot().startedAt,
  });
  const runningSnapshot = coordinator.getSnapshot();
  assert.notStrictEqual(runningSnapshot, idleSnapshot);
  assert.strictEqual(coordinator.getSnapshot(), runningSnapshot);

  await waitFor(() => activeSignal !== undefined);
  const firstSubscriberCallsBeforeUnsubscribe = firstSubscriberCalls;
  unsubscribeFirst();
  const unsubscribeRemounted = coordinator.subscribe(
    () => remountedSubscriberCalls++
  );
  assert.equal(coordinator.getSnapshot().owner, "preset");
  assert.equal(
    coordinator.tryStart("advanced", {}, async () => undefined),
    false
  );
  assert.equal(coordinator.cancel(cancellation), true);
  const cancellingSnapshot = coordinator.getSnapshot();
  const remountedSubscriberCallsAfterCancel = remountedSubscriberCalls;
  const cancellationSignal = activeSignal;
  assert.notStrictEqual(cancellingSnapshot, runningSnapshot);
  assert.strictEqual(coordinator.getSnapshot(), cancellingSnapshot);
  assert.equal(activeSignal?.aborted, true);
  assert.equal(activeSignal?.reason, cancellation);
  assert.equal(coordinator.getSnapshot().phase, "cancelling");
  assert.equal(coordinator.cancel(cancellation), true);
  assert.strictEqual(activeSignal, cancellationSignal);
  assert.equal(activeSignal?.reason, cancellation);
  assert.strictEqual(coordinator.getSnapshot(), cancellingSnapshot);
  assert.equal(remountedSubscriberCalls, remountedSubscriberCallsAfterCancel);
  assert.equal(coordinator.getSnapshot().owner, "preset");
  assert.equal(coordinator.getSnapshot().phase, "cancelling");
  assert.equal(coordinator.tryStart("advanced", {}, async () => undefined), false);

  teardown.resolve();
  await waitFor(() => coordinator.getSnapshot().owner === null);
  const settledSnapshot = coordinator.getSnapshot();
  assert.notStrictEqual(settledSnapshot, cancellingSnapshot);
  assert.strictEqual(coordinator.getSnapshot(), settledSnapshot);
  assert.equal(coordinator.getSnapshot().phase, "idle");
  assert.equal(coordinator.tryStart("advanced", {}, async () => undefined), true);
  unsubscribeRemounted();
  assert.equal(firstSubscriberCalls, firstSubscriberCallsBeforeUnsubscribe);
  assert.ok(remountedSubscriberCalls >= 2);

  const notificationCoordinator = createCertifiedTabRunCoordinator();
  const notificationTeardown = deferred<void>();
  let removingListenerCalls = 0;
  let removedListenerCalls = 0;
  let unsubscribeRemoved: () => void = () => undefined;
  const unsubscribeRemoving = notificationCoordinator.subscribe(() => {
    removingListenerCalls += 1;
    unsubscribeRemoved();
  });
  unsubscribeRemoved = notificationCoordinator.subscribe(
    () => removedListenerCalls++
  );
  assert.equal(
    notificationCoordinator.tryStart("advanced", {}, async () => {
      await notificationTeardown.promise;
    }),
    true
  );
  assert.equal(removingListenerCalls, 1);
  assert.equal(removedListenerCalls, 1);
  assert.equal(notificationCoordinator.cancel(new Error("self-removal")), true);
  assert.equal(removingListenerCalls, 2);
  assert.equal(removedListenerCalls, 1);
  notificationTeardown.resolve();
  await waitFor(() => notificationCoordinator.getSnapshot().owner === null);
  assert.equal(removingListenerCalls, 3);
  assert.equal(removedListenerCalls, 1);
  unsubscribeRemoving();

  const rejectionCoordinator = createCertifiedTabRunCoordinator();
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    assert.equal(
      rejectionCoordinator.tryStart("advanced", {}, async () => {
        throw new Error("executor failure");
      }),
      true
    );
    await waitFor(() => rejectionCoordinator.getSnapshot().owner === null);
    assert.deepEqual(rejectionCoordinator.getSnapshot(), {
      owner: null,
      phase: "idle",
      error: "executor failure",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }

  const markup = renderToStaticMarkup(
    <PresetCards
      busy
      runningPresetId={null}
      focusedPresetId="model-iq"
      gates={{
        "model-iq": { disabled: false },
        "team-benchmark": { disabled: false },
        "full-certified": { disabled: false },
      }}
      onFocus={() => undefined}
      onRun={() => undefined}
    />
  );

  const runButtons = markup.match(/<button\b[^>]*>/g) ?? [];
  assert.equal(runButtons.length, 3);
  assert.ok(runButtons.every((button) => button.includes("disabled=\"\"")));

  const emptyRunningMarkup = renderToStaticMarkup(
    <RunProgressList rows={[]} running onCancel={() => undefined} />
  );
  assert.match(emptyRunningMarkup, /continues/i);
  assert.match(emptyRunningMarkup, />Cancel<\/button>/);

  console.log("PASS");
}

void main();
