import Link from "next/link";
import type { ReactNode } from "react";
import { LegalDocument, legalLink, type LegalSection } from "@/components/LegalDocument";
import {
  PADDLE_PRIVACY_URL,
  SITE_CONTACT_EMAIL,
  SITE_LEGAL_ADDRESS,
  SITE_LEGAL_NAME,
  SITE_NAME,
  pageMetadata,
} from "@/lib/site";

export const metadata = pageMetadata({
  title: "Privacy Policy",
  description:
    "What AI Board, the AI Board Runner and AIBoard Remote collect, why, who processes it, how long it is kept, and your rights.",
  path: "/privacy",
});

const mail = (
  <a href={`mailto:${SITE_CONTACT_EMAIL}`} className={legalLink}>
    {SITE_CONTACT_EMAIL}
  </a>
);

const external = (href: string, label: string) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className={legalLink}>
    {label}
  </a>
);

// A stacked list rather than a table: it stays readable at phone width.
const PROCESSORS: { name: string; where: string; role: ReactNode }[] = [
  {
    name: "Paddle.com Market Limited",
    where: "UK and worldwide",
    role: (
      <>
        Our reseller and Merchant of Record: checkout, payments, tax, invoices
        and refunds. Paddle is an independent controller of your payment data
        under its {external(PADDLE_PRIVACY_URL, "Privacy Notice")}.
      </>
    ),
  },
  {
    name: "Cloudflare, Inc.",
    where: "Global network",
    role: "Network, TLS and attack protection in front of aiboard.me and mcp.aiboard.me. Sees request data and, for Remote, traffic in transit.",
  },
  {
    name: "Akamai Technologies (Linode)",
    where: "London, UK",
    role: "The virtual server that hosts the website and the Remote relay, its database and backups.",
  },
  {
    name: "Google and GitHub",
    where: "USA and worldwide",
    role: "Sign-in to Remote, if you choose them. They tell us who you are; we don't give them your Remote data.",
  },
  {
    name: "AI providers and AI apps you choose",
    where: "Varies",
    role: "OpenAI, Anthropic, Google and others receive what you send them from the app or Runner with your own keys or accounts; AI apps you connect to Remote receive your tool results. They act under your own agreement with them, not on our behalf.",
  },
];

