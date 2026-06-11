import type { Metadata } from "next";
import DiscussionClient from "./discussion-client";

export const metadata: Metadata = {
  title: "Discussion",
  // Per-user, locally stored content — nothing useful for search engines.
  robots: { index: false },
};

export default function DiscussionPage() {
  return <DiscussionClient />;
}
