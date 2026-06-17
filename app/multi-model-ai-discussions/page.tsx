import type { Metadata } from "next";
import Link from "next/link";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Multi-Model AI Discussions",
  description:
    "Use AI Board to run structured multi-model AI discussions where GPT, Claude, Gemini, OpenRouter models, and local models critique each other before a judge model synthesizes the final answer.",
  alternates: { canonical: "/multi-model-ai-discussions" },
  openGraph: {
    title: `Multi-Model AI Discussions | ${SITE_NAME}`,
    description:
      "Run structured conversations between multiple AI models and synthesize a stronger final answer.",
    url: "/multi-model-ai-discussions",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: "Multi-Model AI Discussions",
  description: metadata.description,
  url: `${SITE_URL}/multi-model-ai-discussions`,
};

export default function MultiModelAiDiscussionsPage() {
  return (
    <article className="mx-auto max-w-3xl space-y-10">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <header className="space-y-3">
        <p className="text-sm font-medium text-primary">AI Board workflow</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Multi-model AI discussions
        </h1>
        <p className="text-lg text-muted-foreground">
          Ask one question, let several AI models respond and critique each
          other, then get one synthesized answer from the judge model you choose.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">
          Why use more than one model?
        </h2>
        <p>
          A single AI model can be useful, but it can also miss context, assume
          facts, or overstate confidence. {SITE_NAME} turns the answer into a
          structured discussion. Each model sees the question, reads the other
          responses, and has a chance to refine or challenge the direction
          before the final answer is written.
        </p>
        <p>
          This is useful when the question has trade-offs, uncertainty, or room
          for different expert perspectives. You can combine GPT, Claude,
          Gemini, OpenRouter models, custom OpenAI-compatible endpoints, and
          local models such as Ollama or LM Studio.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">How it works</h2>
        <ol className="list-decimal space-y-2 pl-6">
          <li>Choose a discussion mode and effort level.</li>
          <li>Select the participant models and the judge model.</li>
          <li>Watch the models answer, critique, and revise across rounds.</li>
          <li>
            Read the judge model&apos;s synthesized answer, confidence score, and
            notable dissent.
          </li>
        </ol>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Good use cases</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>Research questions where sources and assumptions matter.</li>
          <li>Planning decisions that need several viewpoints.</li>
          <li>Technical design reviews before implementation.</li>
          <li>Comparing model strengths on the same prompt.</li>
        </ul>
      </section>

      <p>
        <Link href="/" className="underline hover:text-foreground">
          Start a discussion
        </Link>
      </p>
    </article>
  );
}
