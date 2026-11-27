import { appResourceDomains } from "../../runner-v2/src/mcp-app-resource-policy";
// Host-owned prefix: parsed before any server-supplied markup. No server policy
// can weaken an earlier enforced CSP. The iframe also lacks allow-same-origin.
export const MCP_APP_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'; manifest-src 'none'";
export function mcpAppSrcdoc(html: string, approvedDomains?: readonly string[]): string {
  const domains=appResourceDomains(approvedDomains) ?? [];
  const extra=domains.length ? " "+domains.join(" ") : "";
  const csp=domains.length ? [
    "default-src 'none'", "script-src 'unsafe-inline'"+extra, "style-src 'unsafe-inline'"+extra,
    "img-src data: blob:"+extra, "font-src data:"+extra, "media-src data: blob:"+extra,
    "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'",
    "form-action 'none'", "worker-src 'none'", "manifest-src 'none'",
  ].join("; ") : MCP_APP_CSP;
  return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + csp + '"><meta name="referrer" content="no-referrer">' + html;
}
export const MCP_APP_SANDBOX = "allow-scripts";
export const MCP_APP_PERMISSIONS = "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; usb 'none'; fullscreen 'none'";
export function appHeight(height: unknown): number {
  return typeof height === "number" && Number.isFinite(height) ? Math.max(180, Math.min(900, Math.ceil(height))) : 360;
}
