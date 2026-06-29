"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { HarnessProfile } from "@/lib/benchmark/types";

const BROWSER_PROFILES: Array<{ id: HarnessProfile; label: string }> = [
  { id: "raw-single-model", label: "Direct model call" },
  { id: "aiboard-single-model", label: "AI Board single-agent harness" },
];

export function HarnessProfilePicker({
  value,
  onChange,
  profiles = BROWSER_PROFILES,
}: {
  value: HarnessProfile;
  onChange: (value: HarnessProfile) => void;
  profiles?: Array<{ id: HarnessProfile; label: string }>;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as HarnessProfile)}>
      <SelectTrigger>
        <SelectValue placeholder="Execution mode" />
      </SelectTrigger>
      <SelectContent>
        {profiles.map((profile) => (
          <SelectItem key={profile.id} value={profile.id}>
            {profile.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
