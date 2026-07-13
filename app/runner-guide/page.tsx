import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Runner V2 guide",
  description: "Start and connect the mandatory native Runner V2 agent kernel for AI Board Build mode.",
  alternates: { canonical: "/runner-guide" },
};

export default function RunnerGuidePage() {
  return (
    <article className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Runner V2 guide</h1>
        <p className="mt-2 text-muted-foreground">
          Build mode requires the native Runner V2 process. There is no browser execution fallback.
        </p>
      </header>
      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Prerequisites</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>Node.js 24.18.0 or newer.</li>
          <li>Git installed and available on PATH.</li>
          <li>A state directory outside the project directory.</li>
        </ul>
      </section>
      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Start the runner</h2>
        <pre className="overflow-x-auto rounded-lg border bg-muted p-4 text-sm">
          {"npm run runner:v2 -- --project C:\\path\\to\\project --state-dir C:\\path\\to\\aiboard-state --port 8787"}
        </pre>
        <p>The runner prints a localhost URL and control token. Paste them into Build setup and test the connection.</p>
      </section>
      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Access and handoff</h2>
        <p>
          Guarded access pauses for every mutation. Project Autonomous runs project-contained work without prompts
          but pauses for outside or external effects. Full Access allows destructive, credential, push/PR,
          deployment, and external-system operations without per-action approval. Final project handoff is always
          a user choice in every profile.
        </p>
      </section>
      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Recovery</h2>
        <p>
          Reuse the same project, state directory, port, and token when restarting. Durable sessions, task state,
          evidence, and Git integration state recover before work continues.
        </p>
      </section>
      <p><Link href="/" className="underline hover:text-foreground">Back to the dashboard</Link></p>
    </article>
  );
}
