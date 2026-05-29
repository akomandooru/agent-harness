/**
 * Public API of the `@agent-harness/harness-shared` package.
 *
 * Re-exports all shared types used across the fitness-gap loop (Task 2)
 * components: the auto-open mechanism, the trigger payload extension,
 * the gap-closure check, and the observability additions.
 */

export type {
  AutoOpenInput,
  AutoOpenResult,
  GapClosureOutcomeRecord,
  GapClosureResult,
  OriginatingFinding,
  ReviewerFinding,
  ScheduledReviewerRunRecord,
} from "./fitness-gap-types";
