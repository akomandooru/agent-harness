/**
 * Loop entry point for the agent harness.
 *
 * This module is the boundary between the outside world (the GitHub Action
 * calling the AgentCore endpoint) and the bounded loop runner. It:
 *
 *   1. Validates the raw trigger payload against the JSON schema from
 *      `design.md` "Trigger payload". Rejects missing required fields,
 *      wrong types, and unknown `triggerType` values.
 *
 *   2. Creates an initial session from the validated trigger via
 *      `createSessionFromTrigger`.
 *
 *   3. Spawns the loop via `runLoop`.
 *
 *   4. Returns `{ sessionId, prNumber, terminationReason }` to the caller.
 *
 * The entry point is intentionally thin: all loop logic lives in `run.ts`,
 * all session mutation lives in `session.ts`, and all stop-condition logic
 * lives in `stop-conditions.ts`. This module only wires them together and
 * owns the schema-validation boundary.
 *
 * Requirements: 1.3, 9.5
 */

import Ajv from "ajv";
import {
  createSessionFromTrigger,
  type SessionStore,
  type SessionTrigger,
} from "./session";
import { runLoop, type LoopGates } from "./run";
import type { StopConditionConfig, KillSwitchPoll } from "./stop-conditions";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for `createLoopEntry`. All dependencies are injected so the
 * entry point is fully testable without real AWS, GitHub, or AgentCore
 * traffic.
 */
export interface LoopEntryOptions {
  /** Persistent backend for the session record. */
  readonly store: SessionStore;
  /** Stop-condition configuration from `agent-harness.config.json`. */
  readonly config: StopConditionConfig;
  /** Kill-switch poll (GitHub label check in production; stub in tests). */
  readonly killSwitchPoll: KillSwitchPoll;
  /** All gate implementations (editor, sensors, reviewer, deploy, etc.). */
  readonly gates: LoopGates;
  /**
   * Injectable clock. Defaults to `() => new Date()`. Tests inject a
   * fixed clock to make wall-clock checks deterministic.
   */
  readonly clock?: () => Date;
}

/**
 * Result returned by the loop entry handler after the loop terminates.
 */
export interface LoopEntryResult {
  /** The session id from the trigger payload. */
  readonly sessionId: string;
  /** The PR number opened on termination, or `null` if PR creation failed. */
  readonly prNumber: number | null;
  /** The reason the loop terminated. */
  readonly terminationReason: string;
}

/**
 * The async handler function returned by `createLoopEntry`.
 *
 * Accepts a raw (unvalidated) payload, validates it, runs the loop, and
 * returns the result. Throws on invalid payloads.
 */
export type LoopEntryHandler = (rawPayload: unknown) => Promise<LoopEntryResult>;

// ---------------------------------------------------------------------------
// JSON schema for the trigger payload
// ---------------------------------------------------------------------------

/**
 * JSON Schema (draft-07) for the trigger payload shape from `design.md`.
 *
 * Validates:
 *   - All required top-level fields are present and correctly typed.
 *   - `triggerType` is one of the known values ("feature-change").
 *   - Nested objects (`issue`, `module`, `session`, `limits`, `auth`) have
 *     all required fields with the correct types.
 *   - Numeric fields (`issue.number`, `limits.*`) are numbers.
 *
 * Additional properties are allowed at the top level and in `auth` to
 * support the extension slot described in `design.md` (spec 2's
 * `originatingFinding`, forker-added auth fields, etc.).
 */
const TRIGGER_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: [
    "schemaVersion",
    "triggerType",
    "issue",
    "module",
    "session",
    "limits",
    "auth",
  ],
  additionalProperties: true,
  properties: {
    schemaVersion: {
      type: "string",
      minLength: 1,
    },
    triggerType: {
      type: "string",
      enum: ["feature-change"],
    },
    issue: {
      type: "object",
      required: ["number", "title", "body", "url", "openedBy"],
      additionalProperties: false,
      properties: {
        number: { type: "number" },
        title: { type: "string" },
        body: { type: "string" },
        url: { type: "string" },
        openedBy: { type: "string" },
      },
    },
    module: {
      type: "object",
      required: ["path", "repository", "ref", "commitSha"],
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        repository: { type: "string" },
        ref: { type: "string" },
        commitSha: { type: "string" },
      },
    },
    session: {
      type: "object",
      required: ["id", "createdAt"],
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1 },
        createdAt: { type: "string" },
      },
    },
    limits: {
      type: "object",
      required: ["iterationCap", "wallClockCapMinutes", "tokenSpendCapUSD"],
      additionalProperties: false,
      properties: {
        iterationCap: { type: "number" },
        wallClockCapMinutes: { type: "number" },
        tokenSpendCapUSD: { type: "number" },
      },
    },
    auth: {
      type: "object",
      required: ["githubInstallationToken"],
      additionalProperties: true,
      properties: {
        githubInstallationToken: { type: "string" },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// AJV instance (module-level singleton; compile once, reuse)
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true });
const validateSchema = ajv.compile(TRIGGER_SCHEMA);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a raw (untyped) payload against the trigger schema.
 *
 * Returns the validated payload cast to `SessionTrigger` on success.
 * Throws a descriptive `Error` on any validation failure, including:
 *   - Missing required fields.
 *   - Wrong types.
 *   - Unknown `triggerType` values.
 *
 * The error message includes the full list of AJV validation errors so
 * the caller (the GitHub Action) can surface a useful failure comment on
 * the issue.
 */
export function validateTriggerPayload(raw: unknown): SessionTrigger {
  if (!validateSchema(raw)) {
    const errors = ajv.errorsText(validateSchema.errors, { separator: "; " });
    throw new Error(`Invalid trigger payload: ${errors}`);
  }
  // The schema validates the shape; cast is safe.
  return raw as unknown as SessionTrigger;
}

/**
 * Factory that returns an async handler function.
 *
 * The handler:
 *   1. Validates the raw payload via `validateTriggerPayload`.
 *   2. Creates a session via `createSessionFromTrigger`.
 *   3. Calls `runLoop` with the session, store, config, killSwitchPoll,
 *      gates, and clock.
 *   4. Returns `{ sessionId, prNumber, terminationReason }`.
 *
 * Separating factory from handler lets the caller wire dependencies once
 * at startup and reuse the handler across multiple triggers without
 * re-constructing the AJV validator or the store on every call.
 */
export function createLoopEntry(options: LoopEntryOptions): LoopEntryHandler {
  const { store, config, killSwitchPoll, gates, clock } = options;

  return async function loopEntryHandler(
    rawPayload: unknown
  ): Promise<LoopEntryResult> {
    // Step 1: Validate the raw payload.
    const trigger = validateTriggerPayload(rawPayload);

    // Step 2: Create the initial session.
    const session = createSessionFromTrigger(trigger);
    const sessionId = trigger.session.id;

    // Step 3: Run the loop.
    const { terminationReason, prNumber } = await runLoop({
      session,
      store,
      config,
      killSwitchPoll,
      gates,
      clock,
    });

    // Step 4: Return the result.
    return { sessionId, prNumber, terminationReason };
  };
}
