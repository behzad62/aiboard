// Shared by Runner validation and the browser CSP builder. No Node dependencies.
export const MAX_APP_RESOURCE_DOMAINS = 8;

/** Exact HTTPS origins only. No wildcard, path, credential, non-default
 * port, IP literal, local hostname or CSP keyword. DNS is not pinned by CSP;
 * the user must trust the approved origin and its DNS. */
export function appResourceDomains(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_APP_RESOURCE_DOMAINS) return;
  const domains: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || value.length > 260 ||
      !/^https:\/\/[a-z0-9.-]+\/?$/i.test(value)) return;
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      const labels = host.split(".");
      if (url.protocol !== "https:" || url.username || url.password || url.port ||
        url.pathname !== "/" || url.search || url.hash || host.length > 253 ||
        labels.length < 2 || !/^[a-z]{2,63}$/.test(labels.at(-1)!) ||
        labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
        /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(host) ||
        host.endsWith(".home.arpa")) return;
      if (!domains.includes(url.origin)) domains.push(url.origin);
    } catch { return; }
  }
  return Object.freeze(domains);
}
