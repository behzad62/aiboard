import Link from "next/link";
import { LegalDocument, legalLink, type LegalSection } from "@/components/LegalDocument";
import {
  SITE_CONTACT_EMAIL,
  SITE_GITHUB_URL,
  SITE_LEGAL_ADDRESS,
  SITE_LEGAL_NAME,
  SITE_NAME,
  pageMetadata,
} from "@/lib/site";

export const metadata = pageMetadata({
  title: "Terms of Service",
  description:
    "The terms for using AI Board, the AI Board Runner and AIBoard Remote, including plans, limits, payments, and your responsibilities.",
  path: "/terms",
});

const mail = (
  <a href={`mailto:${SITE_CONTACT_EMAIL}`} className={legalLink}>
    {SITE_CONTACT_EMAIL}
  </a>
);

const SECTIONS: LegalSection[] = [
  {
    id: "who-we-are",
    title: "Who we are and what these terms cover",
    body: (
      <>
        <p>
          {SITE_NAME} is run by <strong>{SITE_LEGAL_NAME}</strong>, an
          individual trading as &ldquo;{SITE_NAME}&rdquo; (&ldquo;we&rdquo;,
          &ldquo;us&rdquo;). Postal address: {SITE_LEGAL_ADDRESS}. Email:{" "}
          {mail}.
        </p>
        <p>These terms apply to three things we provide (together, the &ldquo;Services&rdquo;):</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>The {SITE_NAME} app</strong> at aiboard.me: a web app that
            runs in your browser and lets you chat and build with AI models
            using your own provider keys or accounts. It is free.
          </li>
          <li>
            <strong>The {SITE_NAME} Runner</strong> (the <code>aiboard</code>{" "}
            program): software you download and run on your own computer. It
            is free.
          </li>
          <li>
            <strong>AIBoard Remote</strong> at mcp.aiboard.me: an online
            service that lets AI apps you connect, such as ChatGPT or Claude,
            use tools on your computer through your Runner. It has a free plan
            and paid plans.
          </li>
        </ul>
        <p>
          By using the Services you agree to these terms, our{" "}
          <Link href="/privacy" className={legalLink}>
            Privacy Policy
          </Link>{" "}
          and, if you pay for a plan, our{" "}
          <Link href="/refunds" className={legalLink}>
            Refund Policy
          </Link>
          . If you don&apos;t agree, please don&apos;t use the Services.
        </p>
      </>
    ),
  },
  {
    id: "eligibility",
    title: "Who can use the Services",
    body: (
      <>
        <p>
          You must be at least 13 years old, or older if the law where you
          live sets a higher age for using online services without a
          parent&apos;s consent (in some EU countries this is up to 16). If you
          are under 18, you need a parent or guardian&apos;s permission to buy
          a paid plan, and they agree to these terms on your behalf.
        </p>
        <p>
          If you use the Services for a company or other organisation, you
          confirm you are allowed to accept these terms for it.
        </p>
      </>
    ),
  },
  {
    id: "accounts",
    title: "Your AIBoard Remote account",
    body: (
      <>
        <p>
          You sign in to AIBoard Remote with Google or GitHub. Each sign-in
          identity is its own account: signing in with GitHub after using
          Google creates a second account, even if the email is the same.
        </p>
        <p>
          You are responsible for activity on your account and on the devices
          you pair with it. Keep your Google or GitHub login secure, and revoke
          a device or connected app from the Remote dashboard if you think it
          has been misused. Tell us at {mail} if you suspect unauthorised use.
        </p>
        <p>
          The {SITE_NAME} app and the Runner don&apos;t need an account. Your
          settings and keys stay on your computer, in the AIBoard home folder,
          and your sessions stay in your browser or in a folder you pick.
        </p>
      </>
    ),
  },
  {
    id: "your-computer",
    title: "Your computer, your responsibility",
    body: (
      <>
        <p>
          The Runner acts on your computer with the permissions of your
          operating-system user account. When you connect an AI app through
          AIBoard Remote, or run a build in the {SITE_NAME} app, the AI can
          read, create, change and delete files, and run commands, within the
          limits you set. Examples of those limits are which folders the Runner
          may use, read-only mode, and turning shell commands off.
        </p>
        <p>You are responsible for:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            choosing which computers, folders and permissions you expose, and
            which AI apps you connect;
          </li>
          <li>
            what those AI apps do with the access you give them. AI models make
            mistakes and can be misled by content they read, so review
            important changes and keep backups;
          </li>
          <li>
            only connecting computers and data you own or are authorised to
            use.
          </li>
        </ul>
        <p>
          We provide the connection, not the AI. We are not responsible for
          what an AI app does with access you granted, or for loss of data on
          your computer that results from it.
        </p>
      </>
    ),
  },
  {
    id: "third-parties",
    title: "AI providers and other third parties",
    body: (
      <>
        <p>
          You choose which AI providers to use (for example OpenAI, Anthropic,
          Google, OpenRouter or a local model) and which AI apps to connect
          (for example ChatGPT or Claude). Your use of them is governed by
          their own terms and privacy policies, and you pay them directly. We
          don&apos;t resell access to any AI provider and we are not
          responsible for their services, prices, outages or outputs.
        </p>
      </>
    ),
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    body: (
      <>
        <p>You agree not to use the Services to:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>break the law, or help anyone else break it;</li>
          <li>
            access, control or collect data from a computer or account you are
            not authorised to use;
          </li>
          <li>create, spread or run malware, or attack other systems;</li>
          <li>
            infringe anyone&apos;s intellectual property or privacy, or harass,
            defraud or harm others;
          </li>
          <li>
            use AIBoard Remote as a general-purpose network proxy, VPN or
            tunnel for traffic unrelated to AI tool calls on your own computer;
          </li>
          <li>
            get around plan limits, for example by opening several free
            accounts for the same computer, or resell or share access to the
            Services without our written permission;
          </li>
          <li>
            overload, probe or interfere with our servers, or try to access
            other users&apos; accounts or data. Responsible security reports
            to {mail} are welcome.
          </li>
        </ul>
        <p>
          We may refuse, limit or stop traffic that breaks these rules (see{" "}
          <a href="#termination" className={legalLink}>
            Suspension and termination
          </a>
          ).
        </p>
      </>
    ),
  },
  {
    id: "beta",
    title: "AIBoard Remote is in beta",
    body: (
      <>
        <p>
          AIBoard Remote is a new service in beta. We work to keep it fast and
          available, but we don&apos;t offer a service-level agreement or
          guaranteed uptime. Features, tools and limits may change, and the
          service may be interrupted for maintenance, updates or problems
          outside our control. During the beta, access may be by invitation
          only.
        </p>
        <p>
          If we make a change that materially reduces a paid plan you have
          already paid for, we will tell you in advance and you may cancel and
          ask for a refund of the unused part of that period.
        </p>
      </>
    ),
  },
  {
    id: "plans",
    title: "Plans, limits and quotas",
    body: (
      <>
        <p>
          AIBoard Remote counts <strong>tool calls</strong>: each request an AI
          app makes through Remote, such as reading a file, listing your
          devices or running a command. Requests we reject before they reach
          your computer for being malformed, unauthorised or over a limit are
          not counted. Monthly allowances reset at the start of each calendar
          month (UTC).
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-2 pr-4 font-semibold">Plan</th>
                <th className="py-2 pr-4 font-semibold">Tool calls per month</th>
                <th className="py-2 font-semibold">Price (USD)</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b">
                <td className="py-2 pr-4">Free</td>
                <td className="py-2 pr-4">
                  10,000, shared by all free accounts paired with the same
                  computer
                </td>
                <td className="py-2">$0</td>
              </tr>
              <tr className="border-b">
                <td className="py-2 pr-4">Pro</td>
                <td className="py-2 pr-4">50,000</td>
                <td className="py-2">
                  $10 / month, $54 / 6 months or $96 / year
                </td>
              </tr>
              <tr>
                <td className="py-2 pr-4">Max</td>
                <td className="py-2 pr-4">No monthly cap</td>
                <td className="py-2">
                  $20 / month, $108 / 6 months or $192 / year
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          The prices shown at checkout are the ones that apply, and taxes may
          be added depending on where you live. Paid plans may not be on sale
          yet while Remote is in beta.
        </p>
        <p>
          All plans, including Max, have fair-use rate limits that protect the
          service. Today these are 120 tool calls per minute and 8 at the same
          time per account, plus limits on request size and duration. When you
          reach a monthly allowance or a rate limit, further tool calls are
          refused until the limit resets or, once paid plans are on sale, you
          upgrade. Nothing on your computer is deleted. We may change limits; we will give paying
          customers notice before reducing their plan&apos;s allowance.
        </p>
      </>
    ),
  },
  {
    id: "payments",
    title: "Payments, renewals and cancellation",
    body: (
      <>
        <p>
          <strong>Paid plans are not on sale yet.</strong> Before they go on
          sale, we will update these terms to name our payment provider. It
          will take your payment, charge any sales tax or VAT, and issue your
          invoices, and it may sell the plan to you itself as our reseller,
          under its own buyer terms. We never see your card details. The rules
          below apply once paid plans are on sale.
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Renewal.</strong> Paid plans renew automatically at the end
            of each billing period (1 month, 6 months or 1 year) until you
            cancel.
          </li>
          <li>
            <strong>Cancelling.</strong> You can cancel at any time from the
            Remote billing page. Cancelling stops the next
            renewal; you keep your plan until the end of the period you paid
            for, then move to Free.
          </li>
          <li>
            <strong>Changing plans.</strong> Upgrading, or changing your
            billing period, takes effect straight away and the prorated difference
            is charged or credited. Moving to a lower plan takes effect
            at the end of the period you have paid for.
          </li>
          <li>
            <strong>Failed payments.</strong> If a renewal payment fails, you
            keep your plan while payment is retried. If the subscription ends up
            paused or cancelled, your account moves to Free.
          </li>
          <li>
            <strong>Chargebacks.</strong> If a payment is disputed with your
            bank, the paid plan is suspended until the dispute is resolved.
            Please contact us first; we would rather fix the problem.
          </li>
          <li>
            <strong>Nothing is deleted.</strong> Moving to a lower plan or to
            Free never deletes your paired devices or your settings.
          </li>
        </ul>
        <p>
          Refunds are covered by our{" "}
          <Link href="/refunds" className={legalLink}>
            Refund Policy
          </Link>
          : you can get a full refund within 14 days of any payment.
        </p>
      </>
    ),
  },
  {
    id: "software",
    title: "Software licence and your content",
    body: (
      <>
        <p>
          The {SITE_NAME} app and Runner are source-available under the{" "}
          <a
            href={`${SITE_GITHUB_URL}/blob/main/LICENSE`}
            target="_blank"
            rel="noopener noreferrer"
            className={legalLink}
          >
            AIBoard Community Source License
          </a>
          , which sets out what you may do with the code. The {SITE_NAME} and
          AIBoard names and logos are ours. Everything else about the Services,
          including the AIBoard Remote service, belongs to us and these terms
          give you only the right to use it.
        </p>
        <p>
          Your files, prompts and outputs are yours. We claim no ownership of
          them and do not use them to train AI models. AIBoard Remote passes
          tool calls between your AI app and your computer but does not store
          their contents; see the{" "}
          <Link href="/privacy" className={legalLink}>
            Privacy Policy
          </Link>
          .
        </p>
        <p>
          If you send us feedback or suggestions, we may use them without any
          obligation to you.
        </p>
      </>
    ),
  },
  {
    id: "termination",
    title: "Suspension and termination",
    body: (
      <>
        <p>
          You can stop using the Services at any time. To delete your AIBoard
          Remote account, cancel any paid plan and email {mail} from the
          address on the account; we will delete it as described in the{" "}
          <Link href="/privacy#retention" className={legalLink}>
            Privacy Policy
          </Link>
          .
        </p>
        <p>
          We may suspend or close an account, or block a device or connected
          app, if you seriously or repeatedly break these terms, if we must do
          so by law, or to protect the service, other users or you (for
          example if an account appears compromised). Where reasonable, we
          will warn you first and explain why. If we close a paid account
          without a breach on your part, we will refund the unused part of
          your current period.
        </p>
        <p>
          If we decide to discontinue AIBoard Remote, we will give at least 30
          days&apos; notice and refund any prepaid time you cannot use.
        </p>
      </>
    ),
  },
  {
    id: "disclaimers",
    title: "Disclaimers",
    body: (
      <>
        <p>
          The Services are provided &ldquo;as is&rdquo; and &ldquo;as
          available&rdquo;. As far as the law allows, we give no warranty that
          they will be uninterrupted, error-free or fit for a particular
          purpose, or that AI output will be accurate. This does not limit any
          rights you have as a consumer that cannot be excluded by contract.
        </p>
      </>
    ),
  },
  {
    id: "liability",
    title: "Limits on our liability",
    body: (
      <>
        <p>As far as the law allows:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            we are not liable for indirect or consequential loss, such as lost
            profits, lost business or lost data, or for loss caused by actions
            an AI app took with access you granted;
          </li>
          <li>
            our total liability to you for all claims about the Services is
            limited to the greater of the amount you paid for AIBoard Remote in
            the 12 months before the claim, or USD 50.
          </li>
        </ul>
        <p>
          Nothing in these terms limits liability for death or personal injury
          caused by negligence, for fraud, or for anything else that cannot be
          limited by law.
        </p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to these terms",
    body: (
      <p>
        We may update these terms as the Services change. We will post the new
        version here with a new &ldquo;Last updated&rdquo; date. If a change
        materially affects paying customers, we will tell you by email or in
        the Remote dashboard at least 14 days before it takes effect. If you
        don&apos;t agree, you can cancel before then. Continuing to use the
        Services after a change takes effect means you accept it.
      </p>
    ),
  },
  {
    id: "law",
    title: "Governing law and disputes",
    body: (
      <>
        <p>
          These terms are governed by the laws of the Emirate of Dubai and the
          federal laws of the United Arab Emirates. The courts of Dubai have
          jurisdiction over any dispute about them.
        </p>
        <p>
          If you are a consumer, you also keep the protection of the mandatory
          consumer laws of the country where you live, and you may be able to
          bring a claim in your local courts. Before going to court, please
          email us; most problems can be sorted out quickly.
        </p>
      </>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        {SITE_LEGAL_NAME}, trading as {SITE_NAME}. {SITE_LEGAL_ADDRESS}. Email:{" "}
        {mail}.
      </p>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalDocument
      title="Terms of Service"
      sections={SECTIONS}
      summary={
        <ul className="list-disc space-y-2 pl-6">
          <li>
            {SITE_NAME} is run by {SITE_LEGAL_NAME}. The app and the Runner are
            free. AIBoard Remote has a free plan and paid plans.
          </li>
          <li>
            The Runner acts on your computer with your permissions. You decide
            what an AI app may do there, and you are responsible for it.
          </li>
          <li>
            Paid plans are not on sale yet. Once they are, you can cancel any
            time, and a full refund is available within 14 days of any payment.
          </li>
          <li>
            Remote is in beta, with no uptime guarantee. Every plan has
            fair-use rate limits.
          </li>
        </ul>
      }
    />
  );
}
