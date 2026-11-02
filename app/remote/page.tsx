import Link from "next/link";
import {
  ArrowRight,
  FolderGit2,
  Laptop,
  Lock,
  MessagesSquare,
  Plug,
  Power,
  ScrollText,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { RemotePricing } from "@/components/remote/RemotePricing";
import { Button } from "@/components/ui/button";
import { RUNNER_REMOTE_COMMAND } from "@/lib/runner-install";
import { SITE_CONTACT_EMAIL, SITE_REMOTE_URL, pageMetadata } from "@/lib/site";

export const metadata = pageMetadata({
  title: "AI Board Remote",
  description:
    "AI Board Remote lets ChatGPT, Claude, and other MCP apps work on files and Git on your own computer through the AI Board Runner. Free, Pro, and Max plans.",
  path: "/remote",
});

// Public on purpose, even while SITE_REMOTE_ENABLED keeps Remote out of the
// nav: payment-provider review needs the product and its prices visible
// without signing in. Prices live in components/remote/RemotePricing.tsx.
const BILLING_URL = `${SITE_REMOTE_URL}billing`;

const FEATURES = [
  {
    icon: FolderGit2,
    title: "Real files, real Git",
    body: "Your AI app lists, reads, searches, and edits files, and checks Git status, diffs, and history in the folders you choose.",
  },
  {
    icon: MessagesSquare,
    title: "The AI apps you already use",
    body: "Add AI Board Remote as an app or connector in ChatGPT, Claude, or any other MCP client. No new chat app to learn.",
  },
  {
    icon: ShieldCheck,
    title: "Only your own computers",
    body: "A computer joins your account only after you approve a one-time code while signed in. Nobody else's machines, ever.",
  },
  {
    icon: Lock,
    title: "As much access as you allow",
    body: "Limit the Runner to one folder, make it read-only, or turn off shell commands.",
  },
  {
    icon: ScrollText,
    title: "Every action on record",
    body: "Each tool call is written to an audit log on your computer, so you can see exactly what your AI did.",
  },
  {
    icon: Power,
    title: "Off in one click",
    body: "Revoke a computer or an AI app from the dashboard at any time, or press Ctrl+C in the Runner to disconnect.",
  },
];

const FAQ = [
  {
    question: "What counts as a tool call?",
    answer:
      "Every tool call your AI app makes through AI Board Remote counts as one, including listing computers and checking job status. Calls refused before they run, such as ones with invalid arguments, do not count.",
  },
  {
    question: "What happens when I reach my limit?",
    answer:
      "New tool calls are refused with a clear message until your allowance resets at the start of the next month (UTC), or until you upgrade. Nothing on your computers is changed or deleted.",
  },
  {
    question: "Can I switch plans or cancel?",
    answer:
      "Yes, from Plan & billing in the dashboard. Upgrades start right away and are prorated. If you cancel, you keep your plan until the end of the period you paid for, then move to Free.",
  },
  {
    question: "Can I get a refund?",
    answer:
      "Yes. Every payment is covered by a 14-day money-back guarantee, no questions asked. See the refund policy for how to ask.",
  },
  {
    question: "Is it a VPN or remote desktop?",
    answer:
      "No. It carries a fixed set of named tool calls between your AI app and the AI Board Runner on your computer. It does not route your internet traffic or share your screen.",
  },
  {
    question: "Who handles payment?",
    answer:
      "Paddle.com, our online reseller and Merchant of Record. Paddle processes the payment, issues the invoice, and handles sales tax.",
  },
];

const link = "underline underline-offset-4 hover:text-foreground";

function FlowTile({ icon: Icon, title, detail }: { icon: typeof Laptop; title: string; detail: string }) {
  return (
    <div className="glass flex flex-1 items-center gap-3 rounded-2xl border px-4 py-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="text-left">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
    </div>
  );
}

function SectionHeading({ eyebrow, title, body }: { eyebrow: string; title: string; body?: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-sm font-semibold uppercase tracking-wider text-primary">{eyebrow}</p>
      <h2 className="mt-2 font-display text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h2>
      {body && <p className="mt-3 text-muted-foreground">{body}</p>}
    </div>
  );
}

export default function RemotePage() {
  return (
    <div className="mx-auto max-w-6xl space-y-24 pb-8 sm:space-y-28">
      <section className="pt-6 text-center sm:pt-12">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-xs font-semibold text-accent-foreground">
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          Private beta
        </span>
        <h1 className="mx-auto mt-5 max-w-3xl font-display text-4xl font-semibold tracking-tight sm:text-6xl">
          Let your AI assistant work on <span className="text-primary">your own computer</span>
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">
          AI Board Remote connects ChatGPT, Claude, and other MCP apps to the projects on your machine, so they can
          read, search, and edit real files and check Git, with you in control of every folder.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button asChild size="lg">
            <a href={SITE_REMOTE_URL}>
              Start free
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </Button>
          <Button asChild size="lg" variant="outline">
            <a href="#pricing">See pricing</a>
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">10,000 tool calls a month free. No card needed.</p>

        <div className="mx-auto mt-14 flex max-w-4xl flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-3">
          <FlowTile icon={MessagesSquare} title="Your AI app" detail="ChatGPT, Claude, any MCP client" />
          <ArrowRight className="mx-auto h-5 w-5 shrink-0 rotate-90 text-muted-foreground sm:rotate-0" aria-hidden="true" />
          <FlowTile icon={Plug} title="AI Board Remote" detail="Signed in, paired, audited" />
          <ArrowRight className="mx-auto h-5 w-5 shrink-0 rotate-90 text-muted-foreground sm:rotate-0" aria-hidden="true" />
          <FlowTile icon={Laptop} title="Your computer" detail="AI Board Runner, your folders" />
        </div>
      </section>

      <section className="space-y-10">
        <SectionHeading
          eyebrow="Why Remote"
          title="Powerful for your AI, safe for your machine"
          body="Cloud assistants are great at code, but they cannot see your projects. Remote gives them a narrow, audited way in that you control."
        />
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="glass rounded-2xl border p-6">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <h3 className="mt-4 font-semibold">{title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-10">
        <SectionHeading eyebrow="How it works" title="Connected in three steps" />
        <ol className="grid gap-5 md:grid-cols-3">
          <li className="glass rounded-2xl border p-6">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
              1
            </span>
            <h3 className="mt-4 font-semibold">Start the Runner</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Install the free{" "}
              <Link href="/runner-guide" className={link}>
                AI Board Runner
              </Link>{" "}
              and run it in a project folder:
            </p>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-muted px-3 py-2 text-sm">{RUNNER_REMOTE_COMMAND}</pre>
          </li>
          <li className="glass rounded-2xl border p-6">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
              2
            </span>
            <h3 className="mt-4 font-semibold">Pair this computer</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Sign in at{" "}
              <a href={SITE_REMOTE_URL} className={link}>
                mcp.aiboard.me
              </a>{" "}
              with Google or GitHub, enter the one-time code the Runner shows, and approve the computer.
            </p>
          </li>
          <li className="glass rounded-2xl border p-6">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
              3
            </span>
            <h3 className="mt-4 font-semibold">Connect your AI app</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Add AI Board Remote as an app or connector in ChatGPT, Claude, or another MCP client, and ask it to
              work on your project.
            </p>
          </li>
        </ol>
      </section>

      <section id="pricing" className="scroll-mt-24 space-y-10">
        <SectionHeading
          eyebrow="Pricing"
          title="Start free. Upgrade when your AI does more."
          body="Every plan includes every tool on every computer you pair. Plans differ only in how many tool calls you get each month."
        />
        <RemotePricing signInUrl={SITE_REMOTE_URL} billingUrl={BILLING_URL} />
        <div className="mx-auto max-w-3xl space-y-2 text-center text-sm text-muted-foreground">
          <p>
            <span className="font-semibold text-foreground">14-day money-back guarantee</span> on every payment.
            Prices in US dollars; sales tax is added at checkout where it applies. Paid plans renew automatically
            until you cancel.
          </p>
          <p>
            Our order process is conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record
            for all our orders and handles payments, invoices, and sales tax.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-3xl space-y-10">
        <SectionHeading eyebrow="FAQ" title="Questions, answered" />
        <div className="glass divide-y rounded-2xl border">
          {FAQ.map((entry) => (
            <details key={entry.question} className="group px-6 py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold [&::-webkit-details-marker]:hidden">
                {entry.question}
                <span className="text-xl leading-none text-muted-foreground transition-transform group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="mt-3 text-sm text-muted-foreground">{entry.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="glass rounded-3xl border px-6 py-12 text-center sm:px-12">
        <h2 className="font-display text-3xl font-semibold tracking-tight">Give your AI a real workspace</h2>
        <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
          Start on the Free plan in a couple of minutes. Upgrade only when you need more.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Button asChild size="lg">
            <a href={SITE_REMOTE_URL}>
              Start free
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/runner-guide">Read the Runner guide</Link>
          </Button>
        </div>
        <p className="mt-8 text-sm text-muted-foreground">
          <Link href="/terms" className={link}>
            Terms
          </Link>
          {" · "}
          <Link href="/privacy" className={link}>
            Privacy
          </Link>
          {" · "}
          <Link href="/refunds" className={link}>
            Refunds
          </Link>
          {" · "}
          <a href={`mailto:${SITE_CONTACT_EMAIL}`} className={link}>
            {SITE_CONTACT_EMAIL}
          </a>
        </p>
      </section>
    </div>
  );
}
