/**
 * Session-update logic for the bounded loop runner.
 *
 * The session record is the durable record of one trigger's lifetime, as
 * pinned by `design.md` "Session contract" (see the reference shape
 * reproduced in the `Session` type below). The harness writes; the editor
 * reads. Every iteration appends one `IterationRecord`; on termination the
 * harness writes a `TerminationRecord` and the per-session cost totals are
 * finalised.
 *
 * This module exports four pieces:
 *
 *   1. The Session-contract types (`Session`, `IterationRecord`,
 *      `TerminationRecord`, supporting structures). These are the
 *      JSON-shaped wire format every consumer of the session log reads.
 *
 *   2. A `SessionStore` interface plus two implementations:
 *      - `InMemorySessionStore` for tests and dev runs.
 *      - `AgentCoreSessionStore` (stub) for production wiring; the
 *        AgentCore-backed implementation is filled in by a later task.
 *
 *   3. The `SessionUpdater` class. Holds a `Session` in memory and exposes
 *      the mutation surface the loop runner uses. Also implements both
 *      `SessionSink` and `CostCounter` from `@agent-harness/shared` so the
 *      tool wrappers can write directly into it.
 *
 *   4. `createSessionFromTrigger(trigger)`: builds an initial `Session`
 *      from a trigger payload, redacting secrets via the shared `redact`
 *      helper.
 *
 * Why a class rather than a bag of functions?
 * The mutation surface is small and stateful: every method either appends
 * to `iterations[]`, sets `termination`, or ticks `costs`. A class makes
 * the invariants explicit (no orphan tool records, no double termination)
 * and gives the wrapper layer a single object to wire `SessionSink` and
 * `CostCounter` to. The storage backend is split out as a separate
 * `SessionStore` interface so the updater stays purely in-memory and the
 * persistence concern doesn't bleed in.
 *
 * Secrets handling
 * The trigger payload carries `auth.githubInstallationToken` (and possibly
 * other short-lived secrets in future shapes). Per `design.md` Security
 * Considerations, these MUST NOT survive into the session record. The
 * updater redacts the trigger up-front in `createSessionFromTrigger` and
 * redacts every tool record's input/output again on append (defence in
 * depth: the wrapper already redacts before calling `appendToolRecord`,
 * but a future caller bypassing the wrapper still gets safe storage).
 */

import { redact } from "@agent-harness/shared/src/redact";
import type {
  CostCounter,
  SessionSink,
  ToolInvocationRecord,
} from "@agent-harness/shared";

// ---------------------------------------------------------------------------
// Session contract types
// ---------------------------------------------------------------------------

/**
 * Termination reasons the loop runner can record. Mirrors the deterministic
 * order of the stop-condition checker (`design.md` Behavioural design):
 * success, then iteration cap, then wall-clock cap, then token cap, then
 * kill switch, then oscillation. Additional reasons (e.g.,
 * `reviewer-unavailable`, `model-error`) are not yet wired by the loop;
 * when they are introduced, the union widens here and every renderer
 * (PR body, runbook) updates with it.
 */
export type TerminationReason =
  | "success"
  | "iteration-cap"
  | "wall-clock-cap"
  | "token-cap"
  | "kill-switch"
  | "oscillation";

/**
 * The trigger payload as stored in the session record.
 *
 * Mirrors the wire shape in `design.md` "Trigger payload" with one
 * difference: the `auth` field is replaced with a redacted shape, since
 * the original token must not survive into the session record. The redact
 * helper replaces the value with the `[REDACTED]` sentinel; the field is
 * preserved so auditors can see that auth was present without ever
 * seeing its value.
 *
 * The type is open (`Record<string, unknown>` for `issue.body` etc.) on
 * purpose: spec 2's `fitness-gap` trigger reuses the same shape with an
 * additional `originatingFinding` object, and we don't want the loop
 * package to know about that schema. The loop keeps a structural
 * contract; the agent-side schema validation lives in the dispatcher.
 */
