/**
 * Shared TypeScript interfaces for the fitness-gap loop (Task 2).
 *
 * These types are used across the auto-open mechanism, the trigger payload
 * extension, the gap-closure check, and the observability additions.
 *
 * `ReviewerFinding` is defined here (mirroring the shape in
 * `agents/reviewer/agent.ts`) rather than imported across package
 * boundaries. This follows the same pattern the reviewer package uses when
 * it re-implements `module.readFile` rather than importing from the editor:
 * cross-package imports that cross the `rootDir` boundary break the
 * TypeScript build, and coupling the harness-shared package to the reviewer
 * agent's internals would create the wrong dependency direction.
 *
 * If the `ReviewerFinding` shape changes in `agents/reviewer/agent.ts`,
 * update this definition in lockstep.
 */

// ---------------------------------------------------------------------------
// Reviewer finding (mirrored from agents/reviewer/agent.ts)
// ---------------------------------------------------------------------------

/**
 * Severity vocabulary for findings, matching the reviewer system prompt's
 * output schema.
 */
export type ReviewerSeverity =
  | "info"
  | "low"
  | "medium"
  | "high"
  | "critical";

/**
 * One reviewer finding. Mirrors `ReviewerFinding` from
 * `agents/reviewer/agent.ts` and the schema from `design.md`'s
 * `ReviewerOutput.findings[*]`.
 */
export interface ReviewerFinding {
  /** Checklist item id, e.g. `WA-SEC-02`. */
  readonly id: string;
  /** Pillar the finding belongs to, e.g. `Security`. */
  readonly pillar: string;
  /** Severity of the finding. */
  readonly severity: ReviewerSeverity;
  /** Path inside the module, when locatable. */
  readonly file?: string;
  /** 1-indexed line in `file`, when locatable. */
  readonly line?: number;
  /** One or two sentences naming the gap. */
  readonly description: string;
  /** One-line note describing the suggested fix. Never code. */
  readonly suggestedFix: string;
}

// ---------------------------------------------------------------------------
// Trigger payload types (Requirement 3.2)
// ---------------------------------------------------------------------------

/**
 * The originating finding embedded in the trigger payload and session when
 * `triggerType === "fitness-gap"`.
 *
 * Produced by the auto-open mechanism from a `ReviewerFinding` plus run
 * metadata. Consumed by the gap-closure check and the PR body renderer.
 *
 * For `feature-change` triggers, this field is absent from the payload
 * (not null, absent). The session schema treats it as optional.
 */
export interface OriginatingFinding {
  /** Content-derived signature (SHA-256, 16 hex chars). */
  signature: string;
  /** Checklist item id, e.g. "WA-SEC-02". */
  id: string;
  /** Well-Architected pillar, e.g. "Security". */
  pillar: string;
  /** Severity at the time the finding was produced. */
  severity: "info" | "low" | "medium" | "high" | "critical";
  /** One or two sentences naming the gap. */
  description: string;
  /** Path inside the module, when locatable. */
  file?: string;
  /** 1-indexed line in file, when locatable. */
  line?: number;
  /** One-line note describing the suggested fix. */
  suggestedFix: string;
  /** Identifier of the scheduled reviewer run that produced this finding. */
  runId: string;
  /** ISO-8601 timestamp of the run. */
  runDate: string;
}

// ---------------------------------------------------------------------------
// Gap-closure check types (Requirement 4.3, 4.4)
// ---------------------------------------------------------------------------

/**
 * The output of a single gap-closure probe.
 *
 * Written to the session's `postDeploy.report.gapClosure` field when the
 * gap-closure check runs. Also embedded in the PR body when the check passes.
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

// ---------------------------------------------------------------------------
// Auto-open mechanism types (Requirement 2.2)
// ---------------------------------------------------------------------------

/**
 * Input to the `autoOpenIssues` function.
 *
 * Carries the reviewer's findings plus the run metadata needed to populate
 * the issue body and the `ScheduledReviewerRunRecord`.
 */
export interface AutoOpenInput {
  findings: ReviewerFinding[];
  runId: string;
  runDate: string;
  modelId: string;
}

/**
 * Result returned by `autoOpenIssues`.
 *
 * Counts are used to populate the `ScheduledReviewerRunRecord` emitted
 * after the auto-open step completes.
 */
export interface AutoOpenResult {
  /** Number of new issues opened. */
  opened: number;
  /** Number of findings skipped because a duplicate issue already exists. */
  skipped: number;
  /** Number of comments added to existing duplicate issues. */
  commented: number;
  /** Per-finding errors that did not prevent the overall run from completing. */
  errors: Array<{ finding: ReviewerFinding; error: string }>;
}

// ---------------------------------------------------------------------------
// Observability types (Requirement 5.1, 5.3)
// ---------------------------------------------------------------------------

/**
 * Emitted to CloudWatch Logs at `/agent-harness/scheduled-reviewer` after
 * every scheduled reviewer invocation, on both success and failure paths.
 *
 * The `schemaVersion` field is pinned to `"1.0"` so consumers can detect
 * breaking changes without parsing the full record.
 */
export interface ScheduledReviewerRunRecord {
  schemaVersion: "1.0";
  /** "scheduled-reviewer-run-<iso-timestamp>" */
  runId: string;
  /** ISO-8601 timestamp of the run. */
  timestamp: string;
  modelId: string;
  modelVersion: string;
  outcome: "success" | "failure";
  /** Present only when `outcome === "failure"`. */
  failureReason?: string;
  /** Finding counts keyed by severity, e.g. `{ high: 2, critical: 1 }`. */
  findingsBySeverity: Record<string, number>;
  issuesOpened: number;
  duplicatesSkipped: number;
  tokenCostUSD: number;
}

/**
 * Emitted to CloudWatch Logs at `/agent-harness/gap-closure-outcomes` when
 * an auto-opened issue closes (merged, closed without merge, or expired).
 *
 * Triggered by the GitHub Actions `issues.closed` event. The emitter reads
 * the issue's session log to extract the timing and outcome fields.
 *
 * Nullable fields are `null` when the data was not available (e.g., the
 * agent never opened a PR, or the gap-closure check was not run).
 */
export interface GapClosureOutcomeRecord {
  schemaVersion: "1.0";
  issueNumber: number;
  findingSignature: string;
  findingId: string;
  openedAt: string;
  closedAt: string;
  closeReason: "merged" | "closed-without-merge" | "expired";
  /** Milliseconds from issue open to first PR open. Null if no PR was opened. */
  timeToFirstPrOpenMs: number | null;
  /** Number of agent loop iterations. Null if the agent was never dispatched. */
  agentIterations: number | null;
  /** Outcome of the post-deploy harness on the final iteration. */
  postDeployOutcome: "pass" | "fail" | "partial" | "deploy-failure" | null;
  /** Whether the gap-closure probe confirmed the gap was closed. */
  gapClosureOutcome: "closed" | "not-closed" | "not-checked" | null;
}
