/**
 * CDK-tool wrappers for the editor agent.
 *
 * Implements two of the tools from `design.md`'s editor catalogue:
 *
 *   - `cdk.diff`   `{}` -> `{diff}`
 *   - `cdk.deploy` `{}` -> `{outcome: "ok" | "deploy-error", logs, stackOutputs?}`
 *
 * Both tools shell out to the CDK CLI (`npx cdk diff` / `npx cdk deploy`)
 * inside `WrapperRuntime.moduleRoot` (the module path read from
 * `agent-harness.config.json`). The CDK app picks up its session and env
 * tags from CDK context, exactly the way `modules/fanout/bin/fanout.ts`
 * already does it; the wrapper passes the context flags so a deploy from
 * the agent ends up tagged with the session and the literal `preview`
 * environment.
 *
 * The session id flows from `WrapperRuntime.sessionId`. The env value is
 * hard-coded to the literal `"preview"` because the design forbids the
 * agent deploying to anything else: `cdk.deploy` is the *preview* deploy,
 * full stop. A forker who needs a different env value should change
 * `PREVIEW_ENV_VALUE` here, which is a code change and a code review.
 *
 * The hard-coded preview context lives in this file rather than as a
 * runtime parameter because the security boundary should be visible in the
 * tool definition. There is no path through the agent that lets it pick a
 * different env: the input schema is empty `{}` and this constant is the
 * only place the value is set.
 *
 * Cost accounting: `cdk.deploy` declares `costCategory: "deploy"` and
 * returns a `cost` report. The dollar figure is presently a placeholder
 * (`PROVISIONAL_DEPLOY_COST_USD`) until task 10.3 measures real preview
 * infrastructure cost from the live-fire run. The shape of the cost report
 * is what matters for the wrapper plumbing; the number gets pinned later.
 *
 * Runner injection: both tools accept an optional `CdkRunner` via the
 * factory functions `createCdkDiffTool(runner)` and
 * `createCdkDeployTool(runner)`. The default runner shells out via
 * `child_process.spawn`. Tests pass a stub runner so they can run without
 * a real CDK installation. The exported `cdkDiffTool` and `deployTool`
 * use the default runner and are what the orchestrator wires up.
 *
 * Naming: this file exports `cdkDiffTool` (not `diffTool`) to avoid a name
 * collision with `module.diff`'s `diffTool` from `tools/module.ts`. The
 * deploy tool is just `deployTool` since `cdk.deploy` is the only deploy
 * tool in the catalogue.
 */

import { spawn } from "node:child_process";

import type {
  CostCategory,
  ToolDefinition,
} from "@agent-harness/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Value applied to the `agent-harness/env` context key on every CDK
 * invocation. Hard-coded by design: the agent has no tool that lets it
 * deploy to a non-preview environment.
 */
const PREVIEW_ENV_VALUE = "preview" as const;

/** CDK context keys, matching `modules/fanout/bin/fanout.ts`. */
const SESSION_CONTEXT_KEY = "agent-harness/session";
const ENV_CONTEXT_KEY = "agent-harness/env";

/**
 * Provisional deploy cost in USD reported per `cdk.deploy` call.
 *
 * Placeholder until task 10.3's live-fire run measures the actual preview
 * infrastructure cost per trigger. The shape of the cost report is what
 * the wrapper depends on; the number gets revised when measurements exist.
 *
 * Reporting `0` (rather than picking a guess) means the deploy cost
 * counter records a call but does not skew the running total. The stop
 * condition that watches `previewInfraUSD` will fire only once the
 * counter is updated to real numbers.
 */
const PROVISIONAL_DEPLOY_COST_USD = 0;

const DEPLOY_CATEGORY: CostCategory = "deploy";

/**
 * Output buffer cap for the CDK CLI's combined stdout+stderr. CDK is chatty
 * during a deploy (CloudFormation event stream); 16 MiB is well above
 * typical deploys and prevents an unbounded memory footprint if something
 * goes wrong.
 */
