/** Ed25519 SPKI pins for each hosted relay's root key; a deliberately invalid placeholder fails closed until deployment. */
export const REMOTE_RELAY_ROOTS: Readonly<Record<string, readonly { readonly keyId: string; readonly publicKey: string }[]>> = Object.freeze({
  "https://mcp.aiboard.me": Object.freeze([Object.freeze({ keyId: "PLACEHOLDER-production", publicKey: "PLACEHOLDER-production-root-key" })]),
  // Generated on the VPS by deploy/setup-host.sh (2026-10-28); the production root key is generated offline.
  "https://mcp-staging.aiboard.me": Object.freeze([Object.freeze({ keyId: "staging-root-1", publicKey: "MCowBQYDK2VwAyEAYSOPTSgTydhBrsD_T71jE0o2CW96nh_gixe26AV_esU" })]),
});