export interface SessionTrigger {
  readonly schemaVersion: string;
  readonly triggerType: string;
  readonly issue: {
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly url: string;
    readonly openedBy: string;
  };
  readonly module: {
    readonly path: string;
    readonly repository: string;
    readonly ref: string;
    readonly commitSha: string;
  };
  readonly session: {
    readonly id: string;
    readonly createdAt: string;
  };
  readonly limits: {
    readonly iterationCap: number;
    readonly wallClockCapMinutes: number;
    readonly tokenSpendCapUSD: number;
  };
  /**
   * Auth block. Redacted in the stored session: every field's value is
   * replaced with `[REDACTED]` by `createSessionFromTrigger`.
   *
   * Typed as `Record<string, unknown>` so the redacted shape (string
   * sentinels) and the original input shape (real tokens, never stored)
   * both fit. Callers should not read `auth` from the session record;
   * they should re-mint a token from the issue's installation if they
   * need one.
   */
  readonly auth: Record<string, unknown>;
  /**
   * Open extension slot for additional fields a forker may add to the
   * trigger payload (e.g., `originatingFinding` in spec 2). The loop
   * stores them as-is, after redaction.
   */
  readonly [key: string]: unknown;
}

/**
 * A single iteration of the loop, recorded into the session.
 *
 * The fields match `design.md` "Session contract" exactly. Unset fields
 * are `null` rather than missing so consumers can rely on the shape
 * regardless of how far the iteration progressed.
 */
export interface IterationRecord {
  readonly index: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly edits: ReadonlyArray<{ readonly path: string; readonly diff: string }>;
  readonly computational: {
    readonly cdkNag: { readonly findings: ReadonlyArray<unknown>; readonly passed: boolean } | null;
    readonly tsc: { readonly errors: ReadonlyArray<unknown>; readonly passed: boolean } | null;
    readonly eslint: { readonly findings: ReadonlyArray<unknown>; readonly passed: boolean } | null;
    readonly unitTests: { readonly results: ReadonlyArray<unknown>; readonly passed: boolean } | null;
  };
  readonly reviewer: {
    readonly findings: ReadonlyArray<unknown>;
    readonly passed: boolean;
    readonly severityCounts: Readonly<Record<string, number>>;
  } | null;
  readonly deploy: { readonly outcome: string; readonly logs: string; readonly stackOutputs?: Record<string, string> } | null;
  readonly postDeploy: { readonly outcome: string; readonly report: Record<string, unknown> } | null;
  /**
   * Tool invocation records the wrapper layer wrote during this iteration.
   *
   * The `design.md` "Session contract" example does not surface
   * tool-level records explicitly because the higher-level fields
   * (`computational`, `reviewer`, `deploy`, `postDeploy`) are derived from
   * them. Storing the raw records is non-negotiable for two reasons:
   *
   *   1. The wrapper layer's `SessionSink.appendToolRecord` contract
   *      promises that every tool call gets logged, including rejections.
   *      The session record is where those land.
   *   2. Replay tests and the runbook's failure-diagnosis guidance both
   *      rely on the tool-level history (e.g., "the agent tried to write
   *      an out-of-scope path three times in a row").
   *
   * The field is `readonly` from outside but the updater appends to it
   * via `appendToolRecord`. Concretely it's a mutable array internally;
   * the type system reflects the public contract.
   */
  readonly tools: ReadonlyArray<ToolInvocationRecord>;
}

/** Termination record. Written exactly once per session. */
export interface TerminationRecord {
  readonly reason: TerminationReason;
  readonly endedAt: string;
  readonly prNumber: number | null;
}

/** Per-session cost totals. Mirrors `design.md` Session contract. */
export interface SessionCosts {
  readonly editorTokensUSD: number;
  readonly reviewerTokensUSD: number;
  readonly previewInfraUSD: number;
}

/**
 * The full session record. JSON-shaped; safe to `JSON.stringify` for
 * the storage backend.
 *
 * `iterations[]` and `termination` mutate over the lifetime of a session;
 * everything else is set at creation time. The updater is the only writer.
 */
export interface Session {
  readonly schemaVersion: "1.0";
  readonly trigger: SessionTrigger;
  readonly iterations: ReadonlyArray<IterationRecord>;
  readonly termination: TerminationRecord | null;
  readonly costs: SessionCosts;
}

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

