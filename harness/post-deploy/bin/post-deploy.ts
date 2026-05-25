#!/usr/bin/env node
/**
 * Standalone CLI entry point for the synthetic post-deploy harness.
 *
 * GitHub Actions invokes this directly (or via `npm run -w
 * @agent-harness/post-deploy ...`) after `cdk deploy` lands a preview.
 * The CLI reads the deploy's stack outputs from a JSON file or a
 * single environment variable, calls `runPostDeploy`, and prints the
 * `PostDeployOutput` to stdout as JSON.
 *
 * Usage:
 *
 *     post-deploy \
 *       --session-id session-<uuid> \
 *       --stack-outputs ./outputs.json
 *
 *   or
 *
 *     STACK_OUTPUTS_JSON='{"ApiEndpointUrl":"https://...","QueueUrl":"..."}' \
 *     SESSION_ID=session-abc \
 *       post-deploy
 *
 * Exit codes:
 *   0  outcome `pass`
 *   1  outcome `fail` or `partial`
 *   2  outcome `deploy-failure`
 *   3  CLI usage error (missing args, malformed JSON)
 *
 * The non-zero exit code lets a GitHub Actions job step in `if`
 * conditions (`if: failure()`) react without parsing the JSON; the JSON
 * itself stays the source of truth for the agent's session log.
 */

import { promises as fs } from "node:fs";

import { runPostDeploy } from "../src/runner";
import type { PostDeployInput, PostDeployOutput } from "../src/types";

interface CliArgs {
  readonly sessionId: string;
  readonly stackOutputs?: Record<string, string>;
  readonly deployFailureLogsPath?: string;
}

class CliUsageError extends Error {}

/**
 * Parse the CLI args. Accepts both `--flag value` and `--flag=value`
 * forms; falls back to the `SESSION_ID` and `STACK_OUTPUTS_JSON` env
 * vars when flags are absent. Anything malformed throws
 * `CliUsageError`, which the entrypoint maps to exit code 3.
 */
export async function parseCliArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<CliArgs> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags.set(arg.slice(2), argv[i + 1]);
      i++;
    } else {
      flags.set(arg.slice(2), "");
    }
  }

  const sessionId = flags.get("session-id") ?? env.SESSION_ID;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new CliUsageError(
      "missing --session-id (or SESSION_ID env var)",
    );
  }

  let stackOutputs: Record<string, string> | undefined;
  const stackOutputsPath = flags.get("stack-outputs");
  if (stackOutputsPath !== undefined && stackOutputsPath.length > 0) {
    const raw = await fs.readFile(stackOutputsPath, "utf8");
    stackOutputs = parseStackOutputsJson(raw, stackOutputsPath);
  } else if (typeof env.STACK_OUTPUTS_JSON === "string") {
    stackOutputs = parseStackOutputsJson(
      env.STACK_OUTPUTS_JSON,
      "STACK_OUTPUTS_JSON",
    );
  }

  const deployFailureLogsPath = flags.get("deploy-failure-logs");
  return { sessionId, stackOutputs, deployFailureLogsPath };
}

/**
 * Parse a stack-outputs JSON document. Accepts two shapes:
 *
 *   1. A flat map `{"ApiEndpointUrl": "...", "QueueUrl": "..."}`.
 *   2. CDK's `--outputs-file` shape, which nests under the stack name:
 *      `{"FanoutPreview": {"ApiEndpointUrl": "...", ...}}`.
 *
 * The runner's `resolveStackOutput` handles both bare and qualified
 * keys, but flattening here means the runner sees the same shape from
 * both invocation paths (CLI and tool wrapper).
 */
function parseStackOutputsJson(
  raw: string,
  source: string,
): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliUsageError(
      `failed to parse JSON from ${source}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new CliUsageError(
      `expected JSON object at ${source}, got ${typeof parsed}`,
    );
  }
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") {
      flat[k] = v;
    } else if (v !== null && typeof v === "object") {
      // CDK nested form: `{"<stack>": {"<key>": "<value>"}}`.
      for (const [nestedK, nestedV] of Object.entries(
        v as Record<string, unknown>,
      )) {
        if (typeof nestedV === "string") {
          flat[`${k}.${nestedK}`] = nestedV;
        }
      }
    }
  }
  return flat;
}

/**
 * Map a `PostDeployOutput.outcome` to a process exit code.
 * Exposed for tests; called by `main`.
 */
export function exitCodeForOutcome(
  outcome: PostDeployOutput["outcome"],
): number {
  switch (outcome) {
    case "pass":
      return 0;
    case "fail":
    case "partial":
      return 1;
    case "deploy-failure":
      return 2;
  }
}

async function main(): Promise<number> {
  let cliArgs: CliArgs;
  try {
    cliArgs = await parseCliArgs(process.argv.slice(2), process.env);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`post-deploy: ${err.message}\n`);
      return 3;
    }
    throw err;
  }

  let deployFailureLogs: string | undefined;
  if (cliArgs.deployFailureLogsPath !== undefined) {
    deployFailureLogs = await fs.readFile(
      cliArgs.deployFailureLogsPath,
      "utf8",
    );
  }

  const input: PostDeployInput = {
    sessionId: cliArgs.sessionId,
    ...(cliArgs.stackOutputs !== undefined
      ? { stackOutputs: cliArgs.stackOutputs }
      : {}),
    ...(deployFailureLogs !== undefined ? { deployFailureLogs } : {}),
  };

  const output = await runPostDeploy(input);
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return exitCodeForOutcome(output.outcome);
}

// Run when invoked as the CLI entry, not when imported by tests.
// `require.main === module` is the standard Node guard for CommonJS.
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(
        `post-deploy: unexpected error: ${
          err instanceof Error ? err.stack ?? err.message : String(err)
        }\n`,
      );
      process.exit(3);
    });
}
