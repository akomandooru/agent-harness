/**
 * PR body renderers for the editor agent.
 *
 * The design's "PR body" section names two variants the agent must be
 * able to produce:
 *
 *   - **Success PR.** Trigger summary, change summary, file diff
 *     highlights, sensor results table (per-sensor pass/fail + finding
 *     counts), post-deploy summary, preview link, session log link.
 *   - **Partial PR.** Same structure plus a top banner naming the
 *     termination reason ("did not converge" / "timed out" / "cost cap
 *     reached" / "kill switch" / "oscillation"), the session log
 *     embedded inline (not just linked), and a recommended next-step
 *     note for the human reviewer.
 *
 * Two reference templates accompany this module:
 *
 *   - `agents/editor/pr-body.template.md` (success)
 *   - `agents/editor/pr-body-partial.template.md` (partial)
 *
 * The templates document the markdown shape but the renderers do not
 * parse them. The body is built programmatically from a `SessionView`.
 * That keeps the dependency surface small (no template engine), and it
 * keeps the renderer's exact output verifiable at the type level: the
 * `SessionView` is the only seam, and `renderSuccessPRBody` /
 * `renderPartialPRBody` are pure functions of it.
 *
 * `SessionView` is a deliberately narrow projection of the
 * `design.md` "Session contract" plus a few computed fields (sensor
 * counts, finding totals, terminations narratives, file-change
 * summaries). The orchestrator builds it from a session record before
 * calling the renderer; tests build synthetic views directly.
 */

import type { PostDeployOutcome } from "@agent-harness/post-deploy";
import type {
  ReviewerFinding,
  ReviewerSeverity,
} from "../reviewer/agent";

// ---------------------------------------------------------------------------
// SessionView and supporting types
// ---------------------------------------------------------------------------

/**
 * Termination reasons the design's session contract emits. Mirrors
 * `design.md`'s `termination.reason` union exactly so the orchestrator
 * can hand a session record's `reason` straight to the renderer.
 */
export type TerminationReason =
  | "success"
  | "iteration-cap"
  | "wall-clock-cap"
  | "token-cap"
  | "kill-switch"
  | "oscillation";

/**
 * Trigger summary the renderer prints in the "Trigger" section. Slim
 * subset of the trigger payload from `design.md`'s "Trigger payload":
 * the renderer cares about the issue identity, the module identity,
 * the session id, and the iteration cap (so "n of cap" is meaningful
 * in the partial template's banner).
 */
export interface SessionViewTrigger {
  readonly issue: {
    readonly number: number;
    readonly title: string;
    readonly url: string;
  };
  readonly module: {
    readonly path: string;
    readonly commitSha: string;
  };
  readonly session: {
    readonly id: string;
  };
  readonly limits: {
    readonly iterationCap: number;
  };
}

/**
 * One file the agent edited across all iterations. Aggregated by the
 * orchestrator from `iterations[*].edits[*]` so the PR body shows one
 * line per file rather than one line per per-iteration write.
 *
 * `additions` and `deletions` come from a unified diff line count; the
 * renderer doesn't care how the orchestrator produces them, only that
 * they are non-negative integers.
 */
export interface SessionViewFileChange {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  /** One-line description of what changed in this file. */
  readonly summary: string;
}

/**
 * Aggregated sensor results from the *final* iteration. The design's
 * sensor results table is per-iteration in the session log, but the PR
 * body shows the last iteration only (success: the final iteration
 * passed; partial: the final iteration's state at termination).
 */
export interface SessionViewSensors {
  readonly tsc: { readonly passed: boolean; readonly errorCount: number };
  readonly eslint: {
    readonly passed: boolean;
    readonly errorCount: number;
    readonly warningCount: number;
  };
  readonly unitTests: {
    readonly passed: boolean;
    readonly passCount: number;
    readonly failCount: number;
    readonly skipCount: number;
  };
  readonly cdkNag: {
    readonly passed: boolean;
    readonly errorCount: number;
    readonly warningCount: number;
  };
  readonly reviewer: {
    readonly passed: boolean;
    readonly findingCount: number;
    /** Severity counts as `severity -> count`, e.g. `{high: 2, medium: 1}`. */
    readonly severityCounts: Readonly<Record<ReviewerSeverity, number>>;
  };
}

