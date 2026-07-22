import DiscussionClient from "./discussion-client";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Discussion",
  description:
    "A running multi-model AI discussion, streamed live in your browser and stored only on your machine.",
  path: "/discussion",
  // Per-user, locally stored content — nothing useful for search engines.
  noindex: true,
});

export default function DiscussionPage() {
  return <DiscussionClient />;
}
