import Link from "next/link";
import { articleJsonLd, jsonLdScriptProps, pageMetadata } from "@/lib/site";

const PATH = "/build-mode";
const DESCRIPTION =
  "Build mode turns a judge model into an architect that plans coding tasks, assigns worker models, reviews their output, and writes files locally.";

export const metadata = pageMetadata({
  title: "Build Mode",
  description: DESCRIPTION,
  path: PATH,
  ogType: "article",
  ogDescription:
    "Use multiple AI models as an architect-and-worker team for coding tasks.",
});

const jsonLd = articleJsonLd({
  headline: "Build Mode",
  description: DESCRIPTION,
  path: PATH,
  datePublished: "2026-06-17",
  dateModified: "2026-07-13",
});

export default function BuildModePage() {
  return (
    <article className="mx-auto max-w-3xl space-y-10">
      <script {...jsonLdScriptProps(jsonLd)} />
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
          Native Runner V2 kernel
        </h2>
        <p>
          Build execution never runs in the browser. Runner V2 owns durable
          checkpoints, isolated Git worktrees, native tools, skills, project
          memory, evidence, provider failover, and recovery. It requires Git
          and Node.js 24.18.0 or newer and stops before model calls when
          prerequisites are missing. When the Architect finishes, the run
          pauses for your final project handoff decision.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">When to use it</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>Scaffolding a small app or feature from a clear prompt.</li>
          <li>Splitting implementation work across several AI models.</li>
          <li>Letting one model review another model&apos;s code before hand-off.</li>
          <li>Running real local checks through a durable native agent kernel.</li>
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
