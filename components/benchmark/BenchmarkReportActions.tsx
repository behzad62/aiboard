"use client";

import { useRef } from "react";
import { ClipboardCopy, Download, RefreshCw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";

export function BenchmarkReportActions({
  onRefresh,
  onCopyReport,
  onExportJson,
  onExportLegacyJson,
  onImportJson,
}: {
  onRefresh: () => void;
  onCopyReport: () => void;
  onExportJson: () => void;
  onExportLegacyJson: () => void;
  onImportJson: (file: File) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={onRefresh}>
        <RefreshCw className="mr-2 h-4 w-4" />
        Refresh
      </Button>
      <Button variant="outline" size="sm" onClick={onCopyReport}>
        <ClipboardCopy className="mr-2 h-4 w-4" />
        Copy Markdown report
      </Button>
      <Button variant="outline" size="sm" onClick={onExportJson}>
        <Download className="mr-2 h-4 w-4" />
        Export Benchmark Bundle v2
      </Button>
      <Button variant="outline" size="sm" onClick={onExportLegacyJson}>
        <Download className="mr-2 h-4 w-4" />
        Export Legacy Lab Bundle v1
      </Button>
      <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
        <Upload className="mr-2 h-4 w-4" />
        Import
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.currentTarget.value = "";
          if (file) onImportJson(file);
        }}
      />
    </div>
  );
}