/**
 * Persistent backend the loop reads from and writes to.
 *
 * `read(sessionId)` returns the current session record; throws if the
 * session does not exist (callers should check via the trigger payload
 * before reading).
 *
 * `write(session)` is the durable-write call. Implementations should treat
 * it as idempotent: the loop may write the same session repeatedly across
 * iterations, and a successful write must replace the prior record under
 * the same `session.trigger.session.id` key.
 *
 * The contract intentionally does not expose an "append" primitive. The
 * updater accumulates state in memory and writes the full session on each
 * commit; this keeps the AgentCore-backed implementation simple (one
 * blob per session) and the in-memory implementation trivial.
 */
export interface SessionStore {
  read(sessionId: string): Promise<Session>;
  write(session: Session): Promise<void>;
}

/**
 * In-memory store for tests and dev runs. Not safe for concurrent writers
 * across multiple processes. Sufficient for single-process orchestration
 * (which is what the loop runner is).
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  public async read(sessionId: string): Promise<Session> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`session not found: ${sessionId}`);
    }
    // Return a structural clone so the caller cannot mutate stored state
    // by reference. The store is the source of truth between writes.
    return cloneSession(session);
  }

  public async write(session: Session): Promise<void> {
    // Clone on write as well so a later mutation by the caller does not
    // poison the stored copy.
    this.sessions.set(session.trigger.session.id, cloneSession(session));
  }

  /** Test helper: drop all stored sessions. Not part of the interface. */
  public clear(): void {
    this.sessions.clear();
  }
}

/**
 * Stub implementation of an AgentCore-backed session store.
 *
 * The real implementation goes through AgentCore's session API (the
 * runtime-harness layer's durable storage). It is deferred to a later
 * task because (a) AgentCore wiring is environment-dependent and (b) the
 * in-memory implementation covers the loop's correctness needs and the
 * test surface.
 *
 * The stub exists so the loop runner's wiring code can name the type
 * today; instantiation throws so anyone reaching for it in production
 * gets a loud signal rather than silent persistence loss.
 */
export class AgentCoreSessionStore implements SessionStore {
  public constructor() {
    throw new Error(
      "AgentCoreSessionStore is not yet implemented. Use InMemorySessionStore for now; " +
        "wire AgentCore session storage in a follow-up task."
    );
  }

  public async read(_sessionId: string): Promise<Session> {
    throw new Error("AgentCoreSessionStore.read is not implemented");
  }