/**
 * Post-deploy summary the renderer prints in the "Post-deploy harness"
 * section. The full report is in `report` (the type matches the
 * harness's `PostDeployOutput.report`); the renderer surfaces a
 * one-line summary from it via `reportSummary`.
 */
export interface SessionViewPostDeploy {
  readonly outcome: PostDeployOutcome;
  /** One-line human-readable summary of the report. */
  readonly reportSummary: string;
}

/**
 * Termination view. `reason` matches the session contract; the
 * narrative is what the renderer puts in the partial banner.
 *
 * `recommendedNextStep` is the partial-template's "what should the
 * human do next" sentence. The orchestrator owns the wording (so it
 * can encode reason-specific guidance from the runbook); the renderer
 * just prints it. For success terminations this field is unused.
 */
export interface SessionViewTermination {
  readonly reason: TerminationReason;
  readonly recommendedNextStep?: string;
}

/**
 * Projection of the gap-closure result used by the PR body renderer.
 *
 * The orchestrator builds this from the session's
 * `postDeploy.report.gapClosure` field (a `GapClosureResult`) plus the
 * `trigger.originatingFinding` field. The renderer only needs the
 * fields it prints; the full `GapClosureResult` evidence blob is not
 * surfaced here.
 */
export interface GapClosureView {
  readonly originatingFinding: {
    readonly id: string;
    readonly description: string;
    readonly severity: string;
    readonly pillar: string;
  };
  readonly gapId: string;
  readonly probeMethod: string;
  /** One-sentence summary of the probe evidence for the PR body. */
  readonly evidenceSummary: string;
  /** Preview environment identifier from `stackOutputs.previewEnvId`. */
  readonly previewEnvId: string;
  /** ISO-8601 timestamp of the gap-closure verification. */
  readonly verifiedAt: string;
}

/**
 * The data the PR body renderers read.
 *
 * The orchestrator builds this from a session record; tests build
 * synthetic views directly. Keep the shape stable: changing it forces
 * an update to every fixture in `__tests__/pr-body.test.ts`, which is
 * the right kind of friction for a contract this load-bearing.
 *
 * `summary` is the agent's own one-paragraph explanation of what the
 * PR contains. For the success variant it's the "summary of changes"
 * paragraph. For the partial variant it's "summary of attempted
 * changes" — same paragraph, different framing depending on the
 * renderer.
 *
 * `sessionLogLink` is the URL for the success template's "Session log"
 * link. `sessionLogText` is the inline-embedded log for the partial
 * template. The orchestrator typically supplies both (so the renderer
 * can pick which to use), but at minimum: success requires
 * `sessionLogLink`, partial requires `sessionLogText`.
 *
 * `previewLink` is the URL or human-readable identifier for the
 * preview environment. The orchestrator decides what to print here
 * (the API Gateway endpoint, the CloudFormation stack URL, etc.).
 *
 * `triggerType` distinguishes `"fitness-gap"` triggers (auto-opened by
 * the scheduled reviewer) from `"feature-change"` triggers (human-opened
 * issues). When absent, the renderer treats the session as a
 * `"feature-change"` trigger and omits the gap-closure section.
 *
 * `gapClosure` is the gap-closure result for the PR body. Present only
 * when `triggerType === "fitness-gap"` and the gap-closure check passed.
 * The renderer omits the gap-closure section when this field is absent
 * or null.
 */
