"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/Markdown";
import { ConfidenceRing } from "@/components/ConfidenceRing";
import { Copy, Download, Check, AlertTriangle } from "lucide-react";

interface FinalAnswerCardProps {
  answer: string;
  confidence: number;
  dissent: string[];
  topic: string;
}

export function FinalAnswerCard({
  answer,
  confidence,
  dissent,
  topic,
}: FinalAnswerCardProps) {
  const [copied, setCopied] = useState(false);

  const copyAnswer = async () => {
    await navigator.clipboard.writeText(answer);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const exportMarkdown = () => {
    const dissentSection =
      dissent.length > 0
        ? `\n\n## Remaining disagreements\n${dissent
            .map((d) => `- ${d}`)
            .join("\n")}`
        : "";
    const md = `# ${topic}\n\n**Confidence:** ${confidence}/10\n\n${answer}${dissentSection}`;
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `discussion-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="relative scroll-mt-6 overflow-hidden rounded-2xl border border-emerald-300/60 bg-gradient-to-br from-emerald-50/80 via-card to-card shadow-md dark:border-emerald-900/60 dark:from-emerald-950/30">
      <div
        className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-emerald-400/15 blur-3xl"
        aria-hidden
      />

      <div className="relative flex flex-wrap items-start justify-between gap-4 border-b border-emerald-200/60 p-6 dark:border-emerald-900/50">
        <div className="flex items-start gap-4">
          <ConfidenceRing value={confidence} />
          <div>
            <p className="font-mono text-[0.7rem] font-semibold uppercase tracking-[0.2em] text-emerald-700 dark:text-emerald-400">
              Final synthesis
            </p>
            <h2 className="mt-1 font-display text-2xl font-semibold tracking-tight">
              The Verdict
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Synthesized by the judge from the full discussion.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={copyAnswer}>
            {copied ? (
              <Check className="mr-1 h-4 w-4 text-emerald-600" />
            ) : (
              <Copy className="mr-1 h-4 w-4" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="outline" size="sm" onClick={exportMarkdown}>
            <Download className="mr-1 h-4 w-4" />
            Export MD
          </Button>
        </div>
      </div>

      <div className="relative p-6">
        <Markdown content={answer} />

        {dissent.length > 0 && (
          <div className="mt-6 rounded-xl border border-amber-200/70 bg-amber-50/60 p-4 dark:border-amber-900/50 dark:bg-amber-950/20">
            <h3 className="flex items-center gap-2 font-display text-sm font-semibold text-amber-900 dark:text-amber-200">
              <AlertTriangle className="h-4 w-4" />
              Unresolved disagreements
            </h3>
            <ul className="mt-2 space-y-1.5 text-sm text-amber-900/90 dark:text-amber-100/80">
              {dissent.map((item, i) => (
                <li key={i} className="flex gap-2">
                  <span className="mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
