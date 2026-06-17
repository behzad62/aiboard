import type { Metadata } from "next";
import Link from "next/link";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Build Mode",
  description:
    "AI Board Build mode turns a judge model into an architect that plans coding tasks, assigns worker models, reviews their output, and writes files through a local-first workflow.",
  alternates: { canonical: "/build-mode" },
  openGraph: {
    title: `Build Mode | ${SITE_NAME}`,
    description:
      "Use multiple AI models as an architect-and-worker team for coding tasks.",
    url: "/build-mode",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: "Build Mode",
  description: metadata.description,
  url: `${SITE_URL}/build-mode`,
};

export default function BuildModePage() {
  return (
    <article className="mx-auto max-w-3xl space-y-10">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <header className="space-y-3">
        <p className="text-sm font-medium text-primary">AI Board workflow</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Build mode
        </h1>
        <p className="text-lg text-muted-foreground">
          Turn several AI models into a coding team: one architect plans and
          reviews, while worker models implement focused tasks in parallel.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">
          Architect and worker models
        </h2>
        <p>
          In Build mode, the judge model becomes the architect. It breaks your
          request into concrete tasks, assigns those tasks to worker models,
          reviews the results, asks for fixes when needed, and writes a final
          hand-off summary.
        </p>
        <p>
          Worker models handle focused pieces of the implementation. The
          architect tracks approvals, fixes, failures, and throughput so the
          strongest available models are favored over time.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">
          Local-first project access
        </h2>
        <p>
          Files can stay in the browser, be downloaded as a zip, be written to a
          browser-picked folder, or go through the optional local runner. The
          runner is a script you start yourself. It can write to your project
          folder, run tests/builds with your approval, fetch public pages, and
          bridge MCP tools such as Playwright, Context7, or SearXNG search.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">When to use it</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>Scaffolding a small app or feature from a clear prompt.</li>
          <li>Splitting implementation work across several AI models.</li>
          <li>Letting one model review another model&apos;s code before hand-off.</li>
          <li>Running local checks through a user-controlled runner.</li>
        </ul>
      </section>

      <p>
        <Link href="/" className="underline hover:text-foreground">
          Start a build
        </Link>
      </p>
    </article>
  );
}