const SECTIONS: LegalSection[] = [
  {
    id: "controller",
    title: "Who is responsible for your data",
    body: (
      <>
        <p>
          The controller of personal data described here is{" "}
          <strong>{SITE_LEGAL_NAME}</strong>, an individual trading as
          &ldquo;{SITE_NAME}&rdquo; (&ldquo;we&rdquo;, &ldquo;us&rdquo;).
          Postal address: {SITE_LEGAL_ADDRESS}. For any privacy question or
          request, email {mail}.
        </p>
        <p>
          This policy covers the {SITE_NAME} app at aiboard.me, the{" "}
          {SITE_NAME} Runner you install on your computer, and the AIBoard
          Remote service at mcp.aiboard.me. It applies wherever you are; where
          a law such as the EU or UK GDPR or the UAE Personal Data Protection
          Law gives you extra rights, you have them too.
        </p>
      </>
    ),
  },
  {
    id: "app",
    title: "The AI Board app: your data stays with you",
    body: (
      <>
        <p>
          The {SITE_NAME} app has no backend. It is a static website that runs
          entirely in your browser:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            Your provider API keys, chats, builds, settings and attachments are
            stored in your browser (IndexedDB and local storage) or in a folder
            on your computer that you choose, optionally encrypted with your
            passphrase. We never receive them.
          </li>
          <li>
            When you chat or build, your browser sends your prompts and any
            files you include <strong>directly</strong> to the AI providers you
            selected (for example OpenAI, Anthropic, Google or OpenRouter), or
            to a local model. Those providers handle that data under their own
            privacy policies.
          </li>
          <li>
            If you connect a ChatGPT or GitHub Copilot account, a small runner
            on your computer handles that login, and it stays in a file on
            your computer.
          </li>
          <li>
            The site has no analytics, advertising or tracking scripts, and
            sets no cookies. Fonts are served from aiboard.me itself.
          </li>
        </ul>
        <p>
          Like any website, our web server and Cloudflare (see{" "}
          <a href="#processors" className={legalLink}>
            Who processes data for us
          </a>
          ) see technical request data when you load the site, such as your IP
          address, browser type and the pages requested. This is used only to
          deliver the site and protect it from abuse.
        </p>
      </>
    ),
  },
  {
    id: "runner",
    title: "The AI Board Runner",
    body: (
      <>
        <p>
          The Runner runs on your computer and keeps its data there: project
          files, build history, logs and encrypted provider settings. It sends
          no telemetry or usage statistics to us. It connects to the internet
          only:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>to the AI providers you configure, with your own keys or accounts;</li>
          <li>
            to aiboard.me when you install or update it, to download the
            signed release;
          </li>
          <li>
            to mcp.aiboard.me, only if you turn on AIBoard Remote (described
            below).
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "remote",
    title: "AIBoard Remote: what we collect",
    body: (
      <>
        <p>
          AIBoard Remote is the one part of {SITE_NAME} that runs on our
          servers. It needs a small amount of personal data to work:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Account.</strong> When you sign in with Google we receive
            your Google account id, email address and whether it is verified.
            With GitHub we receive your GitHub user id and email address. We
            don&apos;t keep your name, profile picture or any Google or GitHub
            access token.
          </li>
          <li>
            <strong>Sign-in sessions.</strong> We store only a scrambled (hashed)
            form of your session and security tokens, with their creation and
            expiry times.
          </li>
          <li>
            <strong>Devices.</strong> For each computer you pair: a device id,
            its public key, a name (by default your computer&apos;s hostname;
            you can rename it), when it was added, last seen and revoked, and
            the Runner version and operating system while it is connected.
          </li>
          <li>
            <strong>Machine hint.</strong> To share the free allowance per
            computer, the Runner may send a one-way keyed hash (HMAC) of your
            operating system&apos;s machine id. The machine id itself never
            leaves your computer and cannot be recovered from the hash. We use
            it only to count free usage per computer and to spot free-plan
            abuse; we never use it to block paying customers.
          </li>
          <li>
            <strong>Pairing.</strong> While you pair a computer, we keep the IP
            address it connected from, to warn you if the approval comes from a
            different network. Pairing records are deleted after about 20
            minutes.
          </li>
          <li>
            <strong>Connected AI apps.</strong> For each AI app you authorise
            (such as ChatGPT or Claude): its name and website, when you
            authorised it and when it last used Remote, plus hashed access
            tokens. We don&apos;t share your email or identity with these apps.
          </li>
          <li>
            <strong>Usage.</strong> A count of tool calls per account, device
            and month, and for recent calls a request id and timestamp. We
            record which tool was called, the result status and how long it
            took in our service logs.
          </li>
          <li>
            <strong>Billing</strong> (paid plans only). Paddle&apos;s customer
            and subscription ids, your plan, the subscription status and
            renewal dates, and records of refunds or chargebacks. Paddle holds
            your name, email, address and payment details; we never see your
            card number.
          </li>
          <li>
            <strong>Messages you send us.</strong> If you email us, we keep the
            conversation so we can help you.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "tool-calls",
    title: "The content of your tool calls",
    body: (
      <>
        <p>
          When an AI app uses your computer through Remote, the request (for
          example &ldquo;read this file&rdquo;) and the result (the file&apos;s
          contents, a command&apos;s output, a screenshot) pass through our
          relay. Please understand how that works:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            Traffic is encrypted in transit (HTTPS / TLS). It is{" "}
            <strong>not end-to-end encrypted</strong>: our relay, and Cloudflare
            in front of it, process the content in memory to deliver it.
          </li>
          <li>
            We <strong>do not store</strong> the content of tool calls or
            results, do not log it, and do not look at it, sell it or use it to
            train AI models. It exists on our servers only for as long as it
            takes to pass it on.
          </li>
          <li>
            The AI app you connected receives the results and handles them
            under its own privacy policy.
          </li>
        </ul>
        <p>
          Only expose files and commands you are comfortable sending through
          this path. The Runner lets you restrict Remote to one folder, make it
          read-only, or turn off shell commands.
        </p>
      </>
    ),
  },
  {
    id: "purposes",
    title: "Why we use it, and our legal basis",
    body: (
      <ul className="list-disc space-y-2 pl-6">
        <li>
          <strong>To provide Remote</strong>: signing you in, pairing devices,
          routing tool calls, counting usage and applying your plan. Legal
          basis: performing our contract with you.
        </li>
        <li>
          <strong>To keep the service secure and fair</strong>: rate limits,
          preventing free-plan abuse with the machine hint, investigating
          misuse, and short-lived server logs. Legal basis: our legitimate
          interest in running a safe, reliable service.
        </li>
        <li>
          <strong>To handle payments, tax and accounting</strong>, together
          with Paddle. Legal basis: contract, and our legal obligations.
        </li>
        <li>
          <strong>To answer you</strong> when you contact us, and to tell you
          about important changes to the service or these policies. Legal
          basis: contract and legitimate interest.
        </li>
      </ul>
    ),
  },
  {
    id: "processors",
    title: "Who processes data for us",
    body: (
      <>
        <p>
          We do not sell your personal data or share it for advertising. We
          use these providers to run the Services:
        </p>
        <dl className="divide-y rounded-lg border text-sm">
          {PROCESSORS.map((processor) => (
            <div key={processor.name} className="space-y-1 p-3 sm:p-4">
              <dt className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-semibold">{processor.name}</span>
                <span className="text-xs text-muted-foreground">{processor.where}</span>
              </dt>
              <dd className="text-muted-foreground">{processor.role}</dd>
            </div>
          ))}
        </dl>
        <p>
          We may also disclose data if the law requires it, or to protect our
          rights or someone&apos;s safety.
        </p>
      </>
    ),
  },
  {
    id: "transfers",
    title: "International transfers",
    body: (
      <p>
        Our servers are in the United Kingdom, we are based in the United Arab
        Emirates, and our providers operate worldwide, so your data may be
        processed outside your country. Where the law requires it, we rely on
        appropriate safeguards such as adequacy decisions and the standard
        contractual clauses offered by our providers.
      </p>
    ),
  },
  {
    id: "retention",
    title: "How long we keep it",
    body: (
      <>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Account, devices, machine hint and monthly usage totals</strong>:
            for as long as your account exists. Revoked devices stay listed so
            their keys can never be reused.
          </li>
          <li>
            <strong>Sign-in sessions</strong>: expire after 30 days without use
            and at most 90 days after sign-in.
          </li>
          <li>
            <strong>Connected AI apps</strong>: until you revoke them, or 90
            days after last use. Access tokens last one hour; refresh tokens at
            most 90 days.
          </li>
          <li>
            <strong>Per-call usage records</strong>: the current and previous
            month only.
          </li>
          <li>
            <strong>Pairing records with IP address</strong>: about 20 minutes.
          </li>
          <li>
            <strong>Server and web logs</strong> (which may include IP
            addresses at the web-server level, but never tool-call content):
            up to 30 days.
          </li>
          <li>
            <strong>Billing records</strong>: for as long as your account
            exists and then as long as tax and accounting law requires.
            Paddle keeps its own records under its policy.
          </li>
          <li>
            <strong>Backups</strong>: database backups are kept for up to 90
            days.
          </li>
        </ul>
        <p>
          To delete your Remote account, email {mail} from the address on the
          account. We will delete your account data within 30 days, except
          billing records we must keep by law. Copies in backups disappear as
          those backups expire.
        </p>
      </>
    ),
  },
  {
    id: "cookies",
    title: "Cookies and local storage",
    body: (
      <>
        <p>
          <strong>aiboard.me</strong> sets no cookies. It uses your
          browser&apos;s local storage and IndexedDB to keep your own settings
          and data on your device.
        </p>
        <p>
          <strong>mcp.aiboard.me</strong> uses three strictly necessary
          cookies: one keeps you signed in (up to 90 days), one protects forms
          against cross-site request forgery, and one secures the sign-in
          redirect (10 minutes). On the checkout page, Paddle&apos;s payment
          form loads from Paddle and may set its own cookies to process the
          payment and prevent fraud. We use no advertising or analytics
          cookies.
        </p>
      </>
    ),
  },
  {
    id: "security",
    title: "Security",
    body: (
      <p>
        We protect data with encryption in transit, hashed tokens, signed
        device keys, least-privilege server access and restricted backups. No
        system is perfectly secure; if a breach affects your personal data, we
        will tell you and the authorities as the law requires.
      </p>
    ),
  },
  {
    id: "rights",
    title: "Your rights",
    body: (
      <>
        <p>
          Depending on where you live, you can ask us to access, correct,
          delete or export your personal data, to restrict or object to how we
          use it, and to withdraw consent where we rely on it. Email {mail}; we
          will answer within one month and may need to confirm the request
          comes from the account&apos;s owner. You can also revoke devices and
          connected apps yourself in the Remote dashboard.
        </p>
        <p>
          You have the right to complain to a data protection authority, for
          example the one in the country where you live. We would appreciate
          the chance to help first.
        </p>
      </>
    ),
  },
  {
    id: "children",
    title: "Children",
    body: (
      <p>
        The Services are not for children under 13 (or the higher minimum age
        in your country). We don&apos;t knowingly collect their data; if you
        believe a child has given us data, email us and we will delete it.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: (
      <p>
        If we change this policy we will post the new version here with a new
        date, and tell Remote users about material changes by email or in the
        dashboard before they take effect. See also our{" "}
        <Link href="/terms" className={legalLink}>
          Terms of Service
        </Link>
        .
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalDocument
      title="Privacy Policy"
      sections={SECTIONS}
      summary={
        <ul className="list-disc space-y-2 pl-6">
          <li>
            The {SITE_NAME} app and Runner keep your keys, chats and files on
            your own device. They talk to AI providers directly, not through
            us.
          </li>
          <li>
            AIBoard Remote stores only what it needs: your sign-in email and
            id, your devices, usage counts and your plan.
          </li>
          <li>
            Tool calls pass through our relay but are not stored or logged.
            They are encrypted in transit but not end to end.
          </li>
          <li>
            Paddle handles payments; we never see your card. No ads, no
            analytics, no selling data.
          </li>
        </ul>
      }
    />
  );
}
