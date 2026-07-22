import assert from "node:assert/strict";
import configModule from "../next.config.ts";

const nextConfig = "default" in configModule ? configModule.default : configModule;

assert.ok(
  nextConfig.allowedDevOrigins?.includes("127.0.0.1"),
  "Next dev must allow the 127.0.0.1 origin so HMR and hydration work there"
);

console.log("next dev origins: ok");
