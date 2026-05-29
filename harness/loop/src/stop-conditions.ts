/**
 * Stop-condition checker for the bounded loop.
 *
 * `design.md` "Stop conditions" pins the deterministic order this module
 * implements. The loop runner calls `evaluateStopConditions` once per
 * iteration boundary; the returned `StopCondition` is either `null`
 * (keep going) or a `{reason}` carrying the highest-priority termination
 * reason that fires for the current session state.
 *
 * The order is part of the contract, not an implementation detail. If two
 * conditions could both fire (e.g., the iteration cap is reached on the
 * same turn the kill-switch label appears), the higher-priority one wins.
 * That keeps the PR description and the runbook coherent: a session that
 * was halted by an operator gets `kill-switch`, not `iteration-cap`,
 * regardless of internal counters.
 *
 * Priority order (highest to lowest):
 *
 *   1. `kill-switch`        — `agent-stop` label is applied
 *   2. `iteration-cap`      — `iterations.length >= cap`
 *   3. `wall-clock-cap`     — `now - firstIterationStart >= cap`
 *   4. `token-cap`          — `editor + reviewer >= cap`
 *   5. `oscillation`        — same diff in window OR alternation in window
 *
 * The `success` reason is owned by the loop body itself (when post-deploy
 * passes the loop terminates with `success` directly) and is intentionally
 * not part of this checker; this module only answers "should the loop
 * stop because of a guard?", not "did the loop succeed?".
 *
 * Surface
 * -------
 *
 *   - `evaluateStopConditions(session, config, killSwitchPoll, now)`
 *     The runner's entry point. Polls the kill-switch first, then walks
 *     the deterministic order. Returns the first reason that fires, or
 *     `null` if none.
 *
 *   - `detectOscillation(iterations, sameDiffWindow, alternationWindow)`
 *     Pure, async-free helper. Returns `true` when either heuristic
 *     fires:
 *       a) The same diff appears at least twice across the last
 *          `sameDiffWindow` iterations (default 3).
 *       b) The last `alternationWindow` iterations strictly alternate
 *          between two distinct `(computational + reviewer)` states
 *          (default window 4 → A,B,A,B).
 *
 *   - `KillSwitchPoll` interface — the runner injects a real GitHub
 *     poll; tests inject stubs.
 *
 *   - `StopConditionConfig` interface — typed view of the relevant
 *     subset of `agent-harness.config.json` (limits + oscillation
 *     windows).
 *
 * Why a checker module rather than methods on `SessionUpdater`?
 * The updater owns mutation. The stop-condition checker is a pure
 * read of session state plus a kill-switch poll, so it stays
 * dependency-free except for the session contract types and the poll
 * interface. That makes the property test straightforward (no I/O,
 * no mutation surface to mock) and lets the runner wire the poll
 * implementation independently.
 */

import type { IterationRecord, Session, TerminationReason } from "./session";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result of a stop-condition evaluation.
 *
 * `null` means "no stop condition fired; keep iterating." A non-null value
 * carries the reason the loop must terminate. Only termination reasons
 * that come from the guard checker appear here; `success` is recorded by
 * the loop body directly when the post-deploy harness passes.
 */
export type StopCondition = { readonly reason: TerminationReason } | null;

/**
 * Async poll for the GitHub `agent-stop` label. The orchestrator wires
 * this to a real GitHub API call (poll the issue and any in-flight PR);
 * tests inject a stub returning a boolean.
 *
 * The poll receives the full session so implementations can extract the
 * issue/PR identifiers from `session.trigger`. The session object is
 * read-only for the poll's purposes.
 *
 * Rejection behaviour: the checker propagates rejections from the poll
 * to the caller. The loop runner is responsible for deciding whether a
 * transient GitHub error should halt the session or be retried; the
 * checker does not retry on its own.
 */
export interface KillSwitchPoll {
  isAgentStopLabelApplied(session: Session): Promise<boolean>;
}

/**
 * Configuration the checker reads. Mirrors the relevant subset of
 * `agent-harness.config.json`: `limits.*` from the trigger payload's
 * limits block (which the dispatcher copies from the repo config) and
 * the top-level `oscillation` block.
 *
 * The runner is responsible for assembling this config; we keep the
 * shape narrow so the checker does not depend on the wider trigger
 * payload (it can be unit-tested without standing up a full session).
 */
