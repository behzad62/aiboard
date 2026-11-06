"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Term = "monthly" | "6m" | "12m";

const TERMS: { id: Term; label: string; months: number; save?: string }[] = [
  { id: "monthly", label: "Monthly", months: 1 },
  { id: "6m", label: "6 months", months: 6, save: "10%" },
  { id: "12m", label: "Yearly", months: 12, save: "20%" },
];

// Keep in step with the payment provider's catalog: the relay sells exactly these prices.
// Features mirror the plan cards on the mcp.aiboard.me billing page.
const PLANS: {
  id: string;
  name: string;
  tagline: string;
  allowance: string;
  prices: Record<Term, number> | null;
  features: string[];
  cta: string;
  featured?: boolean;
}[] = [
  {
    id: "free",
    name: "Free",
    tagline: "Try it with your own AI app.",
    allowance: "10,000 tool calls / month",
    prices: null,
    features: [
      "Every tool on every paired computer",
      "ChatGPT, Claude, and other MCP apps",
      "Shared by free accounts on the same computer",
    ],
    cta: "Start free",
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "For daily work with an AI assistant.",
    allowance: "50,000 tool calls / month",
    prices: { monthly: 10, "6m": 54, "12m": 96 },
    features: [
      "Every tool on every paired computer",
      "5× the Free allowance",
      "Switch or cancel any time",
    ],
    cta: "Coming soon",
    featured: true,
  },
  {
    id: "max",
    name: "Max",
    tagline: "For heavy, all-day agent use.",
    allowance: "Unlimited tool calls",
    prices: { monthly: 20, "6m": 108, "12m": 192 },
    features: [
      "Every tool on every paired computer",
      "No monthly cap; fair-use rate limits apply",
      "Switch or cancel any time",
    ],
    cta: "Coming soon",
  },
];

function dollars(amount: number) {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

export function RemotePricing({ signInUrl, billingUrl }: { signInUrl: string; billingUrl: string }) {
  const [term, setTerm] = useState<Term>("monthly");
  const active = TERMS.find((entry) => entry.id === term)!;

  return (
    <div className="space-y-8">
      <div className="flex justify-center">
        <div role="radiogroup" aria-label="Billing period" className="glass inline-flex rounded-full border p-1">
          {TERMS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={term === entry.id}
              onClick={() => setTerm(entry.id)}
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition-colors sm:gap-2 sm:px-4",
                term === entry.id
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {entry.label}
              {entry.save && (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                    term === entry.id ? "bg-primary-foreground/20" : "bg-accent text-accent-foreground"
                  )}
                >
                  <span className="sm:hidden">−</span>
                  <span className="hidden sm:inline">Save </span>
                  {entry.save}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="grid items-stretch gap-5 md:grid-cols-3">
        {PLANS.map((plan) => {
          const total = plan.prices?.[term] ?? 0;
          const perMonth = total / active.months;
          return (
            <div
              key={plan.id}
              className={cn(
                "glass relative flex flex-col rounded-2xl border p-6",
                plan.featured && "ring-2 ring-primary md:-my-3 md:py-9"
              )}
            >
              {plan.featured && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground shadow">
                  Most popular
                </span>
              )}
              <h3 className="font-display text-xl font-semibold">{plan.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{plan.tagline}</p>

              <div className="mt-6 flex items-baseline gap-1">
                <span className="font-display text-5xl font-semibold tracking-tight">{dollars(perMonth)}</span>
                <span className="text-sm text-muted-foreground">/ month</span>
              </div>
              <p className="mt-1 h-5 text-xs text-muted-foreground">
                {plan.prices
                  ? active.months === 1
                    ? "Billed monthly"
                    : `${dollars(total)} billed every ${active.months === 12 ? "year" : "6 months"}`
                  : "No card needed"}
              </p>

              <p className="mt-6 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-foreground">
                {plan.allowance}
              </p>

              <ul className="mt-6 flex-1 space-y-3 text-sm">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-2.5">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              <Button
                asChild
                size="lg"
                variant={plan.featured ? "default" : "outline"}
                className="mt-8 w-full"
              >
                <a href={plan.prices ? billingUrl : signInUrl}>{plan.cta}</a>
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
