import SettingsClient from "./settings-client";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Settings",
  description:
    "Configure provider API keys, models, pricing, defaults, and storage for AI Board. Settings and keys are saved on your computer, in the AIBoard home.",
  path: "/settings",
  // Per-user configuration page — nothing useful for search engines.
  noindex: true,
});

export default function SettingsPage() {
  return <SettingsClient />;
}