export interface StopConditionConfig {
  readonly iterationCap: number;
  readonly wallClockCapMinutes: number;
  readonly tokenSpendCapUSD: number;
  readonly oscillation: {
    readonly sameDiffWindow: number;
    readonly alternationWindow: number;
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk the deterministic order and return the first stop condition that
 * fires, or `null` if none.
 *
 * The kill-switch poll runs first, before any other check, so an operator
 * who applies `agent-stop` in the same instant the iteration cap is
 * reached still gets `kill-switch` recorded. This is by design: the
 * operator's intent dominates internal counters.
 *
 * `now` is supplied by the caller (a real `Date` in production, a fixed
 * clock in tests). Keeping the time source out of the function makes the
 * wall-clock check deterministic under test.
 *
 * Throws only if `killSwitchPoll.isAgentStopLabelApplied` rejects; the
 * rest of the checker is pure.
 */
export async function evaluateStopConditions(
  session: Session,
  config: StopConditionConfig,
  killSwitchPoll: KillSwitchPoll,
  now: Date
): Promise<StopCondition> {
  validateConfig(config);

  // 1. Kill switch. Polled first so operator intent dominates.
  if (await killSwitchPoll.isAgentStopLabelApplied(session)) {
    return { reason: "kill-switch" };
  }

  // 2. Iteration cap.
  //    Fires when the number of recorded iterations has reached the cap.
  //    The runner consults the checker *before* spawning a new iteration,
  //    so a session with `cap` iterations recorded must terminate now.
  if (session.iterations.length >= config.iterationCap) {
    return { reason: "iteration-cap" };
  }

  // 3. Wall-clock cap.
  //    Fires when the elapsed time since the first iteration started
  //    meets or exceeds the cap. We use the first iteration's
  //    `startedAt` rather than the trigger's `createdAt` because the
  //    spec scopes the cap to "per trigger" and the iterations are the
  //    work the cap is meant to bound.
  const wallClockStop = checkWallClockCap(session, config.wallClockCapMinutes, now);
  if (wallClockStop !== null) {
    return wallClockStop;
  }

  // 4. Token-spend cap.
  //    Fires when the sum of editor and reviewer token spend meets or
  //    exceeds the cap. Preview-infra cost is *not* included: the
  //    requirement (8.4) names the token-spend cap, and infra cost is
  //    governed by separate billing-alarm guardrails (see runbook).
  const tokens =
    session.costs.editorTokensUSD + session.costs.reviewerTokensUSD;
  if (tokens >= config.tokenSpendCapUSD) {
    return { reason: "token-cap" };
  }

  // 5. Oscillation.
  //    Last in the order because it is the most heuristic and the most
  //    expensive to compute (walks recent iterations). When the cheaper
  //    caps fire on the same turn, they win.
  if (
    detectOscillation(
      session.iterations,
      config.oscillation.sameDiffWindow,
      config.oscillation.alternationWindow
    )
  ) {
    return { reason: "oscillation" };
  }

  return null;
}

/**
 * Pure oscillation detector.
 *
 * Two heuristics, both gated on having enough iterations to evaluate the
 * relevant window. They are independent OR'd checks: either one firing
 * is enough to declare oscillation.
 *
 * Heuristic A — "same diff produced twice in the last `sameDiffWindow`
 * iterations":
 *   Look at the last `sameDiffWindow` iterations. For each iteration,
 *   build a stable string from its edits' diffs (joined in order). If
 *   any two iterations in the window share that string, oscillation is
 *   declared. The default window is 3 (per `agent-harness.config.json`),
 *   so the agent is allowed two distinct attempts before a repeat trips
 *   the detector.
 *
 *   We compare the joined-diff string, not individual edits, because an
 *   "iteration" the agent performs is the unit of work. Two iterations
 *   that produce identical sets of edits are doing the same thing
 *   regardless of how many files they touch.
 *
 * Heuristic B — "alternation across the last `alternationWindow`
 * iterations":
 *   Look at the last `alternationWindow` iterations. Build a stable
 *   `(computational + reviewer)` state hash for each. If the window is
 *   ≥ 4 and the hashes form an A,B,A,B,... pattern with exactly two
 *   distinct values, oscillation is declared. The default window is 4.
 *
 *   We hash the gate results (not the diffs) because the alternation
 *   case the design names is the agent flipping between "this fixes
 *   sensor X but breaks sensor Y" and the reverse. The diffs differ
 *   each iteration; the *outcome* of the gates is what alternates.
 *
 * Empty / short sessions never trip the detector. Iterations with no
 * recorded edits and no recorded gate results contribute the empty
 * string and an empty hash respectively; that's fine — two adjacent
 * empty iterations will trip heuristic A, which is appropriate (the
 * loop did nothing twice in a row).
 *
 * Window arguments must be positive integers. Non-positive windows
 * disable the corresponding heuristic; that lets a forker turn either
 * branch off via configuration without code changes.
 */
export function detectOscillation(
  iterations: ReadonlyArray<IterationRecord>,
  sameDiffWindow: number,
  alternationWindow: number
): boolean {
  if (sameDiffWindow > 0 && sameDiffSeenTwiceInWindow(iterations, sameDiffWindow)) {
    return true;
  }
  if (
    alternationWindow > 0 &&
    alternationAcrossWindow(iterations, alternationWindow)
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internal: wall-clock check
// ---------------------------------------------------------------------------

/**
 * Wall-clock-cap helper. Returns the stop condition when the elapsed
 * time since the first iteration started meets or exceeds the cap, else
 * `null`.
 *
 * If the session has no iterations yet, the wall-clock cap cannot fire
 * (the loop has not started doing work). The caller may still terminate
 * for other reasons (e.g., the iteration cap is zero).
 */
function checkWallClockCap(
  session: Session,
  wallClockCapMinutes: number,
  now: Date
): StopCondition {
  const firstIteration = session.iterations[0];
  if (firstIteration === undefined) {
    return null;
  }
  const startedAtMs = Date.parse(firstIteration.startedAt);
  if (Number.isNaN(startedAtMs)) {
    // Malformed timestamp. Fail closed: terminate so the runbook entry
    // surfaces, rather than silently treating the iteration as new.
    throw new Error(
      `wall-clock cap check: iteration[0].startedAt is not a valid ISO timestamp: ${firstIteration.startedAt}`
    );
  }
  const elapsedMinutes = (now.getTime() - startedAtMs) / 60_000;
  if (elapsedMinutes >= wallClockCapMinutes) {
    return { reason: "wall-clock-cap" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal: oscillation heuristics
// ---------------------------------------------------------------------------

/**
 * Heuristic A. True iff among the last `window` iterations, at least two
 * have identical joined-diff strings.
 *
 * Requires the window to be fully populated: with fewer than `window`
 * iterations, we don't have enough history to declare a repeat. This is
 * conservative on purpose — early iterations should not trip
 * oscillation because the agent is still exploring.
 */
function sameDiffSeenTwiceInWindow(
  iterations: ReadonlyArray<IterationRecord>,
  window: number
): boolean {
  if (iterations.length < window) {
    return false;
  }
  const tail = iterations.slice(iterations.length - window);
  const seen = new Set<string>();
  for (const it of tail) {
    const key = joinedDiff(it);
    if (seen.has(key)) {
      return true;
    }
    seen.add(key);
  }
  return false;
}

/**
 * Heuristic B. True iff the last `window` iterations strictly alternate
 * between exactly two distinct `(computational + reviewer)` state hashes.
 *
 * Requires `window >= 2` to be meaningful and `window >= 4` to match the
 * design's intent (alternating across the last four iterations). We
 * accept any `window >= 2` so a forker can tighten the heuristic
 * without code changes; with `window = 2` the heuristic reduces to
 * "the last two iterations had the same gate outcomes," which is
 * effectively the same as heuristic A on the gate dimension.
 *
 * The check:
 *   1. Take the last `window` iterations.
 *   2. Compute each iteration's `(computational + reviewer)` hash.
 *   3. Confirm there are exactly two distinct hashes.
 *   4. Confirm the sequence alternates: tail[0] != tail[1],
 *      tail[i] == tail[i-2] for all i >= 2.
 *
 * If any of those conditions fails, the heuristic does not fire.
 */
function alternationAcrossWindow(
  iterations: ReadonlyArray<IterationRecord>,
  window: number
): boolean {
  if (window < 2) {
    return false;
  }
  if (iterations.length < window) {
    return false;
  }
  const tail = iterations.slice(iterations.length - window);
  const hashes = tail.map(gateStateHash);

  // Must alternate strictly: adjacent hashes differ; same-position-mod-2
  // hashes match.
  for (let i = 1; i < hashes.length; i += 1) {
    if (hashes[i] === hashes[i - 1]) {
      return false;
    }
    if (i >= 2 && hashes[i] !== hashes[i - 2]) {
      return false;
    }
  }
  // Exactly two distinct values.
  const distinct = new Set(hashes);
  return distinct.size === 2;
}

/**
 * Build a stable string representing an iteration's edits. The order of
 * edits matters (an agent that produces edit A then edit B is doing
 * something different from an agent that produces B then A), so we
 * concatenate in array order with a separator that cannot appear in a
 * unified diff (`\u0001` is a control character; diffs are text).
 *
 * The path is included in the key so an iteration that writes the same
 * diff text to two different files is distinguishable from one that
 * writes it to a single file twice.
 */
function joinedDiff(iteration: IterationRecord): string {
  if (iteration.edits.length === 0) {
    return "";
  }
  const parts: string[] = [];
  for (const edit of iteration.edits) {
    parts.push(edit.path);
    parts.push(edit.diff);
  }
  return parts.join("\u0001");
}

/**
 * Build a stable string representing an iteration's `(computational +
 * reviewer)` state. We use `JSON.stringify` with sorted keys so two
 * iterations whose results differ only in property order still hash to
 * the same value. Sensor results are JSON-shaped per `design.md` Data
 * Models, so JSON serialisation is faithful.
 *
 * Iterations whose gates have not yet run (all `null`) hash to a stable
 * "empty" string. Two consecutive empty iterations do not trip
 * heuristic B on their own (the alternation requires two *distinct*
 * states), but they will trip heuristic A.
 */
function gateStateHash(iteration: IterationRecord): string {
  return stableStringify({
    computational: iteration.computational,
    reviewer: iteration.reviewer,
  });
}

/**
 * `JSON.stringify` with sorted object keys. Recursively walks the input
 * so nested objects also serialise deterministically. Arrays preserve
 * order (an array's order is meaningful).
 *
 * We don't pull in a dependency for this; the implementation is small
 * and the wider package keeps a low dependency footprint.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      const obj = v as Record<string, unknown>;
      for (const key of Object.keys(obj).sort()) {
        sorted[key] = obj[key];
      }
      return sorted;
    }
    return v;
  });
}

// ---------------------------------------------------------------------------
// Internal: config validation
// ---------------------------------------------------------------------------

/**
 * Reject configurations that would lead to nonsensical behaviour. The
 * loop runner is the only caller; a malformed config here is a
 * dispatcher bug, not user input. Throwing is the right response.
 *
 * Negative or non-finite caps would silently disable a guard; we'd
 * rather fail loudly. Zero caps are allowed (a `iterationCap = 0` means
 * "halt before the first iteration runs," which is a legitimate
 * configuration even if uncommon).
 */
function validateConfig(config: StopConditionConfig): void {
  requireNonNegativeFinite("iterationCap", config.iterationCap);
  requireNonNegativeFinite("wallClockCapMinutes", config.wallClockCapMinutes);
  requireNonNegativeFinite("tokenSpendCapUSD", config.tokenSpendCapUSD);
  requireNonNegativeInt("oscillation.sameDiffWindow", config.oscillation.sameDiffWindow);
  requireNonNegativeInt(
    "oscillation.alternationWindow",
    config.oscillation.alternationWindow
  );
}

function requireNonNegativeFinite(field: string, n: number): void {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    throw new Error(`stop-condition config: ${field} must be a non-negative finite number, got ${n}`);
  }
}

function requireNonNegativeInt(field: string, n: number): void {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`stop-condition config: ${field} must be a non-negative integer, got ${n}`);
  }
}
