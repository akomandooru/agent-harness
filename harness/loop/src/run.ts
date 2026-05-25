/**
 * Bounded loop body for the agent harness.
 *
 * `runLoop` translates the pseudo-code from `design.md` "Behavioural design"
 * into TypeScript. It drives the editor agent through the seven-step gate
 * sequence (read context → plan/edit → sensors → reviewer → deploy →
 * post-deploy → success/fail) and wires each gate to the stop-condition
 * checker and to session updates via `SessionUpdater`.
 *
 * The loop is fully injectable: every I/O operation (editor, sensors,
 * reviewer, deploy, post-deploy, PR creation) is provided through the
 * `LoopGates` interface so tests can stub all external calls without any
 * real AWS, CDK, or GitHub traffic.
 *
 * Lifecycle:
 *
 *   1. Before each iteration, call `evaluateStopConditions`. If a condition
 *      fires, terminate and open a partial PR.
 *   2. Append an iteration via `SessionUpdater.appendIteration()`.
 *   3. Run each gate in order, recording results via `SessionUpdater`.
 *   4. After each gate failure, call `evaluateStopConditions` again to
 *      decide whether to iterate or terminate.
 *   5. On success (post-deploy passes), terminate with `"success"` and open
 *      a success PR.
 *   6. On any stop condition, terminate with the reason and open a partial PR.
 *   7. Persist the session to the store after each iteration completes.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4
 */

