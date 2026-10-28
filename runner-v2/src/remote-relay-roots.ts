/** Deployment must replace these deliberately invalid placeholders with real Ed25519 SPKI pins. */
export const REMOTE_RELAY_ROOTS: Readonly<Record<string, readonly { readonly keyId: string; readonly publicKey: string }[]>> = Object.freeze({
  "https://mcp.aiboard.me": Object.freeze([Object.freeze({ keyId: "PLACEHOLDER-production", publicKey: "PLACEHOLDER-production-root-key" })]),
  "https://mcp-staging.aiboard.me": Object.freeze([Object.freeze({ keyId: "PLACEHOLDER-staging", publicKey: "PLACEHOLDER-staging-root-key" })]),
});
