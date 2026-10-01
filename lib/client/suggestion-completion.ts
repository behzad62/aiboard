export interface SuggestionCompletionRequest {
  value: string;
  suggestion: string;
  key: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  multiline?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export function completeSuggestedValue({
  value,
  suggestion,
  key,
  selectionStart,
  selectionEnd,
  multiline = false,
  shiftKey = false,
  altKey = false,
  ctrlKey = false,
  metaKey = false,
}: SuggestionCompletionRequest): string | null {
  if (key !== "ArrowRight" && key !== "Tab") return null;
  if (shiftKey || altKey || ctrlKey || metaKey) return null;
  if (!suggestion) return null;
  if (selectionStart == null || selectionEnd == null) return null;
  if (selectionStart !== selectionEnd || selectionEnd !== value.length) return null;

  if (multiline && !suggestion.includes("\n")) {
    const lineStart = value.lastIndexOf("\n") + 1;
    const currentLine = value.slice(lineStart);
    if (!suggestion.startsWith(currentLine) || currentLine === suggestion) return null;
    return `${value.slice(0, lineStart)}${suggestion}`;
  }

  if (!suggestion.startsWith(value) || value === suggestion) return null;
  return suggestion;
}
