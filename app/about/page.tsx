import Link from "next/link";
import {
  SITE_CONTACT_EMAIL,
  SITE_GITHUB_URL,
  SITE_NAME,
  faqJsonLd,
  jsonLdScriptProps,
  pageMetadata,
} from "@/lib/site";

export const metadata = pageMetadata({
  title: "About",
  description:
    "How AI Board works: multi-model chat with judge synthesis, multi-agent builds on Runner V2, a benchmark for your own models, and a local-first design.",
  path: "/about",
});

// Rendered below AND emitted as FAQPage JSON-LD — Google requires the answer
// text to be visible on the page, so both come from this one array.
const FAQ = [
  {
    question: "Is it free?",
    answer:
      "The official app is free to use, and its source is available for study and upstream contributions under the AIBoard Community Source License. Independent redistribution or hosting requires permission. You pay your AI providers directly for the tokens used.",
  },
  {
    question: "Which API keys do I need?",
    answer:
      "At least one provider key or connected account. Chat compares two or more models; a build needs an architect and at least one worker, which can be the same model. Local models via Ollama or LM Studio need no key at all.",
  },
  {
    question: "Can I use it offline?",
    answer:
      "The app loads as a static site, but chats and builds need network access to reach the AI providers — unless you use only local models on your own machine.",
  },
  {
    question: "Can I use my ChatGPT subscription instead of an API key?",
    answer:
      "Yes. Connect a ChatGPT Plus/Pro or GitHub Copilot account through the local account runner and its models appear alongside your API-key models — in chat and in Build mode. Rate limits and availability are governed by your provider account.",
  },
];

export default function AboutPage() {
  return (
    <article className="mx-auto max-w-3xl space-y-10">
      <script {...jsonLdScriptProps(faqJsonLd(FAQ))} />
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          About {SITE_NAME}
        </h1>
        <p className="mt-2 text-muted-foreground">
          A local-first AI harness: chat and build with the models you choose,
          from the providers you already use.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Chat</h2>
        <p>
          Ask one question and several models work it out together. They
          answer, read each other&apos;s responses, and refine or challenge
          their positions over a few rounds. A judge model you pick then writes
          one answer with a confidence score and any notable dissent.
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Panel</strong> — models build on each other toward a shared
            answer.
          </li>
          <li>
            <strong>Debate</strong> — models argue opposing positions so the
            trade-offs come out.
          </li>
          <li>
            <strong>Specialist + reviewers</strong> — one model drafts, the
            others review and demand fixes.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Build</h2>
        <p>
          Describe a change and a crew carries it out on your own repository.
          An architect plans the work as tasks, workers implement them in
          isolated Git worktrees, and an independent verifier checks the
          evidence before anything is accepted. You approve the gates that
          matter and choose how the finished work is handed back.
        </p>
        <p>
          Builds run on{" "}
          <Link href="/runner-guide" className="underline hover:text-foreground">
            Runner V2
          </Link>
          , a native agent kernel you start on your machine. It owns files,
          Git, shell commands, checkpoints, and recovery — the browser never
          executes project code.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Any provider</h2>
        <p>
          OpenAI, Anthropic (direct or Azure Foundry), Google Gemini,
          OpenRouter, xAI, Meta, NVIDIA NIM, and any OpenAI-compatible
          endpoint such as Ollama or LM Studio. ChatGPT Plus/Pro and GitHub
          Copilot accounts work too, through a small local account runner.
          Mix them freely: a strong architect with inexpensive workers is a
          common build crew.
        </p>
        <p>
          The{" "}
          <Link href="/benchmark" className="underline hover:text-foreground">
            Benchmark
          </Link>{" "}
          measures which models and teams work best for you — tool use,
          team lift, and real build tasks — using your own keys.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">
          Local-first and private by design
        </h2>
        <p>
          There is no backend. The app is a static site that calls the AI
          providers directly with the keys you enter in Settings. Keys,
          sessions, and attachments stay in your browser (IndexedDB) or in a
          local folder you pick, optionally encrypted with a passphrase using
          AES-256-GCM. Nothing is uploaded to a server of ours, because there
          isn&apos;t one.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">
          Use an AI account you already pay for
        </h2>
        <p>
          If you subscribe to ChatGPT Plus/Pro or GitHub Copilot, you can point{" "}
          {SITE_NAME} at that account instead of entering per-token API keys. A
          small account runner runs on your machine, you authorize it once with
          OpenAI or GitHub, and the app talks to it over localhost — the login
          stays in a file on your computer.
        </p>
        <p>
          A connected account works everywhere the app uses models: chat,
          builds, and the benchmark.
        </p>
        <p>
          This draws on your account&apos;s own entitlement, so rate limits,
          model availability, and behavior are set by OpenAI or GitHub rather
          than by {SITE_NAME}.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Author and license</h2>
        <p>
          AI Board was created by <strong>Behzad Shams</strong>.
          Copyright © 2026 Behzad Shams.
        </p>
        <p>
          The current project is source-available under the{" "}
          <a
            href={`${SITE_GITHUB_URL}/blob/main/LICENSE`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            AIBoard Community Source License
          </a>
          . You can inspect the code and submit improvements upstream, but
          independent distribution and hosted forks need written permission.
          Earlier AGPL-licensed copies retain their original rights.
        </p>
        <p>
          Contributions follow the{" "}
          <a
            href={`${SITE_GITHUB_URL}/blob/main/CONTRIBUTOR_LICENSE_AGREEMENT.md`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            contributor agreement
          </a>
          . AIBoard branding is governed by the{" "}
          <a
            href={`${SITE_GITHUB_URL}/blob/main/TRADEMARKS.md`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            trademark policy
          </a>
          .
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
        <h2 className="font-display text-xl font-semibold">FAQ</h2>
        <dl className="space-y-4">
          {FAQ.map((entry) => (
            <div key={entry.question}>
              <dt className="font-semibold">{entry.question}</dt>
              <dd className="text-muted-foreground">{entry.answer}</dd>
            </div>
          ))}
        </dl>
      </section>

      <p>
        <Link href="/" className="underline hover:text-foreground">
          Open the workspace
        </Link>
      </p>
    </article>
  );
}
