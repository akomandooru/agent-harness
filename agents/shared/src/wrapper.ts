/**
 * Tool wrapper factory.
 *
 * Public API for the security boundary every editor and reviewer tool flows
 * through. Implements the responsibilities listed in `design.md` "Tool
 * wrappers":
 *
 *   1. Input JSON-schema validation.
 *   2. Path-scope enforcement (when the tool declares `pathField`).
 *   3. Handler invocation with a structured context.
 *   4. Output JSON-schema validation.
 *   5. Cost-counter updates (when the tool declares a non-`none` category).
 *   6. Structured logging to the AgentCore session, with secrets redacted.
 *
 * The wrapper is the only place where the runtime-harness layer
 * (AgentCore-side enforcement, IAM, session storage) and the
 * engineering-harness layer (tool semantics) meet. Keep the rest of the
 * agent code free of wrapper plumbing; everything that needs to be a real
 * boundary lives here.
 *
 * Usage:
 *
 *   const wrapped = wrapTool({
 *     name: "module.readFile",
 *     description: "Read a file inside the CDK module.",
 *     inputSchema: { ... },
 *     outputSchema: { ... },
 *     handler: async (input) => ({ output: await fs.readFile(input.path, "utf8") }),
 *     pathField: "path"
 *   });
 *
 *   const result = await wrapped(input, runtime);
 *
 * The factory returns a function with the signature
 * `(input, runtime) => Promise<TOutput>`. On any rejection or handler
 * error, the wrapper throws (after writing a record to the session sink)
 * so the caller can decide whether to surface the failure to the agent or
 * abort the iteration.
 */

import Ajv, { type Schema, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  HandlerError,
  InputSchemaError,
  OutputSchemaError,
  PathScopeError,
  ToolWrapperError,
} from "./errors";
import { validatePathScope } from "./path-scope";
import { redact } from "./redact";
import type {
  ToolDefinition,
  ToolInvocationRecord,
  WrapperRuntime,
} from "./types";

// Re-export the public surface. Importers should only need `./wrapper`.
export type {
  CostCategory,
  CostCounter,
  SessionSink,
  ToolCostReport,
  ToolDefinition,
  ToolHandler,
  ToolHandlerContext,
  ToolHandlerResult,
  ToolInvocationRecord,
  ToolSchema,
  WrapperRuntime,
} from "./types";

export {
  HandlerError,
  InputSchemaError,
  OutputSchemaError,
  PathScopeError,
  ToolWrapperError,
} from "./errors";

/**
 * A wrapped tool. Returned by `wrapTool`. The agent (or test) calls it as
 * `await wrapped(input, runtime)`; the wrapper handles everything else.
 */
export type WrappedTool<TInput, TOutput> = (
  input: TInput,
  runtime: WrapperRuntime
) => Promise<TOutput>;

/**
 * Compile a `ToolDefinition` into a callable, wrapper-protected function.
 *
 * The Ajv instance is created per-tool so each tool gets its own compiled
 * validators (Ajv cannot share validators across schemas with conflicting
 * `$id`s; per-tool instances are safer than a shared one).
 */