const MAX_CDK_OUTPUT_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Runner abstraction
// ---------------------------------------------------------------------------

/**
 * Result of one CDK CLI invocation. The runner returns this even when the
 * CLI exits non-zero; it does not throw on a non-zero exit because the
 * caller (specifically `cdk.deploy`) needs to distinguish a deploy error
 * from a tooling error.
 */
export interface CdkRunResult {
  /** Exit code reported by the CDK CLI. `0` means success. */
  readonly exitCode: number;
  /** Captured stdout. UTF-8. May be empty. */
  readonly stdout: string;
  /** Captured stderr. UTF-8. May be empty. */
  readonly stderr: string;
}

/**
 * Abstract CDK CLI runner. The default implementation shells out via
 * `child_process.spawn`; tests inject a stub.
 */
export interface CdkRunner {
  /**
   * Invoke the CDK CLI with `args` from `cwd`. Implementations MUST resolve
   * (not reject) on non-zero exit codes; the caller inspects `exitCode` to
   * distinguish success from failure.
   *
   * Implementations MAY reject only when the CLI cannot be launched at all
   * (binary not found, spawn error). The wrapper layer treats those as
   * handler errors via the standard `HandlerError` path.
   */
  run(args: readonly string[], options: { readonly cwd: string }): Promise<CdkRunResult>;
}

/**
 * Default runner. Spawns `npx cdk <args>` with `shell: true` so the OS-
 * dependent `npx` resolution (npx vs. npx.cmd on Windows) is handled by
 * the platform's PATH lookup.
 *
 * Combined stdout/stderr capacity is bounded by `MAX_CDK_OUTPUT_BYTES`;
 * output past the cap is truncated and a marker line appended, rather
 * than rejected, so the agent still sees the head of the deploy log.
 */
export const defaultCdkRunner: CdkRunner = {
  async run(
    args: readonly string[],
    options: { readonly cwd: string }
  ): Promise<CdkRunResult> {
    return new Promise<CdkRunResult>((resolveRun, rejectRun) => {
      const child = spawn("npx", ["cdk", ...args], {
        cwd: options.cwd,
        // shell: true so Windows resolves npx.cmd via PATH like Unix
        // resolves npx. The `args` array is built from constants and
        // sanitised values (session id, env literal, stack name) so
        // shell metacharacter risk is bounded; even so, see
        // `sanitiseContextValue` below for the defence-in-depth check.
        shell: true,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutTruncated = false;
      let stderrTruncated = false;

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdoutBytes >= MAX_CDK_OUTPUT_BYTES) {
          stdoutTruncated = true;
          return;
        }
        const remaining = MAX_CDK_OUTPUT_BYTES - stdoutBytes;
        if (chunk.byteLength > remaining) {
          stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes += remaining;
          stdoutTruncated = true;
        } else {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.byteLength;
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBytes >= MAX_CDK_OUTPUT_BYTES) {
          stderrTruncated = true;
          return;
        }
        const remaining = MAX_CDK_OUTPUT_BYTES - stderrBytes;
        if (chunk.byteLength > remaining) {
          stderrChunks.push(chunk.subarray(0, remaining));
          stderrBytes += remaining;
          stderrTruncated = true;
        } else {
          stderrChunks.push(chunk);
          stderrBytes += chunk.byteLength;
        }
      });

      child.on("error", (err) => rejectRun(err));
      child.on("close", (exitCode) => {
        const stdout =
          Buffer.concat(stdoutChunks).toString("utf8") +
          (stdoutTruncated ? "\n[truncated: stdout exceeded cap]" : "");
        const stderr =
          Buffer.concat(stderrChunks).toString("utf8") +
          (stderrTruncated ? "\n[truncated: stderr exceeded cap]" : "");
        resolveRun({
          exitCode: typeof exitCode === "number" ? exitCode : 1,
          stdout,
          stderr,
        });
      });
    });
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the array of CLI args common to every CDK invocation: the
 * `--context` flags that pin session and env, and `--all` so the CDK app's
 * default stack synthesises (matches `modules/fanout/bin/fanout.ts`, which
 * synthesises a single stack from `module.stackName`).
 *
 * The session id is sanitised before substitution. The env value is a
 * compile-time constant.
 */
function buildContextArgs(sessionId: string): string[] {
  const safeSessionId = sanitiseContextValue(sessionId);
  return [
    "--context",
    `${SESSION_CONTEXT_KEY}=${safeSessionId}`,
    "--context",
    `${ENV_CONTEXT_KEY}=${PREVIEW_ENV_VALUE}`,
  ];
}

/**
 * Reject context values containing characters that could break out of the
 * `--context key=value` shape on the command line. The session id is
 * generated by the GitHub Action and the harness validates the trigger
 * payload up front, so this is defence-in-depth rather than the primary
 * check; the upstream validator is the primary.
 *
 * Allow-list approach: alphanumerics, `-`, `_`, `.`. Everything else
 * triggers a rejection. Session ids in the trigger payload look like
 * `session-<uuid>`, all of which fits the allow-list.
 */
function sanitiseContextValue(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(
      `cdk: refusing to pass session id with disallowed characters: ${JSON.stringify(value)}`
    );
  }
  return value;
}

