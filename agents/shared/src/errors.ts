/**
 * Wrapper-layer errors.
 *
 * These are the categories the session record's `outcome` field can take
 * other than `ok`. Each is a distinct class so callers (and tests) can
 * `instanceof`-discriminate without parsing message strings.
 */

/** Base class for everything the wrapper rejects. */
export abstract class ToolWrapperError extends Error {
  public abstract readonly outcome:
    | "input-schema-error"
    | "output-schema-error"
    | "path-scope-error"
    | "handler-error";
  public readonly tool: string;

  protected constructor(tool: string, message: string) {
    super(message);
    this.tool = tool;
    this.name = new.target.name;
  }
}

/** Input failed JSON-schema validation. The handler did not run. */
export class InputSchemaError extends ToolWrapperError {
  public readonly outcome = "input-schema-error" as const;

  public constructor(tool: string, message: string) {
    super(tool, `[${tool}] input schema rejected: ${message}`);
  }
}

/**
 * Output failed JSON-schema validation. The handler ran but did not produce
 * a contract-conforming result; treat as a tool bug, not an agent error.
 */
export class OutputSchemaError extends ToolWrapperError {
  public readonly outcome = "output-schema-error" as const;

  public constructor(tool: string, message: string) {
    super(tool, `[${tool}] output schema rejected: ${message}`);
  }
}

/**
 * Path-scoping check failed. Covers any of:
 *   - path argument does not start with the module root
 *   - path contains `..` segments
 *   - path resolves outside the module root via symlink
 *   - path is absolute and lies outside the module root
 *   - resolution failed (path does not exist or cannot be canonicalised)
 *
 * The handler did not run.
 */
export class PathScopeError extends ToolWrapperError {
  public readonly outcome = "path-scope-error" as const;

  public constructor(tool: string, message: string) {
    super(tool, `[${tool}] path scope rejected: ${message}`);
  }
}

/**
 * The handler threw. The wrapper catches handler errors so the session log
 * always gets a record, then rethrows wrapped so the caller can distinguish
 * handler failures from wrapper rejections.
 */
export class HandlerError extends ToolWrapperError {
  public readonly outcome = "handler-error" as const;
  public readonly cause: unknown;

  public constructor(tool: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(tool, `[${tool}] handler threw: ${causeMessage}`);
    this.cause = cause;
  }
}
