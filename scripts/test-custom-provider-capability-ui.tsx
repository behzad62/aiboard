import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomModelsManager } from "../components/CustomModelsManager";

const html = renderToStaticMarkup(<CustomModelsManager />);

for (const text of [
  "Supported inputs",
  "Declared tool support",
  "Function calling",
  "Web search",
  "Chat Completions",
  "Responses API",
]) {
  assert.match(html, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
}
assert.match(
  html,
  /not auto-detected|your explicit declaration|declare.*endpoint support/i,
  "custom tool controls must clearly say capability support is user-declared",
);
console.log("PASS custom provider settings distinguish media inputs from declared tool/transport support");