  public async write(_session: Session): Promise<void> {
    throw new Error("AgentCoreSessionStore.write is not implemented");
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Build the initial session record from a trigger payload.
 *
 * Redacts every secret-bearing field (`auth.githubInstallationToken`,
 * anything else the shared `redact` helper recognises) before storing.
 * The redaction is structural: the field is preserved, but its value is
 * replaced with `[REDACTED]`. The session record never contains the
 * literal token.
 *
 * `iterations` starts empty; `termination` is `null`; `costs` are zeroed.
 */
export function createSessionFromTrigger(trigger: SessionTrigger): Session {
  // Deep-clone-and-redact in one pass. The trigger may carry extension
  // fields a forker added; the redact helper walks the whole tree and
  // sanitises them too.
  const redactedTrigger = redact(trigger) as SessionTrigger;
  return {
    schemaVersion: "1.0",
    trigger: redactedTrigger,
    iterations: [],
    termination: null,
    costs: { editorTokensUSD: 0, reviewerTokensUSD: 0, previewInfraUSD: 0 },
  };
}

// ---------------------------------------------------------------------------
// SessionUpdater
// ---------------------------------------------------------------------------

/**
 * Input the loop runner passes when starting a new iteration. The updater
 * fills in the `index`, `startedAt`, and the empty containers.
 *
 * Everything else (edits, computational results, reviewer findings, deploy
 * outcome, post-deploy outcome) lands on the iteration via the dedicated
 * setters once the iteration's gates run.
 */
export interface AppendIterationInput {
  /**
   * Optional pre-set ISO start time. Defaults to the updater's `now()`
   * helper. Tests inject a fixed clock; production lets the default fire.
   */
  readonly startedAt?: string;
}

/**
 * Holds a session in memory, exposes the mutation surface the loop runner
 * needs, and implements `SessionSink` and `CostCounter` so the wrapper
 * layer can write directly into the live iteration.
 *
 * Lifecycle:
 *
 *   const updater = new SessionUpdater(createSessionFromTrigger(trigger));
 *   await store.write(updater.getSession());
 *
 *   // each iteration:
 *   updater.appendIteration();
 *   await runTools(updater);    // the runtime wires `updater` as both
 *                                // `sessionSink` and `costCounter`
 *   updater.recordComputational(...);
 *   updater.recordReviewer(...);
 *   updater.recordDeploy(...);
 *   updater.recordPostDeploy(...);
 *   updater.completeIteration();
 *   await store.write(updater.getSession());
 *
 *   // on stop:
 *   updater.terminate("success", prNumber);
 *   await store.write(updater.getSession());
 */
export class SessionUpdater implements SessionSink, CostCounter {
  /**
   * Internal mutable state. The session contract types are `readonly` to
   * enforce immutability for consumers; internally we keep a mutable view
   * so we can append to `iterations[]` and reassign `termination` and
   * `costs` without rebuilding the whole tree on every change.
   */
  private session: MutableSession;

  /**
   * Optional time source. Defaults to `() => new Date().toISOString()`.
   * Tests inject a fixed clock to make iteration timestamps deterministic.
   */
  private readonly now: () => string;

  public constructor(initial: Session, options: { now?: () => string } = {}) {
    this.session = toMutableSession(initial);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  // -------------------------------------------------------------------------
  // Iteration management
  // -------------------------------------------------------------------------

  /**
   * Append a new iteration. The new iteration becomes the "current" one;
   * subsequent record-* calls and tool records land on it.
   *
   * Throws if the session has already been terminated. Once
   * `termination` is set, the loop is over; appending an iteration is a
   * programmer error and silent acceptance would corrupt the audit log.
   */
  public appendIteration(input: AppendIterationInput = {}): IterationRecord {
    if (this.session.termination !== null) {
      throw new Error(
        `cannot appendIteration: session ${this.session.trigger.session.id} is already terminated ` +
          `(reason=${this.session.termination.reason})`
      );
    }
    const iteration: MutableIterationRecord = {
      index: this.session.iterations.length,
      startedAt: input.startedAt ?? this.now(),
      endedAt: null,
      edits: [],
      computational: {
        cdkNag: null,
        tsc: null,
        eslint: null,
        unitTests: null,
      },
      reviewer: null,
      deploy: null,
      postDeploy: null,
      tools: [],
    };
    this.session.iterations.push(iteration);
    return iteration;
  }

  /**
   * Mark the current iteration's `endedAt`. Called by the loop runner
   * after the iteration's gates have all run (whether they passed or
   * failed). Idempotent: callable multiple times with the latest call
   * winning, so a partial iteration that gets a final record after a
   * sensor failure still ends up with a sensible timestamp.
   */
  public completeIteration(endedAt?: string): void {
    const current = this.requireCurrentIteration("completeIteration");
    current.endedAt = endedAt ?? this.now();
  }

  /** Add a recorded edit to the current iteration. */
  public recordEdit(edit: { path: string; diff: string }): void {
    const current = this.requireCurrentIteration("recordEdit");
    current.edits.push({ path: edit.path, diff: edit.diff });
  }

  /** Set one of the four computational sensor results on the current iteration. */
  public recordComputational<K extends keyof IterationRecord["computational"]>(
    sensor: K,
    result: NonNullable<IterationRecord["computational"][K]>
  ): void {
    const current = this.requireCurrentIteration("recordComputational");
    // Cast: `result` was constrained to the matching sensor's shape above.
    (current.computational as Record<string, unknown>)[sensor] = redact(result);
  }

  /** Set the reviewer result on the current iteration. */
  public recordReviewer(result: NonNullable<IterationRecord["reviewer"]>): void {
    const current = this.requireCurrentIteration("recordReviewer");
    current.reviewer = redact(result) as MutableIterationRecord["reviewer"];
  }

  /** Set the deploy result on the current iteration. */
  public recordDeploy(result: NonNullable<IterationRecord["deploy"]>): void {
    const current = this.requireCurrentIteration("recordDeploy");
    current.deploy = redact(result) as MutableIterationRecord["deploy"];
  }

  /** Set the post-deploy result on the current iteration. */
  public recordPostDeploy(result: NonNullable<IterationRecord["postDeploy"]>): void {
    const current = this.requireCurrentIteration("recordPostDeploy");
    current.postDeploy = redact(result) as MutableIterationRecord["postDeploy"];
  }

  // -------------------------------------------------------------------------
  // SessionSink implementation
  // -------------------------------------------------------------------------

  /**
   * Append a tool invocation record to the current iteration's `tools`
   * array. This is the entry point the wrapper layer uses for every tool
   * call (success or failure).
   *
   * If no iteration has been appended yet, the call throws. The loop
   * runner is responsible for calling `appendIteration()` before any
   * tools run; a tool record arriving before the first iteration is a
   * runner bug.
   *
   * The wrapper has already redacted the record before calling here, but
   * we redact again as a defence-in-depth measure: if a future caller
   * reaches `appendToolRecord` without going through the wrapper, the
   * stored record is still safe.
   */
  public async appendToolRecord(record: ToolInvocationRecord): Promise<void> {
    const current = this.requireCurrentIteration("appendToolRecord");
    if (record.iterationIndex !== current.index) {
      // Mismatched iteration index: the runtime is wired wrong. Reject
      // loudly rather than silently associating a tool record with the
      // wrong iteration.
      throw new Error(
        `tool record iterationIndex ${record.iterationIndex} does not match current ` +
          `iteration index ${current.index} (tool=${record.tool})`
      );
    }
    current.tools.push(redactToolRecord(record));
  }

  // -------------------------------------------------------------------------
  // CostCounter implementation
  // -------------------------------------------------------------------------

  /**
   * Add `usd` to the editor + reviewer token total. Per `design.md`'s
   * costs section, both flow into a combined token spend that the
   * stop-condition checker compares against `tokenSpendCapUSD`.
   *
   * The updater attributes all token usage to `editorTokensUSD` because
   * the editor agent is the wrapper-layer caller for every tool that
   * spends tokens (including `reviewer.invoke`). When the reviewer
   * agent's tools eventually flow through their own wrapper runtime
   * (see `agents/reviewer/`), they can call `recordReviewerTokens`
   * directly. For now the entry point is single.
   */
  public recordTokenUsage(usd: number): void {
    requireNonNegative("recordTokenUsage", usd);
    this.session.costs = {
      ...this.session.costs,
      editorTokensUSD: this.session.costs.editorTokensUSD + usd,
    };
  }

  /**
   * Explicit reviewer-token entry point. Used by the reviewer wrapper
   * (which has its own `WrapperRuntime` distinct from the editor's) so
   * the totals stay split.
   */
  public recordReviewerTokens(usd: number): void {
    requireNonNegative("recordReviewerTokens", usd);
    this.session.costs = {
      ...this.session.costs,
      reviewerTokensUSD: this.session.costs.reviewerTokensUSD + usd,
    };
  }

  /** Add `usd` to the deploy/preview infra cost total. */
  public recordDeployCost(usd: number): void {
    requireNonNegative("recordDeployCost", usd);
    this.session.costs = {
      ...this.session.costs,
      previewInfraUSD: this.session.costs.previewInfraUSD + usd,
    };
  }

  // -------------------------------------------------------------------------
  // Termination
  // -------------------------------------------------------------------------

  /**
   * Write the termination record. Idempotent only insofar as the same
   * reason can be written twice (the second write is a no-op if reason
   * and prNumber match). Writing a different reason throws: a session can
   * terminate exactly once.
   *
   * `prNumber` is `null` when the loop terminated before a PR was opened.
   * The dispatcher may follow up with a partial PR and call
   * `setTerminationPRNumber` once the PR exists.
   */
  public terminate(reason: TerminationReason, prNumber: number | null = null): void {
    const endedAt = this.now();
    if (this.session.termination !== null) {
      const existing = this.session.termination;
      if (existing.reason === reason && existing.prNumber === prNumber) {
        // Idempotent re-write of the same termination — accept silently.
        return;
      }
      throw new Error(
        `cannot terminate: session ${this.session.trigger.session.id} is already terminated ` +
          `(reason=${existing.reason}); refusing to overwrite with reason=${reason}`
      );
    }
    this.session.termination = { reason, endedAt, prNumber };
  }

  /**
   * Update the termination's `prNumber` after the partial PR has been
   * opened. Allowed only if the session is already terminated and the
   * existing `prNumber` is `null` (so a real number cannot be silently
   * replaced).
   */
  public setTerminationPRNumber(prNumber: number): void {
    if (this.session.termination === null) {
      throw new Error(
        `cannot setTerminationPRNumber: session ${this.session.trigger.session.id} has not terminated yet`
      );
    }
    if (this.session.termination.prNumber !== null) {
      throw new Error(
        `cannot setTerminationPRNumber: prNumber already set to ${this.session.termination.prNumber}`
      );
    }
    this.session.termination = { ...this.session.termination, prNumber };
  }

  // -------------------------------------------------------------------------
  // Read-back
  // -------------------------------------------------------------------------

  /**
   * Return a deep clone of the current session state, suitable for
   * passing to `SessionStore.write`. Cloning means a later mutation by
   * the updater does not poison the stored copy via shared references.
   */
  public getSession(): Session {
    return cloneSession(this.session);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private requireCurrentIteration(method: string): MutableIterationRecord {
    const current = this.session.iterations[this.session.iterations.length - 1];
    if (current === undefined) {
      throw new Error(
        `cannot ${method}: session ${this.session.trigger.session.id} has no iterations yet ` +
          `(call appendIteration() first)`
      );
    }
    return current;
  }
}

// ---------------------------------------------------------------------------
// Internal mutable shapes
// ---------------------------------------------------------------------------
//
// The Session-contract types are `readonly` everywhere because consumers
// should treat them as immutable views. Internally we need to mutate
// `iterations[]` and `termination`; these mutable mirrors give us a
// place to do that without sprinkling `as` casts through the updater.
//
// The mirror is not exported. `cloneSession` and `toMutableSession`
// bridge between the two.

interface MutableIterationRecord {
  index: number;
  startedAt: string;
  endedAt: string | null;
  edits: Array<{ path: string; diff: string }>;
  computational: {
    cdkNag: { findings: ReadonlyArray<unknown>; passed: boolean } | null;
    tsc: { errors: ReadonlyArray<unknown>; passed: boolean } | null;
    eslint: { findings: ReadonlyArray<unknown>; passed: boolean } | null;
    unitTests: { results: ReadonlyArray<unknown>; passed: boolean } | null;
  };
  reviewer: {
    findings: ReadonlyArray<unknown>;
    passed: boolean;
    severityCounts: Readonly<Record<string, number>>;
  } | null;
  deploy: { outcome: string; logs: string; stackOutputs?: Record<string, string> } | null;
  postDeploy: { outcome: string; report: Record<string, unknown> } | null;
  tools: ToolInvocationRecord[];
}

interface MutableSession {
  schemaVersion: "1.0";
  trigger: SessionTrigger;
  iterations: MutableIterationRecord[];
  termination: TerminationRecord | null;
  costs: SessionCosts;
}

function toMutableSession(session: Session): MutableSession {
  return {
    schemaVersion: session.schemaVersion,
    trigger: session.trigger,
    iterations: session.iterations.map((it) => ({
      index: it.index,
      startedAt: it.startedAt,
      endedAt: it.endedAt,
      edits: it.edits.map((e) => ({ path: e.path, diff: e.diff })),
      computational: {
        cdkNag: it.computational.cdkNag,
        tsc: it.computational.tsc,
        eslint: it.computational.eslint,
        unitTests: it.computational.unitTests,
      },
      reviewer: it.reviewer,
      deploy: it.deploy,
      postDeploy: it.postDeploy,
      tools: [...it.tools],
    })),
    termination: session.termination,
    costs: session.costs,
  };
}

/**
 * Deep clone a session for safe handoff to the store or the caller. Uses
 * `structuredClone` (Node 17+) which handles JSON-shaped data and
 * preserves the structure without serialising through a string.
 */
function cloneSession(session: Session | MutableSession): Session {
  return structuredClone(session) as Session;
}

// ---------------------------------------------------------------------------
// Tool record redaction
// ---------------------------------------------------------------------------

/**
 * Redact a tool invocation record's input/output. The wrapper has already
 * done this before calling `appendToolRecord`, so this is a belt-and-
 * braces second pass: a future caller bypassing the wrapper still gets
 * safe storage.
 */
function redactToolRecord(record: ToolInvocationRecord): ToolInvocationRecord {
  return {
    ...record,
    input: redact(record.input),
    ...(record.output !== undefined ? { output: redact(record.output) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function requireNonNegative(method: string, usd: number): void {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) {
    throw new Error(`${method}: usd must be a non-negative finite number, got ${usd}`);
  }
}
