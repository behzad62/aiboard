"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SelectedModel } from "@/lib/providers/base";

export function ModelTeamPicker({
  value,
  models,
  onChange,
}: {
  value: string;
  models: SelectedModel[];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={models.length === 0}>
      <SelectTrigger>
        <SelectValue placeholder="Model" />
      </SelectTrigger>
      <SelectContent>
        {models.map((model) => (
          <SelectItem key={model.modelId} value={model.modelId}>
            {model.displayName || model.modelId}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