/**
 * Parse stack outputs from `cdk deploy` stdout.
 *
 * CDK's deploy output prints stack outputs in a section that looks like:
 *
 *   StackName.OutputKey = OutputValue
 *
 * with one output per line, after a `Outputs:` header. The format is
 * stable enough across CDK 2.x for this lightweight parser; if a future
 * CDK version changes the format, the parser returns an empty record and
 * the deploy still succeeds (the outputs are nice-to-have, not contractual
 * for this tool's `outcome` field).
 *
 * The parser is permissive: it handles whitespace variations, ignores
 * lines outside the outputs block, and stops at a blank line or the next
 * section header.
 */
function parseStackOutputs(stdout: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  const lines = stdout.split(/\r?\n/);
  let inOutputsBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inOutputsBlock) {
      // Match `Outputs:` (the typical CDK deploy header). Some CDK
      // versions prefix this with `✅  StackName`; tolerate both.
      if (/^Outputs:?$/.test(trimmed) || /^Outputs:/.test(trimmed)) {
        inOutputsBlock = true;
      }
      continue;
    }
    // Inside the outputs block. A blank line or a line that looks like
    // another section header ends it.
    if (trimmed === "") {
      inOutputsBlock = false;
      continue;
    }
    if (/^[A-Z][a-zA-Z]+ time:/.test(trimmed) || /^Stack ARN:/.test(trimmed)) {
      // CDK prints `Deployment time:` and `Stack ARN:` after outputs.
      inOutputsBlock = false;
      continue;
    }
    // `StackName.Key = Value` (CDK uses ` = `; tolerate `:` too).
    const match = /^([A-Za-z0-9_.-]+)\s*[:=]\s*(.+)$/.exec(trimmed);
    if (match) {
      const [, key, value] = match;
      outputs[key] = value.trim();
    }
  }
  return outputs;
}

// ---------------------------------------------------------------------------
// cdk.diff
// ---------------------------------------------------------------------------

interface CdkDiffInput {
  // Empty by design; the diff target is fixed by the wrapper.
}

interface CdkDiffOutput {
  readonly diff: string;
}

/**
 * Build a `cdk.diff` tool bound to the given runner. The exported
 * `cdkDiffTool` uses the default runner; tests inject a stub.
 */
