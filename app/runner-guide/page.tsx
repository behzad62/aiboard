import type { Metadata } from "next";
import Link from "next/link";
import fs from "node:fs";
import path from "node:path";
import { SITE_NAME } from "@/lib/site";

export const metadata: Metadata = {
  title: "Runner guide",
  description:
    "How to run the AI Board local runner: the browser control panel, project folders, MCP servers, remote access via tunnels, and signed self-update.",
  alternates: { canonical: "/runner-guide" },
};

// The guide is authored once in scripts/runner-help.html and inlined into the
// runner's own control panel at build time; this page renders the same source so
// the two never drift. Read at build (static export runs in Node).
export default function RunnerGuidePage() {
  const help = fs.readFileSync(
    path.join(process.cwd(), "scripts", "runner-help.html"),
    "utf8"
  );
  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Runner guide
        </h1>
        <p className="mt-2 text-muted-foreground">
          Connect a real project folder to {SITE_NAME} Build mode with the
          optional local runner — and manage it from a browser control panel.
        </p>
      </header>
      <div
        className="runner-prose prose prose-sm dark:prose-invert max-w-none prose-headings:font-display prose-a:text-primary"
        dangerouslySetInnerHTML={{ __html: help }}
      />
      <p>
        <Link href="/" className="underline hover:text-foreground">
          Back to the dashboard
        </Link>
      </p>
    </article>
  );
}
