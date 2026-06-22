import type { Metadata } from "next";
import Link from "next/link";
import { SITE_CONTACT_EMAIL, SITE_GITHUB_URL, SITE_NAME } from "@/lib/site";

export const metadata: Metadata = {
  title: "About",
  description:
    "How AI Board works: multi-model panel, debate, specialist, and build modes; judge synthesis; and a local-first design where your API keys never leave your browser.",
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <article className="mx-auto max-w-3xl space-y-10">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          About {SITE_NAME}
        </h1>
        <p className="mt-2 text-muted-foreground">
          One question, several AI models, one synthesized best answer.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">What it does</h2>
        <p>
          The {SITE_NAME} orchestrates a structured discussion between multiple
          AI models — OpenAI GPT, Anthropic Claude, Google Gemini, anything on
          OpenRouter, or your own OpenAI-compatible endpoints such as Ollama
          and LM Studio. You ask one question; the models answer, read each
          other&apos;s responses, and critique and refine their positions over
          several rounds. When the discussion converges (or the configured
          effort level is reached), a judge model you choose reads the whole
          transcript and writes a single, synthesized final answer with a
          confidence score and any notable dissent.
        </p>
        <p>
          One strong model can be wrong with great confidence. Several models
          that must defend their answers against each other catch more
          mistakes, surface more perspectives, and produce a better-grounded
          result than any single response.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Discussion modes</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Collaborative panel</strong> — models work together,
            building on each other&apos;s answers toward consensus.
          </li>
          <li>
            <strong>Debate</strong> — models take opposing positions and argue
            them, useful for decisions and trade-offs.
          </li>
          <li>
            <strong>Specialist + reviewers</strong> — one model drafts the
            answer while the others review and demand fixes.
          </li>
          <li>
            <strong>Build mode</strong> — an architect model breaks a coding
            task into work items and worker models implement them in parallel
            waves. Files can be written to a real project folder on your
            machine, downloaded as a zip, or applied through an optional local
            runner that adds shell access, MCP tools, and a browser control
            panel to pick the project folder, watch live activity, manage MCP
            servers, and keep itself current with a signed self-update.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">
          Local-first and private by design
        </h2>
        <p>
          There is no backend. The app is a static site; the orchestration
          engine runs entirely in your browser tab and calls the AI providers
          directly with the API keys you enter on the Settings page. Keys,
          discussions, and attachments are stored in your browser (IndexedDB)
          or in a local folder you pick — optionally encrypted with a
          passphrase using AES-256-GCM. Nothing is ever uploaded to a server
          of ours, because there isn&apos;t one.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Contact</h2>
        <p>
          For feedback, bug reports, privacy questions, or collaboration,
          email{" "}
          <a
            href={`mailto:${SITE_CONTACT_EMAIL}`}
            className="underline hover:text-foreground"
          >
            {SITE_CONTACT_EMAIL}
          </a>
          .
        </p>
        <p>
          Source code is available on{" "}
          <a
            href={SITE_GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            GitHub
          </a>
          .
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Learn more</h2>
        <p className="text-muted-foreground">
          These short guides explain the main workflows without adding more
          navigation to the app itself.
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <Link
              href="/multi-model-ai-discussions"
              className="underline hover:text-foreground"
            >
              Multi-model AI discussions
            </Link>
          </li>
          <li>
            <Link href="/ai-debate-tool" className="underline hover:text-foreground">
              AI debate tool
            </Link>
          </li>
          <li>
            <Link href="/build-mode" className="underline hover:text-foreground">
              Build mode for AI-assisted coding
            </Link>
          </li>
          <li>
            <Link href="/runner-guide" className="underline hover:text-foreground">
              Runner guide — local runner &amp; control panel
            </Link>
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">FAQ</h2>
        <dl className="space-y-4">
          <div>
            <dt className="font-semibold">Is it free?</dt>
            <dd className="text-muted-foreground">
              The app itself is free and open source. You pay your AI
              providers directly for the tokens the discussion uses; the app
              shows a cost estimate before you start.
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Which API keys do I need?</dt>
            <dd className="text-muted-foreground">
              At least one provider key (OpenAI, Anthropic, Google, or
              OpenRouter) — two or more models make discussions worthwhile.
              Local models via Ollama or LM Studio need no key at all.
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Can I use it offline?</dt>
            <dd className="text-muted-foreground">
              The app loads as a static site, but discussions need network
              access to reach the AI providers — unless you use only local
              models on your own machine.
            </dd>
          </div>
        </dl>
      </section>

      <p>
        <Link href="/" className="underline hover:text-foreground">
          Start a discussion
        </Link>
      </p>
    </article>
  );
}