export function createCdkDiffTool(
  runner: CdkRunner = defaultCdkRunner
): ToolDefinition<CdkDiffInput, CdkDiffOutput> {
  return {
    name: "cdk.diff",
    description:
      "Run `cdk diff` against the preview environment for the current session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        diff: { type: "string" },
      },
      required: ["diff"],
      additionalProperties: false,
    },
    handler: async (_input, ctx) => {
      const moduleRoot = ctx.resolvedModuleRoot as string;
      const args = [
        "diff",
        "--no-color",
        ...buildContextArgs(ctx.sessionId),
      ];
      const result = await runner.run(args, { cwd: moduleRoot });
      // `cdk diff` exits non-zero only when the CDK CLI itself fails (e.g.
      // synth error). A diff that contains changes still exits 0 by
      // default. If the CLI errored, surface stdout+stderr as the diff
      // text so the agent sees the failure mode and can react. We do NOT
      // throw, because the design treats `cdk.diff` as a read-only sensor
      // and a non-zero diff is information for the loop, not a failure.
      const diff =
        result.exitCode === 0
          ? result.stdout
          : `${result.stdout}\n${result.stderr}`.trim();
      return { output: { diff } };
    },
  };
}

/** Default-runner-bound `cdk.diff` tool. */
export const cdkDiffTool = createCdkDiffTool();

// ---------------------------------------------------------------------------
// cdk.deploy
// ---------------------------------------------------------------------------

interface CdkDeployInput {
  // Empty by design; the deploy target is fixed by the wrapper.
}

interface CdkDeployOutput {
  readonly outcome: "ok" | "deploy-error";
  readonly logs: string;
  readonly stackOutputs?: Record<string, string>;
}

/**
 * Build a `cdk.deploy` tool bound to the given runner.
 *
 * Outcome semantics:
 *   - `"ok"`           when CDK exits 0. `stackOutputs` parsed from stdout.
 *   - `"deploy-error"` when CDK exits non-zero. `logs` still captured.
 *
 * The handler always returns; it never throws on a deploy failure (the
 * design treats deploy errors as a sensor-class signal that feeds the
 * loop, not a tooling error). Spawn errors (CDK CLI not found, etc.)
 * propagate as `HandlerError`s via the wrapper's standard rethrow path.
 */
export function createCdkDeployTool(
  runner: CdkRunner = defaultCdkRunner
): ToolDefinition<CdkDeployInput, CdkDeployOutput> {
  return {
    name: "cdk.deploy",
    description:
      "Deploy the module's CDK app to the preview environment for the current session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["ok", "deploy-error"] },
        logs: { type: "string" },
        stackOutputs: {
          type: "object",
          // CDK output keys vary; allow any string -> string mapping.
          additionalProperties: { type: "string" },
        },
      },
      required: ["outcome", "logs"],
      additionalProperties: false,
    },
    costCategory: DEPLOY_CATEGORY,
    handler: async (_input, ctx) => {
      const moduleRoot = ctx.resolvedModuleRoot as string;
      const args = [
        "deploy",
        "--all",
        "--require-approval",
        "never",
        "--no-color",
        // `--ci` makes the output less interactive (no progress bar) so
        // the captured logs are easier to read in the session record.
        "--ci",
        ...buildContextArgs(ctx.sessionId),
      ];
      const result = await runner.run(args, { cwd: moduleRoot });
      const logs = `${result.stdout}\n${result.stderr}`.trim();
      const cost = {
        usd: PROVISIONAL_DEPLOY_COST_USD,
        category: DEPLOY_CATEGORY,
      };
      if (result.exitCode === 0) {
        const stackOutputs = parseStackOutputs(result.stdout);
        const output: CdkDeployOutput =
          Object.keys(stackOutputs).length > 0
            ? { outcome: "ok", logs, stackOutputs }
            : { outcome: "ok", logs };
        return { output, cost };
      }
      return {
        output: { outcome: "deploy-error", logs },
        cost,
      };
    },
  };
}

/** Default-runner-bound `cdk.deploy` tool. */
export const deployTool = createCdkDeployTool();