export function wrapTool<TInput, TOutput>(
  definition: ToolDefinition<TInput, TOutput>
): WrappedTool<TInput, TOutput> {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);

  const validateInput = compileSchema<TInput>(
    ajv,
    definition.inputSchema as Schema,
    `${definition.name}.input`
  );
  const validateOutput = compileSchema<TOutput>(
    ajv,
    definition.outputSchema as Schema,
    `${definition.name}.output`
  );

  return async function invoke(
    input: TInput,
    runtime: WrapperRuntime
  ): Promise<TOutput> {
    const startedAt = new Date();
    const startedAtIso = startedAt.toISOString();
    const startedAtMs = startedAt.getTime();

    // Snapshot the redacted input up-front so it lands in the session record
    // even if the call later throws. The handler still gets the original
    // (un-redacted) input — redaction is a logging concern, not a semantic
    // one. The orchestrator may pass `auth.githubInstallationToken` to a
    // handler that needs it; the session log must not contain it.
    const sanitisedInput = redact(input);

    let outcome: ToolInvocationRecord["outcome"] = "ok";
    let errorMessage: string | undefined;
    let sanitisedOutput: unknown;
    let recordedCost: ToolInvocationRecord["cost"];
    let returnValue: TOutput | undefined;
    let thrown: unknown;

    try {
      // Step 1: input schema validation.
      if (!validateInput(input)) {
        throw new InputSchemaError(
          definition.name,
          formatAjvErrors(validateInput)
        );
      }

      // Step 2: path scoping (only when the tool declares `pathField` and
      // the input actually carries a value for that field).
      let resolvedPath: string | undefined;
      if (definition.pathField !== undefined) {
        resolvedPath = enforcePathScope(definition, input, runtime);
      }

      // Step 3: handler invocation.
      const handlerResult = await definition.handler(input, {
        sessionId: runtime.sessionId,
        iterationIndex: runtime.iterationIndex,
        resolvedModuleRoot: runtime.moduleRoot,
        resolvedPath,
      });

      // Step 4: output schema validation.
      if (!validateOutput(handlerResult.output)) {
        throw new OutputSchemaError(
          definition.name,
          formatAjvErrors(validateOutput)
        );
      }

      // Step 5: cost accounting. Tool-declared category is the default;
      // handler can override it per call (rare).
      const declaredCategory = definition.costCategory ?? "none";
      const reportedCost = handlerResult.cost;
      if (reportedCost !== undefined) {
        const category = reportedCost.category ?? declaredCategory;
        const usd = reportedCost.usd;
        if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) {
          // Bad cost report. Don't silently drop it — surface as a handler
          // error so the tool is fixed.
          throw new HandlerError(
            definition.name,
            new Error(
              `tool returned invalid cost report: ${JSON.stringify(reportedCost)}`
            )
          );
        }
        if (category === "tokens" && runtime.costCounter) {
          await runtime.costCounter.recordTokenUsage(usd);
        } else if (category === "deploy" && runtime.costCounter) {
          await runtime.costCounter.recordDeployCost(usd);
        }
        recordedCost = { usd, category };
      }

      sanitisedOutput = redact(handlerResult.output);
      returnValue = handlerResult.output;
    } catch (err) {
      thrown = err;
      if (err instanceof ToolWrapperError) {
        outcome = err.outcome;
        errorMessage = err.message;
      } else {
        // Wrap unexpected handler throws so the session always sees the same
        // shape and the caller still gets a `ToolWrapperError` to discriminate
        // on.
        const wrapped = new HandlerError(definition.name, err);
        outcome = wrapped.outcome;
        errorMessage = wrapped.message;
        thrown = wrapped;
      }
    }

    const endedAt = new Date();
    const record: ToolInvocationRecord = {
      schemaVersion: "1.0",
      sessionId: runtime.sessionId,
      iterationIndex: runtime.iterationIndex,
      tool: definition.name,
      startedAt: startedAtIso,
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAtMs,
      input: sanitisedInput,
      ...(sanitisedOutput !== undefined ? { output: sanitisedOutput } : {}),
      outcome,
      ...(errorMessage !== undefined ? { error: errorMessage } : {}),
      ...(recordedCost !== undefined ? { cost: recordedCost } : {}),
    };

    // Sink writes happen even on rejection; the session log is the source of
    // truth for what the agent attempted, not what succeeded.
    await runtime.sessionSink.appendToolRecord(record);

    if (thrown !== undefined) {
      throw thrown;
    }
    // `returnValue` is set when no error was thrown.
    return returnValue as TOutput;
  };
}

/**
 * Resolve and check the path argument before the handler runs.
 *
 * Lifted into a helper so the main `invoke` body stays linear.
 */
function enforcePathScope<TInput, TOutput>(
  definition: ToolDefinition<TInput, TOutput>,
  input: TInput,
  runtime: WrapperRuntime
): string | undefined {
  const field = definition.pathField as string;
  // `input` validated against `inputSchema` immediately above this call,
  // so the field's presence is up to the schema. If the schema marks the
  // field optional and the agent omitted it, skip path scoping rather than
  // rejecting; tools with optional path arguments simply don't engage the
  // check on those calls.
  const value = (input as Record<string, unknown>)[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new PathScopeError(
      definition.name,
      `path field '${field}' must be a string, got ${typeof value}`
    );
  }
  return validatePathScope(
    definition.name,
    runtime.moduleRoot,
    value,
    runtime.pathResolver
  );
}

function compileSchema<T>(
  ajv: Ajv,
  schema: Schema,
  context: string
): ValidateFunction<T> {
  try {
    return ajv.compile<T>(schema);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Schema for ${context} failed to compile: ${message}`);
  }
}

function formatAjvErrors(validate: ValidateFunction<unknown>): string {
  if (!validate.errors || validate.errors.length === 0) {
    return "unknown validation error";
  }
  return validate.errors
    .map((e) => {
      const path = e.instancePath === "" ? "(root)" : e.instancePath;
      return `${path} ${e.message ?? ""}`;
    })
    .join("; ");
}
