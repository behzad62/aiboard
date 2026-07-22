import SettingsClient from "./settings-client";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Settings",
  description:
    "Configure provider API keys, models, pricing, defaults, storage, and encryption for AI Board. Everything stays in your browser.",
  path: "/settings",
  // Per-user configuration page — nothing useful for search engines.
  noindex: true,
});

export default function SettingsPage() {
  return <SettingsClient />;
}
