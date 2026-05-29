/**
 * Shared types for the tool wrapper plumbing.
 *
 * Every editor and reviewer tool flows through `wrapTool` (see `wrapper.ts`).
 * The wrapper layer is the security boundary: it validates inputs and outputs,
 * enforces path scoping for file tools, redacts secrets in logs, writes
 * structured records to the AgentCore session, and ticks cost counters.
 *
 * Keep this module dependency-light: types and pure interfaces only.
 */

import type { JSONSchemaType, Schema } from "ajv";

/**
 * JSON-schema input/output contract for a tool.
 *
 * Accepts either an Ajv `JSONSchemaType<T>` (preferred when the input type is
 * known statically) or a plain `Schema` (so tools can ship a hand-written
 * JSON Schema document and still pass through the wrapper).
 */
export type ToolSchema<T> = JSONSchemaType<T> | Schema;

/**
 * Identifies the cost category a tool draws against.
 *
 * `none` is the default and skips cost-counter calls entirely.
 * `tokens` is for tools that invoke a model (today: `reviewer.invoke`).
 * `deploy` is for tools that incur AWS infrastructure cost (today: `cdk.deploy`).
 *
 * The wrapper does not estimate cost itself; it calls into the provided
 * `CostCounter` with a USD figure produced by the tool handler's result.
 */
export type CostCategory = "none" | "tokens" | "deploy";

/**
 * Structured cost report emitted by a tool handler, consumed by the wrapper.
 *
 * Tools that don't incur cost simply omit this from their result.
 *
 * `usd` is the dollar amount to add to the appropriate counter.
 * `category` overrides the tool's declared category if present (rare; useful
 * when a tool can charge against either tokens or deploy depending on the
 * operation it performed).
 */
export interface ToolCostReport {
  readonly usd: number;
  readonly category?: CostCategory;
}

/**
 * The tool handler signature. The wrapper invokes this after validation.
 *
 * Handlers MAY attach a `cost` to the returned context object via the
 * `_meta` channel; the wrapper extracts and strips `_meta` before logging
 * the output and returning it to the caller.
 */
export type ToolHandler<TInput, TOutput> = (
  input: TInput,
  context: ToolHandlerContext
) => Promise<ToolHandlerResult<TOutput>>;

/**
 * Context the wrapper gives the handler. The handler can use it to record
 * cost, but it MUST NOT use it to bypass validation or path checks: those
 * have already happened by the time the handler runs.
 */
export interface ToolHandlerContext {
  /** Resolved absolute path of the module root (when path scoping is on). */
  readonly resolvedModuleRoot?: string;
  /**
   * Resolved absolute path of the validated path argument, if the tool
   * declares a `pathField` and the input contained a value for it.
   * Handlers should prefer this over re-resolving the raw input.
   */
  readonly resolvedPath?: string;
  /** Session id from the trigger payload. */
  readonly sessionId: string;
  /** Iteration index the tool call belongs to. */
  readonly iterationIndex: number;
}

/**
 * Result envelope from a tool handler. The output is whatever the tool
 * declared in its output schema; cost (when present) feeds the cost counter.
 */
export interface ToolHandlerResult<TOutput> {
  readonly output: TOutput;
  readonly cost?: ToolCostReport;
}

/**
 * Definition of a tool. Combines the tool's identity, its JSON schemas, its
 * handler, and any wrapper-specific policy.
 */
export interface ToolDefinition<TInput, TOutput> {
  /**
   * Stable name of the tool, e.g. `module.readFile`.
   * Used in logs, metrics, and error messages.
   */
  readonly name: string;
  /**
   * Short human description of what the tool does. Surfaced in error
   * messages so a forker debugging a rejection can find the right tool.
   */
  readonly description?: string;
  /**
   * JSON schema for the tool's input. Required.
   * Inputs that don't validate are rejected before the handler runs.
   */
  readonly inputSchema: ToolSchema<TInput>;
  /**
   * JSON schema for the tool's output. Required.
   * Outputs that don't validate are rejected after the handler runs (the
   * tool failed its contract, not the agent).
   */
  readonly outputSchema: ToolSchema<TOutput>;
  /** The implementation that performs the tool's work. */
  readonly handler: ToolHandler<TInput, TOutput>;
  /**
   * Cost category the tool draws against. Defaults to `none`.
   * Handlers must return a `cost` when the category is `tokens` or `deploy`.
   */
  readonly costCategory?: CostCategory;
  /**
   * If set, the wrapper enforces path scoping on the named field of the
   * input object. The field must be a string and the resolved path must
   * stay inside the module root.
   *
   * Example: for `module.readFile` the field is `"path"`; for `module.diff`
   * (no path argument) it is omitted.
   */
  readonly pathField?: string;
}

