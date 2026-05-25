/**
 * Severity threshold filter for the auto-open mechanism.
 *
 * Implements ordered severity comparison (`info < low < medium < high < critical`)
 * and filters findings against `fitnessGapLoop.autoOpen.severityThreshold`.
 */

import type { ReviewerFinding } from "../../shared/src/fitness-gap-types";

/**
 * Numeric rank for each severity level.
 * Higher rank = more severe.
 * Unknown severities are treated as the lowest rank (0).
 */
export const SEVERITY_ORDER: Record<string, number> = {
  info: 1,
  low: 2,
  medium: 3,
  high: 4,
  critical: 5,
};

/**
 * Returns the numeric rank for a severity string.
 * Unknown values return 0 (treated as lower than any known severity).
 */
function severityRank(severity: string): number {
  return SEVERITY_ORDER[severity.toLowerCase()] ?? 0;
}

/**
 * Returns true when the finding's severity is at or above the threshold.
 *
 * Both the finding severity and the threshold are compared
 * case-insensitively. Unknown severity or threshold values are treated
 * as rank 0 (lowest), so an unknown threshold passes all findings and
 * an unknown finding severity never meets a known threshold.
 */
export function meetsThreshold(
  finding: ReviewerFinding,
  threshold: string,
): boolean {
  return severityRank(finding.severity) >= severityRank(threshold);
}

/**
 * Filters an array of findings to those at or above the given threshold.
 *
 * Preserves the original order of findings. Returns an empty array when
 * no findings meet the threshold.
 */
export function filterByThreshold(
  findings: ReviewerFinding[],
  threshold: string,
): ReviewerFinding[] {
  return findings.filter((f) => meetsThreshold(f, threshold));
}
