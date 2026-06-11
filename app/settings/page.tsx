import type { Metadata } from "next";
import SettingsClient from "./settings-client";

export const metadata: Metadata = {
  title: "Settings",
  // Per-user configuration page — nothing useful for search engines.
  robots: { index: false },
};

export default function SettingsPage() {
  return <SettingsClient />;
}
