import Link from "next/link";
import DashboardPage from "@/components/DashboardPage";
import {
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TAGLINE,
  SITE_URL,
  jsonLdScriptProps,
  pageMetadata,
} from "@/lib/site";

export const metadata = pageMetadata({
  title: `${SITE_NAME} — Multi-Model AI Discussions in Your Browser`,
  absoluteTitle: true,
  description: SITE_DESCRIPTION,
  path: "/",
});

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

const cardLink = "underline underline-offset-4 hover:text-foreground";

export default function HomePage() {
  return (
    <>
      <script {...jsonLdScriptProps(jsonLd)} />
      <div className="mx-auto max-w-6xl">
        <div className="mb-8">
          <h1 className="font-display text-3xl font-semibold tracking-tight">
            {SITE_NAME}
          </h1>
          <p className="mt-1 text-muted-foreground">{SITE_TAGLINE}.</p>
        </div>

        <DashboardPage />

        {/* Crawlable description of the product. The dashboard above is empty
            for a first-time visitor, so without this the highest-value page in
            the site has almost no indexable body copy. */}
        <section className="mt-16 border-t pt-10">
          <h2 className="font-display text-2xl font-semibold tracking-tight">
            One question, several AI models, one answer
          </h2>
          <p className="mt-3 max-w-3xl text-muted-foreground">
            {SITE_NAME} runs a structured discussion between models from OpenAI,
            Anthropic, Google, OpenRouter, and any OpenAI-compatible endpoint
            such as Ollama or LM Studio. Each model answers your question, reads
            what the others said, and refines or challenges its position across
            several rounds. A judge model you choose then reads the whole
            transcript and writes one synthesized answer with a confidence score
            and any notable dissent.
          </p>
          <p className="mt-3 max-w-3xl text-muted-foreground">
            A single model can be wrong with great confidence. Several models
            that have to defend their reasoning against each other catch more
            mistakes and surface more perspectives than any one response.
          </p>

          <div className="mt-10 grid gap-8 sm:grid-cols-2">
            <div>
              <h3 className="font-semibold">Ways to run a discussion</h3>
              <ul className="mt-3 space-y-2 text-muted-foreground">
                <li>
                  <Link href="/multi-model-ai-discussions" className={cardLink}>
                    Multi-model discussions
                  </Link>{" "}
                  — models collaborate toward a consensus answer.
                </li>
                <li>
                  <Link href="/ai-debate-tool" className={cardLink}>
                    AI debate tool
                  </Link>{" "}
                  — models argue opposing positions to expose trade-offs.
                </li>
                <li>
                  <Link href="/build-mode" className={cardLink}>
                    Build mode
                  </Link>{" "}
                  — an architect model plans coding tasks and worker models
                  implement them in parallel.
                </li>
                <li>
                  <Link href="/games" className={cardLink}>
                    Games
                  </Link>{" "}
                  — play chess, Connect Four, Battleship, Codenames, or
                  Fireworks against the models.
                </li>
              </ul>
            </div>

            <div>
              <h3 className="font-semibold">Local-first by design</h3>
              <p className="mt-3 text-muted-foreground">
                There is no backend. The orchestration engine runs entirely in
                your browser tab and calls the providers directly with the API
                keys you enter on the Settings page. Keys, discussions, and
                attachments stay in your browser or in a local folder you pick,
                optionally encrypted with a passphrase. Nothing is uploaded to a
                server of ours, because there isn&apos;t one.
              </p>
              <p className="mt-3 text-muted-foreground">
                Read more{" "}
                <Link href="/about" className={cardLink}>
                  about how it works
                </Link>
                , or set up the{" "}
                <Link href="/runner-guide" className={cardLink}>
                  Runner V2 agent kernel
                </Link>{" "}
                that Build mode uses for real file and shell access.
              </p>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
