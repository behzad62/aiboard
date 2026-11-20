import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BrowserInstallSettings } from "../components/BrowserInstallSettings";
import { ExtensionsSettings } from "../components/extensions/ExtensionsSettings";
import { isInitialized } from "../lib/client/store";
import { getToolRuntimeRunnerIfLoaded } from "../lib/client/tool-runtime";

// Settings renders its tabs before this browser's store has loaded, and a large store can take a while. The Tools
// tab's browser card and the Extensions tab read the saved Runner while rendering; a store read before the store
// has loaded throws "Client store not initialized", and Next replaces the whole page with "This page couldn't
// load" until a reload. Both cards must render a loading state instead, and read again when the store is ready.
assert.equal(isInitialized(), false, "this test needs the store not loaded yet");
assert.equal(getToolRuntimeRunnerIfLoaded(), null);

const browserCard = renderToStaticMarkup(<BrowserInstallSettings />);
assert.match(browserCard, /Browser for Builds/);
assert.match(browserCard, /Loading…/);
assert.doesNotMatch(browserCard, /Connect the Runner to see and install browsers/, "a loading store is not a missing Runner");

const extensions = renderToStaticMarkup(<ExtensionsSettings onOpenTools={() => {}} />);
assert.match(extensions, /Loading…/);
assert.doesNotMatch(extensions, /Connect a Runner to manage these extensions/, "a loading store is not a missing Runner");

console.log("PASS settings cards render while the store is loading");
