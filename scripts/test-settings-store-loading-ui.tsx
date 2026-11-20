import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BrowserInstallSettings } from "../components/BrowserInstallSettings";
import { ExtensionsSettings } from "../components/extensions/ExtensionsSettings";
import { ProjectAccessSetup } from "../components/ProjectAccessSetup";
import { clearLauncherSession, storeLauncherSession } from "../lib/client/local-runner-handoff";
import { __resetClientStoreForTests, getUserSettings, isInitialized } from "../lib/client/store";
import { getSettingsRunnerConnection, getToolRuntimeRunnerIfLoaded, sameRunnerConnection } from "../lib/client/tool-runtime";

// Pages render before this browser's store has loaded, and a large store can take a while. A store read before
// then throws "Client store not initialized", and Next replaces the whole page with "This page couldn't load"
// until a reload: the Settings Tools and Extensions tabs did this, and so did the Build composer's Runner picker.
// The Runner these cards use is this tab's `aiboard` session first (never saved, needs no store), then a Runner
// saved in this browser once the store has loaded.
const browserCard = () => renderToStaticMarkup(<BrowserInstallSettings />);
const extensions = () => renderToStaticMarkup(<ExtensionsSettings onOpenTools={() => {}} />);
const CONNECT_BROWSERS = /Connect the Runner to see and install browsers/;
const CONNECT_EXTENSIONS = /Connect a Runner to manage these extensions/;
const INSTALL_BUTTON = /Install Playwright&#x27;s Chromium/;

// 1. Store still loading, no `aiboard` session: a loading state, never the "connect a Runner" message.
assert.equal(isInitialized(), false, "this test needs the store not loaded yet");
assert.equal(getToolRuntimeRunnerIfLoaded(), null);
assert.equal(getSettingsRunnerConnection(), null);
assert.match(browserCard(), /Loading…/);
assert.doesNotMatch(browserCard(), CONNECT_BROWSERS, "a loading store is not a missing Runner");
assert.match(extensions(), /Loading…/);
assert.doesNotMatch(extensions(), CONNECT_EXTENSIONS, "a loading store is not a missing Runner");
let picker = "";
assert.doesNotThrow(() => { picker = renderToStaticMarkup(<ProjectAccessSetup />); }, "the Build Runner picker renders while the store loads");
assert.match(picker, /<input type="password"[^>]*\sdisabled=""/, "without a session the picker waits for the store (saving a Runner needs it)");

// 2. Store still loading, connected with `aiboard`: the cards use the session at once.
const SESSION_TOKEN = `session_${"S".repeat(43)}`;
storeLauncherSession({ port: 8787, instanceId: "inst_test", kind: "runner", sessionToken: SESSION_TOKEN }, null);
assert.deepEqual(getSettingsRunnerConnection(), { url: "http://127.0.0.1:8787", token: SESSION_TOKEN });
for (const html of [browserCard(), extensions()]) {
  assert.doesNotMatch(html, /Loading…/);
  assert.doesNotMatch(html, CONNECT_BROWSERS);
  assert.doesNotMatch(html, CONNECT_EXTENSIONS);
}
assert.match(browserCard(), INSTALL_BUTTON);
picker = renderToStaticMarkup(<ProjectAccessSetup />);
assert.match(picker, /127\.0\.0\.1:8787/, "the Build Runner picker shows the session while the store loads");
assert.doesNotMatch(picker, /<input[^>]*\sdisabled=""/, "with a session the picker does not wait for the store");

// 3. Store loaded, still connected with `aiboard`: the session wins (it is never saved in the store).
__resetClientStoreForTests();
assert.equal(isInitialized(), true);
assert.equal(getUserSettings().toolRuntime?.runner ?? null, null);
assert.deepEqual(getSettingsRunnerConnection(), { url: "http://127.0.0.1:8787", token: SESSION_TOKEN });
assert.match(browserCard(), INSTALL_BUTTON);

// 4. Store loaded, no session and no saved Runner: now the "connect a Runner" message is right.
clearLauncherSession(null);
assert.equal(getSettingsRunnerConnection(), null);
assert.match(browserCard(), CONNECT_BROWSERS);
assert.match(extensions(), CONNECT_EXTENSIONS);

// 5. Store loaded with a Runner saved in this browser.
const saved = { url: "http://127.0.0.1:9797", token: "runner-token", access: "ask" as const };
__resetClientStoreForTests({ userSettings: { ...getUserSettings(), toolRuntime: { runner: saved } } });
assert.deepEqual(getSettingsRunnerConnection(), { url: saved.url, token: saved.token });
assert.match(browserCard(), INSTALL_BUTTON);
assert.doesNotMatch(extensions(), CONNECT_EXTENSIONS);

// A re-read of the same Runner keeps the object, so effects that depend on it do not run (and fetch) again.
const current = { url: "http://127.0.0.1:1", token: "t" };
assert.equal(sameRunnerConnection(current, { url: "http://127.0.0.1:1", token: "t" }), current);
const other = { url: "http://127.0.0.1:2", token: "t" };
assert.equal(sameRunnerConnection(current, other), other);
assert.equal(sameRunnerConnection(current, null), null);
assert.equal(sameRunnerConnection(null, other), other);

console.log("PASS settings cards and the Build Runner picker render while the store is loading");
