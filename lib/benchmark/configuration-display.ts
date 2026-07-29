import { redactAbsoluteLocalPaths, redactKnownSecrets } from "./redaction";
import type { BenchmarkResultSet } from "./types";

export interface BenchmarkConfigurationDisplay {
  subject: string;
  identity: string;
  tracks: string[];
  concise: string;
}

export function benchmarkConfigurationDisplay(
  resultSet: BenchmarkResultSet
): BenchmarkConfigurationDisplay {
  const configuration = resultSet.configuration;
  const subject = sanitizeBenchmarkDisplayText(configuration.displayName);
  const identity =
    configuration.subjectKind === "team"
      ? [
          sanitizeBenchmarkDisplayText(configuration.strategy ?? "team"),
          ...configuration.roles.map(
            (role) =>
              `${sanitizeBenchmarkDisplayText(role.role)}: ${sanitizeBenchmarkDisplayText(
                role.providerId
              )}/${sanitizeBenchmarkDisplayText(role.modelId)} · ${sanitizeBenchmarkDisplayText(
                role.reasoningEffort
              )} reasoning · ${formatMaxTokens(role.maxTokens)}`
          ),
        ].join(" · ")
      : `${sanitizeBenchmarkDisplayText(
          configuration.providerId ?? "provider"
        )}/${sanitizeBenchmarkDisplayText(
          configuration.modelId ?? configuration.displayName
        )} · ${sanitizeBenchmarkDisplayText(
          configuration.reasoningEffort ?? "default"
        )} reasoning · ${formatMaxTokens(
          configuration.roles[0]?.maxTokens ??
            uniqueMaxTokens(configuration.tracks.map((track) => track.maxTokens))
        )}`;
  const tracks = configuration.tracks.map((track) => {
    const cases = track.caseManifest
      .map(
        (item) =>
          `${sanitizeBenchmarkDisplayText(item.caseId)}@${sanitizeBenchmarkDisplayText(
            item.caseVersion
          )} · score ${sanitizeBenchmarkDisplayText(item.scoringVersion)}`
      )
      .join(", ");
    return `${trackLabel(track.track)} · suite ${sanitizeBenchmarkDisplayText(
      track.suiteId
    )} · ${formatMaxTokens(track.maxTokens)}${
      cases ? ` · ${cases}` : ""
    }`;
  });
  return {
    subject,
    identity,
    tracks,
    concise: [identity, ...tracks].join(" · "),
  };
}

export function sanitizeBenchmarkDisplayText(value: string): string {
  return redactAbsoluteLocalPaths(redactKnownSecrets(value));
}

function uniqueMaxTokens(values: Array<number | null>): number | null {
  const unique = Array.from(
    new Set(values.filter((value): value is number => value !== null))
  );
  return unique.length === 1 ? unique[0]! : null;
}

function formatMaxTokens(value: number | null): string {
  return value === null
    ? "max tokens vary"
    : `max ${new Intl.NumberFormat("en-US").format(value)} tokens`;
}

function trackLabel(track: string): string {
  if (track === "gameiq") return "GameIQ";
  if (track === "teamiq") return "TeamIQ";
  if (track === "workbench") return "WorkBench";
  if (track === "toolreliability") return "Tool Reliability";
  if (track === "harnessbench") return "HarnessBench";
  return sanitizeBenchmarkDisplayText(track);
}
