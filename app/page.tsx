import type { Metadata } from "next";
import Link from "next/link";
import DashboardPage from "@/components/DashboardPage";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  description: SITE_DESCRIPTION,
  url: SITE_URL,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web browser",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <div className="mx-auto max-w-6xl">
        <div className="mb-8">
          <h1 className="font-display text-3xl font-semibold tracking-tight">
            {SITE_NAME}
          </h1>
          <p className="mt-1 text-muted-foreground">{SITE_TAGLINE}.</p>
        </div>

        <DashboardPage />

        <section className="mx-auto mt-16 max-w-3xl space-y-4 border-t pt-10 text-sm text-muted-foreground">
        <h2 className="font-display text-xl font-semibold text-foreground">
          What is the AI Discussion Board?
        </h2>
        <p>
          The AI Discussion Board is a free, local-first web app where several
          AI models — GPT, Claude, Gemini, OpenRouter models, or your own
          local/custom endpoints — discuss a question you provide. The models
          critique and refine each other&apos;s answers across structured
          rounds, and a judge model synthesizes a single best answer with a
          confidence score.
        </p>
        <p>
          Choose a discussion style to match the problem: a collaborative
          panel, an adversarial debate, a specialist with reviewers, or Build
          mode, where an architect model plans coding tasks and worker models
          implement them in parallel — writing real files to a project folder
          on your machine.
        </p>
        <p>
          Everything runs in your browser tab. Your API keys and discussion
          history are stored locally (optionally encrypted with a passphrase)
          and are sent only to the AI providers you configure — never to any
          server of ours.
        </p>
        <p>
          <Link href="/about" className="underline hover:text-foreground">
            Learn more about how it works
          </Link>
          .
        </p>
        </section>
      </div>
    </>
  );
}
