import type { GameExport } from "@/lib/games/core/types";

function exportMimeType(exportData: GameExport): string {
  return `${exportData.mimeType};charset=utf-8`;
}

export function downloadGameExport(exportData: GameExport): void {
  if (
    typeof document === "undefined" ||
    typeof Blob === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof URL.revokeObjectURL !== "function"
  ) {
    throw new Error("Game export downloads are only available in a browser.");
  }

  const blob = new Blob([exportData.content], {
    type: exportMimeType(exportData),
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  try {
    anchor.href = url;
    anchor.download = exportData.filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body?.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove?.();
    URL.revokeObjectURL(url);
  }
}

export async function copyGameExportToClipboard(
  exportData: GameExport
): Promise<void> {
  if (
    typeof navigator === "undefined" ||
    !navigator.clipboard ||
    typeof navigator.clipboard.writeText !== "function"
  ) {
    throw new Error("Clipboard is unavailable in this browser.");
  }

  await navigator.clipboard.writeText(exportData.content);
}
