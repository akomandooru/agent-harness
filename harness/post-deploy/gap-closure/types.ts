/**
 * Local re-export of gap-closure types for use within the post-deploy package.
 *
 * `GapClosureResult` is defined in `harness/shared/src/fitness-gap-types.ts`
 * and is the canonical source of truth. This file re-exports it via a path
 * that stays within the post-deploy package's `rootDir`, avoiding the
 * TypeScript TS6059 error that arises when probes import directly from
 * `../../../shared/src/fitness-gap-types`.
 *
 * If the `GapClosureResult` shape changes in the shared package, update
 * this definition in lockstep.
 */

/**
 * The output of a single gap-closure probe.
 *
 * Mirrors `GapClosureResult` from `harness/shared/src/fitness-gap-types.ts`.
 */
export interface GapClosureResult {
  /** Finding id this probe checked, e.g. "WA-SEC-02". */
  gapId: string;
  /** Whether the gap is no longer exhibited in the deployed environment. */
  closed: boolean;
  /** Raw evidence from the AWS API call (for PR body and session log). */
  evidence: Record<string, unknown>;
  /** AWS API method used to probe, e.g. "sns:GetTopicAttributes". */
  probeMethod: string;
  /** Error message if the probe itself failed (distinct from gap not closed). */
  probeError?: string;
}
