import type { ParetoDimension } from "./types";

export function computeParetoFrontier<T>(
  items: T[],
  dimensions: Array<ParetoDimension<T>>
): T[] {
  if (dimensions.length === 0) return [...items];

  return items.filter((candidate, candidateIndex) => {
    return !items.some((challenger, challengerIndex) => {
      if (candidateIndex === challengerIndex) return false;
      return dominates(challenger, candidate, dimensions);
    });
  });
}

function dominates<T>(
  challenger: T,
  candidate: T,
  dimensions: Array<ParetoDimension<T>>
): boolean {
  let strictlyBetter = false;

  for (const dimension of dimensions) {
    const challengerValue = comparableValue(
      dimension.value(challenger),
      dimension.direction
    );
    const candidateValue = comparableValue(
      dimension.value(candidate),
      dimension.direction
    );

    if (dimension.direction === "higher") {
      if (challengerValue < candidateValue) return false;
      if (challengerValue > candidateValue) strictlyBetter = true;
    } else {
      if (challengerValue > candidateValue) return false;
      if (challengerValue < candidateValue) strictlyBetter = true;
    }
  }

  return strictlyBetter;
}

function comparableValue(value: number, direction: "higher" | "lower"): number {
  if (Number.isFinite(value)) return value;
  return direction === "higher" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
}
