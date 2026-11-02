import Link from "next/link";
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
// without signing in. Keep these prices in step with the Paddle catalog.
const PLANS = [
  {
    name: "Free",
    calls: "10,000 tool calls / month",
    prices: ["$0"],
  },
  {
    name: "Pro",
    calls: "50,000 tool calls / month",
    prices: ["$10 / month", "$54 / 6 months (10% off)", "$96 / year (20% off)"],
  },
  {
    name: "Max",
    calls: "No monthly cap (fair-use rate limits apply)",
    prices: ["$20 / month", "$108 / 6 months (10% off)", "$192 / year (20% off)"],
  },
];

const link = "underline hover:text-foreground";

export default function RemotePage() {
  return (
    <article className="mx-auto max-w-3xl space-y-10">
      <header>
        <p className="text-sm font-medium text-muted-foreground">Private beta</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight">AI Board Remote</h1>
        <p className="mt-2 text-muted-foreground">
          Let ChatGPT, Claude, or any other MCP app work on your own computer: read, search, and edit files and
          check Git in the folders you choose.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">How it works</h2>
        <ol className="list-decimal space-y-2 pl-6">
          <li>
            Install the free{" "}
            <Link href="/runner-guide" className={link}>
              AI Board Runner
            </Link>{" "}
            and run <code>{RUNNER_REMOTE_COMMAND}</code> in a project folder.
          </li>
          <li>
            Sign in at{" "}
            <a href={SITE_REMOTE_URL} className={link}>
              mcp.aiboard.me
            </a>{" "}
            with Google or GitHub, enter the one-time code the Runner shows, and approve the computer.
          </li>
          <li>Add AI Board Remote as an app or connector in ChatGPT, Claude, or another MCP client.</li>
        </ol>
        <p>
          Your AI app can then list, read, search, and write files, and see Git status, diffs, and history, on the
          computers you paired. You can limit the Runner to one folder or make it read-only.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">You stay in control</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>Only computers you paired yourself, with a code you approved while signed in.</li>
          <li>Every action is recorded in an audit log on your computer.</li>
          <li>Revoke a computer or a connected AI app from the dashboard at any time; Ctrl+C in the Runner disconnects.</li>
          <li>It carries named tool calls only. It is not a VPN and does not route your internet traffic.</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Plans</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {PLANS.map((plan) => (
            <div key={plan.name} className="rounded-lg border bg-muted p-4">
              <h3 className="font-semibold">{plan.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{plan.calls}</p>
              <ul className="mt-3 space-y-1 text-sm">
                {plan.prices.map((price) => (
                  <li key={price}>{price}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          Prices in US dollars; sales tax is added at checkout where it applies. Every tool call your AI app makes
          through AI Board Remote counts as one. Paid plans renew automatically until you cancel, and you keep your
          plan until the end of the period you paid for. Subscribe and manage your plan under Plan &amp; billing on{" "}
          <a href={SITE_REMOTE_URL} className={link}>
            mcp.aiboard.me
          </a>
          .
        </p>
        <p className="text-sm text-muted-foreground">
          Our order process is conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record for
          all our orders and handles payments, invoices, and sales tax.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Policies and contact</h2>
        <p>
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
    </article>
  );
}
