"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  WorkBenchV1CaseOption,
  WorkBenchV2CaseOption,
} from "@/lib/benchmark/workbench";

export type WorkBenchCasePickerOption =
  | WorkBenchV1CaseOption
  | WorkBenchV2CaseOption;

export function WorkBenchCasePicker({
  value,
  cases,
  onChange,
}: {
  value: string;
  cases: WorkBenchCasePickerOption[];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder="WorkBench case" />
      </SelectTrigger>
      <SelectContent>
        {cases.map((item) => (
          <SelectItem key={item.id} value={item.id}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
