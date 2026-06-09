"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Copy, Download, CheckCircle2 } from "lucide-react";

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
        ? `\n\n## Remaining disagreements\n${dissent.map((d) => `- ${d}`).join("\n")}`
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
    <Card className="border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/20">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              <CardTitle>Final Answer</CardTitle>
            </div>
            <Badge variant="success">Confidence: {confidence}/10</Badge>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={copyAnswer}>
              <Copy className="mr-1 h-4 w-4" />
              {copied ? "Copied!" : "Copy"}
            </Button>
            <Button variant="outline" size="sm" onClick={exportMarkdown}>
              <Download className="mr-1 h-4 w-4" />
              Export MD
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="whitespace-pre-wrap text-sm leading-relaxed">{answer}</div>
        {dissent.length > 0 && (
          <div className="rounded-md border bg-background p-4">
            <h4 className="mb-2 text-sm font-semibold">Unresolved disagreements</h4>
            <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
              {dissent.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