export interface SessionView {
  readonly trigger: SessionViewTrigger;
  readonly iterationCount: number;
  readonly summary: string;
  readonly fileChanges: ReadonlyArray<SessionViewFileChange>;
  readonly sensors: SessionViewSensors;
  readonly postDeploy: SessionViewPostDeploy;
  readonly previewLink: string;
  readonly sessionLogLink?: string;
  readonly sessionLogText?: string;
  readonly termination: SessionViewTermination;
  readonly triggerType?: string;
  readonly gapClosure?: GapClosureView | null;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/**
 * Render the success-variant PR body for a converged session.
 *
 * Pure: given the same `SessionView`, returns the same string. No I/O,
 * no current time, no environment.
 *
 * Throws if the session's termination reason is not `"success"`. The
 * partial renderer is the right path for every other reason; calling
 * the success renderer on a non-success session is a programmer error
 * (a corrupt PR description with a "did not converge" reason silently
 * dressed up as a success would be worse than a loud throw).
 */
export function renderSuccessPRBody(view: SessionView): string {
  if (view.termination.reason !== "success") {
    throw new Error(
      `renderSuccessPRBody: expected termination.reason "success", got ` +
        `${JSON.stringify(view.termination.reason)}. Use ` +
        `renderPartialPRBody for non-success terminations.`,
    );
  }
  if (
    view.sessionLogLink === undefined ||
    view.sessionLogLink.length === 0
  ) {
    throw new Error(
      "renderSuccessPRBody: sessionLogLink is required for the success " +
        "variant. The partial variant embeds the log inline; the success " +
        "variant links to it.",
    );
  }

  const lines: string[] = [];

  pushTriggerSection(lines, view);
  pushSummarySection(lines, view, "## Summary of changes");
  pushFileChangesSection(lines, view);
  pushSensorTableSection(lines, view);
  pushPostDeploySection(lines, view);
  pushGapClosureSection(lines, view);
  pushPreviewSection(lines, view);

  lines.push("## Session log");
  lines.push("");
  lines.push(`- ${view.sessionLogLink}`);
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push(
    "_Opened by the agent harness editor agent. " +
      "A human merges; the agent does not._",
  );

  return joinWithTrailingNewline(lines);
}

/**
 * Render the partial-variant PR body for a non-success termination.
 *
 * Pure: given the same `SessionView`, returns the same string. No I/O.
 *
 * Throws if the session's termination reason is `"success"` (use the
 * success renderer instead) or if `sessionLogText` is missing (the
 * partial template embeds the log inline; without it the human
 * reviewer is missing the diagnostic context the partial PR exists to
 * surface).
 */
export function renderPartialPRBody(view: SessionView): string {
  if (view.termination.reason === "success") {
    throw new Error(
      "renderPartialPRBody: termination.reason is 'success'; use " +
        "renderSuccessPRBody for converged sessions.",
    );
  }
  if (
    view.sessionLogText === undefined ||
    view.sessionLogText.length === 0
  ) {
    throw new Error(
      "renderPartialPRBody: sessionLogText is required for the partial " +
        "variant. The partial template embeds the log inline rather than " +
        "linking to it.",
    );
  }

  const lines: string[] = [];

  // Top banner naming the termination reason. See `terminationLabel`
  // for the wording each reason maps to.
  const label = terminationLabel(view.termination.reason);
  const narrative = terminationNarrative(view.termination.reason);
  lines.push(`> :warning: **Did not finish: ${label}.** ${narrative}`);
  lines.push("");

  pushTriggerSection(lines, view);
  pushSummarySection(lines, view, "## Summary of attempted changes");
  pushFileChangesSection(lines, view);

  // The sensor table on a partial PR shows the *final* iteration's
  // results, the same as success. The agent stopped at this state,
  // so this is what the human reviewer needs to see.
  pushSensorTableSection(lines, view, {
    titleSuffix: " (final iteration)",
  });

  pushPostDeploySection(lines, view);
  pushPreviewSection(lines, view);

  // Recommended next step. The orchestrator owns the wording; the
  // renderer falls back to a sensible default keyed by reason if the
  // orchestrator omits it. The default is intentionally generic; a
  // forker who wants reason-specific guidance should supply
  // `recommendedNextStep` from the runbook.
  lines.push("## Recommended next step");
  lines.push("");
  const nextStep =
    view.termination.recommendedNextStep ??
    defaultRecommendedNextStep(view.termination.reason);
  lines.push(nextStep);
  lines.push("");

  // Embedded session log. Wrapped in a fenced code block so the log's
  // own newlines and special characters don't reflow as markdown.
  lines.push("## Session log (embedded)");
  lines.push("");
  lines.push("```");
  // Trim a single trailing newline so the closing fence sits on its
  // own line (markdown allows either, but consistency keeps the
  // snapshot stable).
  lines.push(stripSingleTrailingNewline(view.sessionLogText));
  lines.push("```");
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push(
    "_Opened by the agent harness editor agent on a partial " +
      "termination. A human picks up from here._",
  );

  return joinWithTrailingNewline(lines);
}

// ---------------------------------------------------------------------------
// Section builders (shared between renderers)
// ---------------------------------------------------------------------------

function pushTriggerSection(lines: string[], view: SessionView): void {
  lines.push("## Trigger");
  lines.push("");
  lines.push(
    `- Issue: [#${view.trigger.issue.number}](${view.trigger.issue.url}) — ` +
      `${view.trigger.issue.title}`,
  );
  lines.push(
    `- Module: \`${view.trigger.module.path}\` (ref \`${view.trigger.module.commitSha}\`)`,
  );
  lines.push(`- Session: \`${view.trigger.session.id}\``);
  lines.push(
    `- Iterations: ${view.iterationCount} of ${view.trigger.limits.iterationCap}`,
  );
  lines.push("");
}

function pushSummarySection(
  lines: string[],
  view: SessionView,
  heading: string,
): void {
  lines.push(heading);
  lines.push("");
  lines.push(view.summary);
  lines.push("");
}

function pushFileChangesSection(
  lines: string[],
  view: SessionView,
): void {
  lines.push("## File changes");
  lines.push("");
  if (view.fileChanges.length === 0) {
    lines.push("_No file changes recorded._");
  } else {
    for (const change of view.fileChanges) {
      lines.push(
        `- \`${change.path}\` (+${change.additions}/-${change.deletions}): ` +
          `${change.summary}`,
      );
    }
  }
  lines.push("");
}

interface SensorTableOptions {
  readonly titleSuffix?: string;
}

function pushSensorTableSection(
  lines: string[],
  view: SessionView,
  opts: SensorTableOptions = {},
): void {
  const suffix = opts.titleSuffix ?? "";
  lines.push(`## Sensor results${suffix}`);
  lines.push("");
  lines.push("| Sensor | Result | Findings |");
  lines.push("| --- | --- | --- |");
  const s = view.sensors;
  lines.push(
    `| \`sensor.tsc\` | ${sensorResultLabel(s.tsc.passed)} | ` +
      `${s.tsc.errorCount} error(s) |`,
  );
  lines.push(
    `| \`sensor.eslint\` | ${sensorResultLabel(s.eslint.passed)} | ` +
      `${s.eslint.errorCount} error(s), ${s.eslint.warningCount} warning(s) |`,
  );
  lines.push(
    `| \`sensor.unitTests\` | ${sensorResultLabel(s.unitTests.passed)} | ` +
      `${s.unitTests.passCount} passed, ${s.unitTests.failCount} failed, ` +
      `${s.unitTests.skipCount} skipped |`,
  );
  lines.push(
    `| \`sensor.cdkNag\` | ${sensorResultLabel(s.cdkNag.passed)} | ` +
      `${s.cdkNag.errorCount} error(s), ${s.cdkNag.warningCount} warning(s) |`,
  );
  lines.push(
    `| \`reviewer.invoke\` | ${sensorResultLabel(s.reviewer.passed)} | ` +
      `${s.reviewer.findingCount} finding(s); severities: ` +
      `${formatSeverityCounts(s.reviewer.severityCounts)} |`,
  );
  lines.push("");
}

function pushPostDeploySection(
  lines: string[],
  view: SessionView,
): void {
  lines.push("## Post-deploy harness");
  lines.push("");
  lines.push(`- Outcome: **${view.postDeploy.outcome}**`);
  lines.push(`- Report: ${view.postDeploy.reportSummary}`);
  lines.push("");
}

/**
 * Append the gap-closure section to `lines` when the session was
 * triggered by a `"fitness-gap"` trigger and a gap-closure result is
 * present.
 *
 * Returns immediately (no-op) when:
 *   - `view.triggerType` is absent or not `"fitness-gap"`, or
 *   - `view.gapClosure` is null or undefined.
 *
 * The section format matches the design's "PR body extension" section
 * (Requirement 4.5).
 */
function pushGapClosureSection(
  lines: string[],
  view: SessionView,
): void {
  if (view.triggerType !== "fitness-gap" || view.gapClosure == null) {
    return;
  }

  const gc = view.gapClosure;
  const of_ = gc.originatingFinding;

  lines.push("## Gap closure");
  lines.push("");
  lines.push(
    `**Originating finding:** ${of_.id} — ${of_.description}`,
  );
  lines.push(`**Severity:** ${of_.severity}`);
  lines.push(`**Pillar:** ${of_.pillar}`);
  lines.push("");
  lines.push("### Verification");
  lines.push("");
  lines.push(
    "The gap-closure check probed the deployed preview environment directly:",
  );
  lines.push("");
  lines.push("| Check | Method | Result |");
  lines.push("|---|---|---|");
  lines.push(`| ${gc.gapId} | ${gc.probeMethod} | ✅ Closed |`);
  lines.push("");
  lines.push(`**Evidence:** ${gc.evidenceSummary}`);
  lines.push("");
  lines.push(
    `*Verified against preview environment \`${gc.previewEnvId}\` at ${gc.verifiedAt}.*`,
  );
  lines.push("");
}

function pushPreviewSection(lines: string[], view: SessionView): void {
  lines.push("## Preview environment");
  lines.push("");
  lines.push(`- ${view.previewLink}`);
  lines.push("");
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Map a sensor's `passed` boolean onto the human-readable label the
 * sensor table prints. `:white_check_mark:` and `:x:` render as the
 * GitHub emoji on the rendered PR; the literal text is kept in the
 * snapshots.
 */
function sensorResultLabel(passed: boolean): string {
  return passed ? ":white_check_mark: pass" : ":x: fail";
}

/**
 * Render a severity-count map into a one-line "k1: v1, k2: v2" string,
 * sorted by the design's severity order so the line is stable across
 * runs (Object.entries' iteration order is insertion order, which the
 * orchestrator can't be trusted to fix).
 *
 * Zero counts are omitted (a long line with `info: 0, low: 0, ...`
 * adds noise without information). When every severity is zero the
 * function returns `"none"` so the line still reads naturally.
 */
function formatSeverityCounts(
  counts: Readonly<Record<string, number>>,
): string {
  const order: ReviewerSeverity[] = [
    "critical",
    "high",
    "medium",
    "low",
    "info",
  ];
  const parts: string[] = [];
  for (const sev of order) {
    const n = counts[sev] ?? 0;
    if (n > 0) parts.push(`${sev}: ${n}`);
  }
  return parts.length === 0 ? "none" : parts.join(", ");
}

/**
 * Map a non-success termination reason onto the design's banner
 * vocabulary. The mapping is from the design's "Partial PR" section:
 *
 *   - `iteration-cap`   -> "did not converge"
 *   - `wall-clock-cap`  -> "timed out"
 *   - `token-cap`       -> "cost cap reached"
 *   - `kill-switch`     -> "kill switch"
 *   - `oscillation`     -> "oscillation"
 *
 * `success` is not handled here because the success renderer is the
 * only path for it; the partial renderer rejects it earlier.
 */
function terminationLabel(reason: TerminationReason): string {
  switch (reason) {
    case "iteration-cap":
      return "did not converge";
    case "wall-clock-cap":
      return "timed out";
    case "token-cap":
      return "cost cap reached";
    case "kill-switch":
      return "kill switch";
    case "oscillation":
      return "oscillation";
    case "success":
      // Defensive: should never reach here.
      throw new Error(
        "terminationLabel: 'success' is not a partial-termination label",
      );
  }
}

/**
 * One-sentence narrative for each termination reason. Surfaced in the
 * partial banner alongside the label.
 */
function terminationNarrative(reason: TerminationReason): string {
  switch (reason) {
    case "iteration-cap":
      return (
        "The agent reached the iteration cap before the post-deploy " +
        "harness passed."
      );
    case "wall-clock-cap":
      return (
        "The agent reached the wall-clock cap before the post-deploy " +
        "harness passed."
      );
    case "token-cap":
      return (
        "The agent reached the token-spend cap before the post-deploy " +
        "harness passed."
      );
    case "kill-switch":
      return (
        "A human applied the `agent-stop` label and the loop halted " +
        "immediately."
      );
    case "oscillation":
      return (
        "The oscillation detector tripped: the agent produced the same " +
        "edit twice in three iterations or alternated between two " +
        "states across four."
      );
    case "success":
      throw new Error(
        "terminationNarrative: 'success' is not a partial-termination reason",
      );
  }
}

/**
 * Default "what next" sentence for each non-success reason. The
 * orchestrator can override via `view.termination.recommendedNextStep`;
 * the defaults here exist so a minimal `SessionView` still produces a
 * useful PR body.
 *
 * The wording stays generic on purpose: forkers with a runbook should
 * supply runbook-specific guidance via the orchestrator. Generic
 * defaults beat empty defaults, but they don't try to be a substitute
 * for `docs/runbook.md`.
 */
function defaultRecommendedNextStep(reason: TerminationReason): string {
  switch (reason) {
    case "iteration-cap":
      return (
        "Review the embedded session log to see where the agent " +
        "stalled. Either pick the iteration with the cleanest state " +
        "and continue manually, or refine the issue and re-apply the " +
        "`agent-task` label to start a fresh session."
      );
    case "wall-clock-cap":
      return (
        "The agent ran out of wall-clock time. If the trigger is " +
        "still relevant, re-apply the `agent-task` label to start a " +
        "fresh session; consider raising `limits.wallClockCapMinutes` " +
        "in `agent-harness.config.json` if the cap is too tight for " +
        "this kind of change."
      );
    case "token-cap":
      return (
        "The agent reached the token-spend cap. Review the embedded " +
        "session log for cost breakdown by iteration; consider " +
        "raising `limits.tokenSpendCapUSD` if the cap is consistently " +
        "too tight for this module."
      );
    case "kill-switch":
      return (
        "A human applied the `agent-stop` label. Resolve whatever " +
        "prompted the kill switch (review the session log for the " +
        "agent's last actions), then remove the `agent-stop` label " +
        "and re-apply `agent-task` to retry."
      );
    case "oscillation":
      return (
        "The agent kept producing the same edit or alternating " +
        "between two states. The trigger may be ambiguous or the " +
        "module may need a steering-file update before the agent can " +
        "converge. Review the embedded session log for the repeated " +
        "edits, then refine the issue or `AGENTS.md` and start a " +
        "fresh session."
      );
    case "success":
      throw new Error(
        "defaultRecommendedNextStep: 'success' has no partial next step",
      );
  }
}

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------

/**
 * Join `lines` with `\n` and ensure exactly one trailing newline. The
 * builders push markdown lines individually; this produces the shape
 * the snapshot tests expect.
 */
function joinWithTrailingNewline(lines: string[]): string {
  // Trim a trailing empty line if present so we don't end up with two
  // blank lines at the very end.
  const stripped =
    lines.length > 0 && lines[lines.length - 1] === ""
      ? lines.slice(0, -1)
      : lines;
  return stripped.join("\n") + "\n";
}

/**
 * Strip exactly one trailing `\n` (or `\r\n`) from a string so the
 * closing code-fence in the embedded session log sits on its own line.
 * Multiple trailing newlines or no trailing newline are passed through
 * unchanged on the assumption the orchestrator's session log has its
 * own consistent shape.
 */
function stripSingleTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

// ---------------------------------------------------------------------------
// Re-exports for tests / orchestrator typing
// ---------------------------------------------------------------------------

/**
 * Re-export `ReviewerFinding` so consumers building a `SessionView`
 * have one import surface for the reviewer-side types they care about.
 * The renderer itself doesn't print findings (the reviewer's full
 * output goes in the session log), but downstream code constructing a
 * `SessionView` from a session record will commonly need the type.
 */
export type { ReviewerFinding, ReviewerSeverity };
