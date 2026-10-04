"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import type { PlanningExportDocument } from "@/lib/client/runner-v2";

export function PlanningExportView({ document }: { document: PlanningExportDocument }) {
  const [message, setMessage] = useState("");
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setMessage("Copied this export snapshot. It grants no execution approval."); }
    catch { setMessage("Clipboard unavailable. Select and copy the displayed text, or download the export."); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: "application/json" }));
    const anchor = window.document.createElement("a"); anchor.href = url; anchor.download = "aiboard-planning-export.json"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setMessage("Downloaded this export snapshot. Choose a project location yourself if you want to save it there.");
  };
  const referenceText = (reference: NonNullable<PlanningExportDocument["references"]>["cards"][number]["reference"]) => reference.unavailableReason
    ? `Reference unavailable: ${reference.unavailableReason}`
    : `Authenticated ${reference.method} ${reference.path}; JSON Pointer ${reference.selector || "(whole projection)"}`;
  return <div className="space-y-3 rounded border p-3" aria-label="Planning export snapshot">
    <p className="text-xs break-all">Export snapshot for {document.runId}, at {document.exportedAt}. Inspect current runner records before using these references; export never approves a source or starts execution.</p>
    <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void copy(document.snapshot.text)}>Copy STATE snapshot</Button><Button size="sm" variant="outline" onClick={download}>Download planning export</Button></div>
    {message && <p role="status" className="text-xs">{message}</p>}
    <details><summary>STATE snapshot</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{document.snapshot.text}</pre></details>
    {document.references ? <>
      <p className="text-xs">Native launch chips: {document.references.nativeLaunch.status}. {document.references.nativeLaunch.rationale}</p>
      {document.references.categories.map((category) => <details key={category.id}><summary>{category.title} ({category.recordCount} recorded; {category.omittedCount} omitted)</summary><p className="text-xs break-all">{referenceText(category.reference)}</p>{category.items.map((item) => <div key={`${item.reference.selector}:${item.id}`} className="my-2"><p className="text-xs">{item.id}{item.truncated ? " · truncated; inspect canonical run" : ""}</p><p className="text-xs break-all">{referenceText(item.reference)}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{item.text}</pre></div>)}</details>)}
      <details><summary>Copy-ready reference cards</summary><p className="text-xs">{document.references.omittedCardCount} worker cards omitted. Controller and applicable resume-planning cards are retained. Read each referenced current contract and claim before acting.</p>{document.references.cards.map((card) => <div key={`${card.kind}:${card.id}`} className="my-3 space-y-2"><p className="text-sm">{card.kind}: {card.id}</p><p className="text-xs break-all">{referenceText(card.reference)}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{card.text}</pre><Button size="sm" variant="outline" onClick={() => void copy(card.text)}>Copy {card.kind === "worker" ? `worker card ${card.id}` : card.kind === "controller" ? "controller card" : "resume-planning card"}</Button></div>)}</details>
    </> : <p className="text-xs">This legacy export retains its saved documentation policy. New planning cards and coverage are not inferred.</p>}
  </div>;
}