/**
 * Configuration the wrapper needs at call time. Provided per invocation so
 * the same `ToolDefinition` can be reused across sessions.
 */
export interface WrapperRuntime {
  /**
   * Module root the tool is scoped to. Must be an absolute path resolved
   * by the caller from `agent-harness.config.json`'s `module.path`.
   */
  readonly moduleRoot: string;
  /** Session sink. The wrapper writes one record per call. */
  readonly sessionSink: SessionSink;
  /** Cost counter. Optional; if omitted, cost reports are dropped. */
  readonly costCounter?: CostCounter;
  /** Identity the session record is keyed against. */
  readonly sessionId: string;
  /** Iteration the call belongs to. */
  readonly iterationIndex: number;
  /**
   * Optional path resolver. Defaults to `fs.realpathSync.native` so the
   * wrapper can reject symlinked components. Tests inject a stub resolver.
   *
   * The resolver receives an absolute path and returns the canonical real
   * path. It MUST throw if the path does not exist (matching `realpathSync`
   * semantics) so the wrapper can convert the error into a `PathScopeError`.
   */
  readonly pathResolver?: (absolutePath: string) => string;
}

/**
 * Structured record written to the session for one tool call.
 *
 * Inputs and outputs are deep-cloned and redacted before they reach the sink,
 * so the sink can serialize them without further sanitisation. Errors are
 * captured with their classification and message, never with the raw secret
 * payload that triggered them.
 */
export interface ToolInvocationRecord {
  readonly schemaVersion: "1.0";
  readonly sessionId: string;
  readonly iterationIndex: number;
  readonly tool: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  /** Sanitised input the tool was called with (post-redaction). */
  readonly input: unknown;
  /** Sanitised output the tool produced (post-redaction). Absent on error. */
  readonly output?: unknown;
  /**
   * Outcome of the call. `ok` means inputs validated, the handler ran, and
   * the output validated. Anything else is a wrapper rejection or a handler
   * error and the call did not return useful data to the agent.
   */
  readonly outcome:
    | "ok"
    | "input-schema-error"
    | "output-schema-error"
    | "path-scope-error"
    | "handler-error";
  /** Human-readable error message. Absent on `ok`. */
  readonly error?: string;
  /** Cost report applied to the counter, if any. Absent on rejection. */
  readonly cost?: ToolCostReport;
}

/**
 * Sink the wrapper writes invocation records to. The orchestrator wires this
 * to AgentCore session storage at runtime; tests use an in-memory array.
 */
export interface SessionSink {
  /**
   * Append a record to the session log. Implementations should be idempotent
   * for retries; the wrapper does not retry on its own.
   *
   * Returning a Promise lets callers do async I/O (e.g., AgentCore's session
   * API). The wrapper awaits this before returning the tool result.
   */
  appendToolRecord(record: ToolInvocationRecord): Promise<void>;
}

/**
 * Cost counter the wrapper updates after a successful tool call. Both
 * methods accept USD as a non-negative number; implementations decide how
 * to aggregate (per iteration or per session is up to the orchestrator).
 *
 * Per Requirement 8.4, when the running total crosses the configured cap
 * the loop terminates with `token-cap`. The counter does not enforce that
 * cap itself; the stop-condition checker reads from it.
 */
export interface CostCounter {
  recordTokenUsage(usd: number): Promise<void> | void;
  recordDeployCost(usd: number): Promise<void> | void;
}