import {
  evaluateStopConditions,
  type KillSwitchPoll,
  type StopConditionConfig,
} from "./stop-conditions";
import {
  SessionUpdater,
  type Session,
  type SessionStore,
  type TerminationReason,
} from "./session";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Context the loop passes to the editor gate on each iteration.
 *
 * Mirrors the pseudo-code's `context = { trigger, steering, moduleSnapshot,
 * history }` from `design.md` Behavioural design. The loop builds this from
 * the current session state; the editor gate reads it to plan the next edit.
 */
export interface LoopContext {
  /** The original trigger payload (redacted). */
  readonly trigger: Session["trigger"];
  /** The session's iteration history up to (but not including) the current one. */
  readonly history: Session["iterations"];
}

/**
 * Result of a single editor run. The loop records the edits into the
 * current iteration via `SessionUpdater.recordEdit`.
 */
export interface EditorResult {
  readonly edits: ReadonlyArray<{ readonly path: string; readonly diff: string }>;
}

/**
 * Aggregated output from all four computational sensors.
 *
 * Each sensor's `passed` field drives the gate decision. The full result
 * is recorded into the session via `SessionUpdater.recordComputational`.
 */
export interface SensorResults {
  readonly cdkNag: { readonly findings: ReadonlyArray<unknown>; readonly passed: boolean };
  readonly tsc: { readonly errors: ReadonlyArray<unknown>; readonly passed: boolean };
  readonly eslint: { readonly findings: ReadonlyArray<unknown>; readonly passed: boolean };
  readonly unitTests: { readonly results: ReadonlyArray<unknown>; readonly passed: boolean };
}

/**
 * Output from the inferential reviewer.
 *
 * `passed` is `true` when no finding exceeds the configured severity
 * threshold. The loop records the full result into the session.
 */
export interface ReviewerResult {
  readonly findings: ReadonlyArray<unknown>;
  readonly passed: boolean;
  readonly severityCounts: Readonly<Record<string, number>>;
}

/**
 * Output from the CDK deploy step.
 *
 * `outcome` is `"ok"` on success; any other value is treated as a failure.
 * `stackOutputs` carries the CDK stack outputs (e.g., `ApiEndpointUrl`,
 * `QueueUrl`) that the post-deploy harness needs.
 */
export interface DeployResult {
  readonly outcome: string;
  readonly logs: string;
  readonly stackOutputs?: Record<string, string>;
}

/**
 * Output from the post-deploy harness.
 *
 * `outcome` is `"pass"` on success; any other value is treated as a failure.
 */
export interface PostDeployResult {
  readonly outcome: string;
  readonly report: Record<string, unknown>;
}

/**
 * All the tool invocations the loop calls, grouped into a single injectable
 * interface. Tests stub this; production wires real implementations.
 *
 * The interface is intentionally narrow: each method corresponds to exactly
 * one gate in the loop body. The loop does not call any other I/O.
 */
export interface LoopGates {
  /**
   * Run the editor agent with the given context. Returns the edits the
   * agent produced.
   */
  runEditor(context: LoopContext): Promise<EditorResult>;

  /**
   * Run all four computational sensors. Returns their aggregated output.
   */
  runSensors(): Promise<SensorResults>;

  /**
   * Run the inferential reviewer on the given diff. Returns the reviewer's
   * structured findings.
   */
  runReviewer(diff: string): Promise<ReviewerResult>;

  /**
   * Run `cdk deploy` against the preview environment. Returns the deploy
   * outcome and stack outputs.
   */
  runDeploy(): Promise<DeployResult>;

  /**
   * Run the post-deploy harness. `stackOutputs` carries the CDK stack
   * outputs from the preceding deploy step.
   */
  runPostDeploy(stackOutputs?: Record<string, string>): Promise<PostDeployResult>;

  /**
   * Open a pull request. `partial` is `true` for non-success terminations.
   * Returns the PR number and URL.
   */
  openPR(body: string, partial: boolean): Promise<{ number: number; url: string }>;
}

/**
 * Options for `runLoop`.
 */
export interface LoopOptions {
  /** Initial session built from the trigger payload. */
  readonly session: Session;
  /** Persistent backend for the session record. */
  readonly store: SessionStore;
  /** Stop-condition configuration from `agent-harness.config.json`. */
  readonly config: StopConditionConfig;
  /** Kill-switch poll (GitHub label check in production; stub in tests). */
  readonly killSwitchPoll: KillSwitchPoll;
  /**
   * Injectable clock. Defaults to `() => new Date()`. Tests inject a fixed
   * clock to make wall-clock checks deterministic.
   */
  readonly clock?: () => Date;
  /** All gate implementations. */
  readonly gates: LoopGates;
}

/**
 * Result returned by `runLoop` after the loop terminates.
 */
export interface LoopResult {
  /** The reason the loop terminated. */
  readonly terminationReason: TerminationReason;
  /** The PR number opened on termination, or `null` if PR creation failed. */
  readonly prNumber: number | null;
}

// ---------------------------------------------------------------------------
// Loop body
// ---------------------------------------------------------------------------

/**
 * Run the bounded loop for one trigger.
 *
 * The loop follows the pseudo-code from `design.md` Behavioural design
 * exactly. Each gate is run in order; failures short-circuit to the
 * stop-condition check. On success the loop terminates with `"success"`;
 * on any stop condition it terminates with the matching reason.
 *
 * The session is persisted to `store` after each iteration completes and
 * after the final termination record is written.
 */
export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const { session: initialSession, store, config, killSwitchPoll, gates } = options;
  const clock = options.clock ?? (() => new Date());

  const updater = new SessionUpdater(initialSession);

  // Persist the initial session state before the first iteration.
  await store.write(updater.getSession());

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // -----------------------------------------------------------------------
    // Pre-iteration stop-condition check (before appending a new iteration).
    // -----------------------------------------------------------------------
    const preCheck = await evaluateStopConditions(
      updater.getSession(),
      config,
      killSwitchPoll,
      clock()
    );
    if (preCheck !== null) {
      return await terminateAndOpenPartialPR(updater, store, gates, preCheck.reason);
    }

    // -----------------------------------------------------------------------
    // Append a new iteration.
    // -----------------------------------------------------------------------
    updater.appendIteration();

    // -----------------------------------------------------------------------
    // Step 1: Build context from current session state.
    // -----------------------------------------------------------------------
    const currentSession = updater.getSession();
    const context: LoopContext = {
      trigger: currentSession.trigger,
      // History is all iterations except the one we just appended (the last).
      history: currentSession.iterations.slice(0, -1),
    };

    // -----------------------------------------------------------------------
    // Step 2: Plan and edit.
    // -----------------------------------------------------------------------
    const editorResult = await gates.runEditor(context);
    for (const edit of editorResult.edits) {
      updater.recordEdit(edit);
    }

    // -----------------------------------------------------------------------
    // Step 3: Computational sensors.
    // -----------------------------------------------------------------------
    const sensorResults = await gates.runSensors();
    updater.recordComputational("cdkNag", sensorResults.cdkNag);
    updater.recordComputational("tsc", sensorResults.tsc);
    updater.recordComputational("eslint", sensorResults.eslint);
    updater.recordComputational("unitTests", sensorResults.unitTests);

    const sensorsAnyFailed =
      !sensorResults.cdkNag.passed ||
      !sensorResults.tsc.passed ||
      !sensorResults.eslint.passed ||
      !sensorResults.unitTests.passed;

    if (sensorsAnyFailed) {
      updater.completeIteration();
      await store.write(updater.getSession());

      const stopAfterSensors = await evaluateStopConditions(
        updater.getSession(),
        config,
        killSwitchPoll,
        clock()
      );
      if (stopAfterSensors !== null) {
        return await terminateAndOpenPartialPR(updater, store, gates, stopAfterSensors.reason);
      }
      // Continue to next iteration.
      continue;
    }

    // -----------------------------------------------------------------------
    // Step 4: Inferential reviewer.
    // -----------------------------------------------------------------------
    // Build a diff string from the current iteration's edits.
    const diff = editorResult.edits.map((e) => e.diff).join("\n");
    const reviewerResult = await gates.runReviewer(diff);
    updater.recordReviewer(reviewerResult);

    if (!reviewerResult.passed) {
      updater.completeIteration();
      await store.write(updater.getSession());

      const stopAfterReviewer = await evaluateStopConditions(
        updater.getSession(),
        config,
        killSwitchPoll,
        clock()
      );
      if (stopAfterReviewer !== null) {
        return await terminateAndOpenPartialPR(updater, store, gates, stopAfterReviewer.reason);
      }
      // Continue to next iteration.
      continue;
    }

    // -----------------------------------------------------------------------
    // Step 5: Deploy.
    // -----------------------------------------------------------------------
    const deployResult = await gates.runDeploy();
    updater.recordDeploy(deployResult);

    if (deployResult.outcome !== "ok") {
      updater.completeIteration();
      await store.write(updater.getSession());

      const stopAfterDeploy = await evaluateStopConditions(
        updater.getSession(),
        config,
        killSwitchPoll,
        clock()
      );
      if (stopAfterDeploy !== null) {
        return await terminateAndOpenPartialPR(updater, store, gates, stopAfterDeploy.reason);
      }
      // Continue to next iteration.
      continue;
    }

    // -----------------------------------------------------------------------
    // Step 6: Post-deploy harness.
    // -----------------------------------------------------------------------
    const postDeployResult = await gates.runPostDeploy(deployResult.stackOutputs);
    updater.recordPostDeploy(postDeployResult);

    if (postDeployResult.outcome !== "pass") {
      updater.completeIteration();
      await store.write(updater.getSession());

      const stopAfterPostDeploy = await evaluateStopConditions(
        updater.getSession(),
        config,
        killSwitchPoll,
        clock()
      );
      if (stopAfterPostDeploy !== null) {
        return await terminateAndOpenPartialPR(updater, store, gates, stopAfterPostDeploy.reason);
      }
      // Continue to next iteration.
      continue;
    }

    // -----------------------------------------------------------------------
    // Step 7: Success.
    // -----------------------------------------------------------------------
    updater.completeIteration();

    // Terminate with success before opening the PR so the session record
    // reflects the correct state even if PR creation fails.
    updater.terminate("success");
    await store.write(updater.getSession());

    const successPR = await gates.openPR(buildSuccessPRBody(updater.getSession()), false);
    updater.setTerminationPRNumber(successPR.number);
    await store.write(updater.getSession());

    return { terminationReason: "success", prNumber: successPR.number };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Terminate the session with the given reason and open a partial PR.
 *
 * Called from every non-success exit path. Writes the termination record,
 * persists the session, opens the partial PR, then updates the PR number
 * on the termination record and persists again.
 */
async function terminateAndOpenPartialPR(
  updater: SessionUpdater,
  store: SessionStore,
  gates: LoopGates,
  reason: TerminationReason
): Promise<LoopResult> {
  updater.terminate(reason);
  await store.write(updater.getSession());

  const partialPR = await gates.openPR(buildPartialPRBody(updater.getSession()), true);
  updater.setTerminationPRNumber(partialPR.number);
  await store.write(updater.getSession());

  return { terminationReason: reason, prNumber: partialPR.number };
}

/**
 * Build a minimal success PR body from the session record.
 *
 * The full PR body renderer lives in `agents/editor/pr-body.ts` and
 * requires a `SessionView` projection. The loop runner does not depend
 * on the editor agent package, so we produce a minimal body here that
 * the orchestrator can replace with the full renderer when wiring the
 * production entry point.
 */
function buildSuccessPRBody(session: Session): string {
  const { trigger, iterations, costs } = session;
  return [
    `## Agent harness: success`,
    ``,
    `- Session: \`${trigger.session.id}\``,
    `- Issue: #${trigger.issue.number} — ${trigger.issue.title}`,
    `- Module: \`${trigger.module.path}\``,
    `- Iterations: ${iterations.length} of ${trigger.limits.iterationCap}`,
    `- Editor tokens: $${costs.editorTokensUSD.toFixed(4)}`,
    `- Reviewer tokens: $${costs.reviewerTokensUSD.toFixed(4)}`,
    `- Preview infra: $${costs.previewInfraUSD.toFixed(4)}`,
    ``,
    `_Opened by the agent harness editor agent. A human merges; the agent does not._`,
  ].join("\n");
}

/**
 * Build a minimal partial PR body from the session record.
 *
 * Same caveat as `buildSuccessPRBody`: the full renderer is in
 * `agents/editor/pr-body.ts`. This minimal version is sufficient for
 * the loop runner's own tests and for the orchestrator to replace.
 */
function buildPartialPRBody(session: Session): string {
  const { trigger, iterations, termination, costs } = session;
  const reason = termination?.reason ?? "unknown";
  return [
    `## Agent harness: partial termination (${reason})`,
    ``,
    `- Session: \`${trigger.session.id}\``,
    `- Issue: #${trigger.issue.number} — ${trigger.issue.title}`,
    `- Module: \`${trigger.module.path}\``,
    `- Iterations completed: ${iterations.length} of ${trigger.limits.iterationCap}`,
    `- Termination reason: **${reason}**`,
    `- Editor tokens: $${costs.editorTokensUSD.toFixed(4)}`,
    `- Reviewer tokens: $${costs.reviewerTokensUSD.toFixed(4)}`,
    `- Preview infra: $${costs.previewInfraUSD.toFixed(4)}`,
    ``,
    `_Opened by the agent harness editor agent on a partial termination. A human picks up from here._`,
  ].join("\n");
}
