import Link from "next/link";
import { LegalDocument, legalLink, type LegalSection } from "@/components/LegalDocument";
import {
  SITE_CONTACT_EMAIL,
  SITE_LEGAL_NAME,
  SITE_NAME,
  pageMetadata,
} from "@/lib/site";

export const metadata = pageMetadata({
  title: "Refund Policy",
  description:
    "AIBoard Remote paid plans can be refunded in full within 14 days of any payment. How to ask, what happens to your plan, and how cancellation works.",
  path: "/refunds",
});

const mail = (
  <a href={`mailto:${SITE_CONTACT_EMAIL}`} className={legalLink}>
    {SITE_CONTACT_EMAIL}
  </a>
);

const SECTIONS: LegalSection[] = [
  {
    id: "window",
    title: "14-day money-back guarantee",
    body: (
      <>
        <p>
          You can get a <strong>full refund of any payment for AIBoard Remote
          within 14 days</strong> of the date you were charged. This covers your
          first purchase, every renewal (monthly, 6-month or yearly), and the
          extra charge for an upgrade. You don&apos;t need to give a reason, and
          it applies even if you have already used the plan.
        </p>
        <p>
          The {SITE_NAME} app, the Runner and the AIBoard Remote Free plan cost
          nothing, so there is nothing to refund. Charges from AI providers
          (such as OpenAI or Anthropic) or AI apps (such as ChatGPT or Claude)
          are between you and them; we can&apos;t refund those.
        </p>
      </>
    ),
  },
  {
    id: "how",
    title: "How to ask for a refund",
    body: (
      <>
        <p>
          Paid plans are not on sale yet, so there is nothing to refund today.
          Once they are, email {mail} with the email address you paid with or
          the order number from your receipt.
        </p>
        <p>
          Our payment provider sends the refund to your original payment
          method, normally within 14 days of approval. It may take a few more business days for
          your bank to show it. Any tax you paid is refunded with it.
        </p>
      </>
    ),
  },
  {
    id: "plan",
    title: "What happens to your plan",
    body: (
      <>
        <p>
          A refunded payment ends the paid period it covered: your
          subscription is cancelled and your account moves to the Free plan.
          Your account, paired devices and settings are kept. You are welcome
          to subscribe again later.
        </p>
        <p>
          If you only want to stop paying in future, you don&apos;t need a
          refund: cancel instead (see below).
        </p>
      </>
    ),
  },
  {
    id: "after",
    title: "After 14 days",
    body: (
      <>
        <p>
          After 14 days a payment is normally not refundable, but you can
          cancel at any time from the Remote billing page. Cancelling stops the next renewal and you keep your plan until the
          end of the period you paid for. We will always refund the unused
          part of a paid period if we close your account without a breach on
          your part, discontinue AIBoard Remote, or materially reduce your
          plan during it. If something went wrong for you, such as a long
          outage, email us and we will look at it fairly.
        </p>
      </>
    ),
  },
  {
    id: "statutory",
    title: "Your legal rights",
    body: (
      <p>
        If you live in the EU, EEA, UK or Switzerland, you also have a legal
        right to withdraw from a purchase within 14 days. Our 14-day guarantee is at least as generous: we won&apos;t refuse a
        refund within 14 days because you started using the service. Nothing in
        this policy limits rights you have under the consumer law of your
        country.
      </p>
    ),
  },
  {
    id: "chargebacks",
    title: "Chargebacks",
    body: (
      <p>
        Please contact us before disputing a charge with your bank. A refund is usually faster. While a chargeback is open, the paid plan is
        suspended; it is restored if the dispute is resolved in our favour.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        {SITE_LEGAL_NAME}, trading as {SITE_NAME}. Email: {mail}. See also our{" "}
        <Link href="/terms" className={legalLink}>
          Terms of Service
        </Link>{" "}
        and{" "}
        <Link href="/privacy" className={legalLink}>
          Privacy Policy
        </Link>
        .
      </p>
    ),
  },
];

export default function RefundsPage() {
  return (
    <LegalDocument
      title="Refund Policy"
      sections={SECTIONS}
      summary={
        <ul className="list-disc space-y-2 pl-6">
          <li>
            Full refund of any AIBoard Remote payment within 14 days, with no
            questions asked.
          </li>
          <li>
            Email {mail} to ask. Paid plans are not on sale yet, so there is
            nothing to refund today.
          </li>
          <li>
            A refund ends that paid period and moves you to Free. Nothing on
            your account is deleted.
          </li>
          <li>
            Cancel any time to stop renewals; you keep your plan until the
            period ends.
          </li>
        </ul>
      }
    />
  );
}
