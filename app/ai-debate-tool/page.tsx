import Link from "next/link";
import {
  SITE_NAME,
  articleJsonLd,
  jsonLdScriptProps,
  pageMetadata,
} from "@/lib/site";

const PATH = "/ai-debate-tool";
const DESCRIPTION =
  "Use AI Board as an AI debate tool: assign models opposing positions, surface trade-offs, and let a judge model produce a balanced final answer.";

export const metadata = pageMetadata({
  title: "AI Debate Tool",
  description: DESCRIPTION,
  path: PATH,
  ogType: "article",
  ogDescription:
    "Use multiple AI models to argue competing positions before synthesizing the best answer.",
});

const jsonLd = articleJsonLd({
  headline: "AI Debate Tool",
  description: DESCRIPTION,
  path: PATH,
  datePublished: "2026-06-17",
  dateModified: "2026-06-17",
});

export default function AiDebateToolPage() {
  return (
    <article className="mx-auto max-w-3xl space-y-10">
      <script {...jsonLdScriptProps(jsonLd)} />
      <header className="space-y-3">
        <p className="text-sm font-medium text-primary">AI Board workflow</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          AI debate tool
        </h1>
        <p className="text-lg text-muted-foreground">
          Put models into a structured debate so they expose assumptions,
          counterarguments, and trade-offs before the final answer is written.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">
          Debate is useful when the answer is not obvious
        </h2>
        <p>
          Some prompts are not just information lookups. They involve judgment:
          which architecture to choose, whether a risk is acceptable, how to
          balance speed against quality, or what assumptions are hidden in a
          plan. Debate mode gives models room to disagree instead of forcing
          early consensus.
        </p>
        <p>
          In {SITE_NAME}, each model argues a position, responds to the other
          side, and refines its reasoning over multiple rounds. The judge model
          then reads the whole debate and writes a final answer that preserves
          the strongest arguments and calls out remaining uncertainty.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">
          What to ask in debate mode
        </h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>Should we build this feature now or defer it?</li>
          <li>Which model/provider is best for this workload?</li>
          <li>What are the strongest objections to this plan?</li>
          <li>What trade-offs matter before making this decision?</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">
          Better than a single confident answer
        </h2>
        <p>
          The goal is not to make models argue for show. The goal is to make
          assumptions visible. When the final answer arrives, you can see which
          concerns were resolved, which points remained disputed, and how much
          confidence the judge had in the synthesis.
        </p>
      </section>

      <p>
        <Link href="/" className="underline hover:text-foreground">
          Start a debate
        </Link>
      </p>
    </article>
  );
}
