/** The relay `aiboard remote` uses when no --relay-url is given. */
export const DEFAULT_REMOTE_RELAY_URL = "wss://mcp.aiboard.me/connect";

/** Ed25519 SPKI pins for each hosted relay's root key. */
export const REMOTE_RELAY_ROOTS: Readonly<Record<string, readonly { readonly keyId: string; readonly publicKey: string }[]>> = Object.freeze({
  // Generated offline and installed by deploy/setup-host.sh; matched against the host's key and the relay volume's copy (2026-11-02).
  "https://mcp.aiboard.me": Object.freeze([Object.freeze({ keyId: "production-root-1", publicKey: "MCowBQYDK2VwAyEAb11m2u0oLpR9fiLcr09V02b027fbZKS_tB1BrBGg9Kc" })]),
  // Generated on the VPS by deploy/setup-host.sh (2026-10-28).
  "https://mcp-staging.aiboard.me": Object.freeze([Object.freeze({ keyId: "staging-root-1", publicKey: "MCowBQYDK2VwAyEAYSOPTSgTydhBrsD_T71jE0o2CW96nh_gixe26AV_esU" })]),
});
