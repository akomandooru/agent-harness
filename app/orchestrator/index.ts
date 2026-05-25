/**
 * Orchestrator Lambda handler.
 *
 * AWS Lambda has a 15-minute execution cap. The smoke test is sized so a
 * typical 2–4 iteration run completes inside that cap (a typical 2–4
 * iteration run takes ~2–3 minutes per iteration: one InvokeHarness call
 * for the editor, sensors locally, one InvokeHarness call for the reviewer,
 * cdk deploy, and post-deploy). Operators running longer loops will need a
 * different host (Step Functions for state-machine orchestration, ECS task
 * for arbitrarily long compute) — this is out of scope for this spec.
 *
 * This file is built up incrementally across tasks 6.1–6.3:
 *   - 6.1: Local-runner adapters for the trust gates.
 *   - 6.2: `adaptReviewerResultToReviewerResult` helper.
 *   - 6.3: Full Lambda handler export (this task).
 */

import type { APIGatewayProxyHandler } from "aws-lambda";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createSessionFromTrigger,
  InMemorySessionStore,
  type SessionTrigger,
} from "@agent-harness/loop/src/session";
import { runLoop, type LoopGates } from "@agent-harness/loop/src/run";
import type { StopConditionConfig, KillSwitchPoll } from "@agent-harness/loop/src/stop-conditions";
import { ManagedHarnessEditorInvocation } from "@agent-harness/editor/managed-harness-invocation";
import { ManagedHarnessReviewerInvocation } from "@agent-harness/scheduled-reviewer/src/run";

import {
  cdkNagTool,
  tscTool,
  eslintTool,
  createUnitTestsTool,
} from "@agent-harness/editor/tools/sensors";
import { deployTool } from "@agent-harness/editor/tools/cdk";
import { runPostDeploy } from "@agent-harness/post-deploy";
import { createPrOpenTool, defaultGitHubClient } from "@agent-harness/editor/tools/pr";

import type {
  SensorResults,
  DeployResult,
  PostDeployResult,
  ReviewerResult,
} from "@agent-harness/loop/src/run";

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * The subset of `agent-harness.config.json` the orchestrator Lambda needs
 * to build the `StopConditionConfig` and the `killSwitchPoll`.
 */
interface AgentHarnessConfig {
  readonly limits: {
    readonly iterationCap: number;
    readonly wallClockCapMinutes: number;
    readonly tokenSpendCapUSD: number;
  };
  readonly oscillation: {
    readonly sameDiffWindow: number;
    readonly alternationWindow: number;
  };
}

/**
 * Load and parse `agent-harness.config.json` from the repo root.
 *
 * The Lambda's working directory is the repo root when deployed via the
 * CDK `NodejsFunction` construct. In tests, the config is loaded from
 * the same path relative to the workspace root.
 */
function loadConfig(): AgentHarnessConfig {
  const configPath = resolve(__dirname, "../../agent-harness.config.json");
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as AgentHarnessConfig;
}

/**
 * Build a `StopConditionConfig` from the loaded `agent-harness.config.json`.
 */
function buildStopConditionConfig(config: AgentHarnessConfig): StopConditionConfig {
  return {
    iterationCap: config.limits.iterationCap,
    wallClockCapMinutes: config.limits.wallClockCapMinutes,
    tokenSpendCapUSD: config.limits.tokenSpendCapUSD,
    oscillation: {
      sameDiffWindow: config.oscillation.sameDiffWindow,
      alternationWindow: config.oscillation.alternationWindow,
    },
  };
}

/**
 * Build a no-op kill-switch poll for the Lambda handler.
 *
 * The kill-switch poll checks whether the `agent-stop` GitHub label has
 * been applied to the issue or in-flight PR. In the Lambda context, the
 * GitHub token from the trigger payload is used to poll the issue.
 *
 * For the smoke test, a simple no-op poll is used (the kill switch is
 * not exercised in the smoke test). A production implementation would
 * poll the GitHub API using the session's trigger auth token.
 *
 * The session's `trigger.auth` fields are redacted in the stored session
 * record; the original token is available in the raw trigger payload
 * before `createSessionFromTrigger` redacts it.
 */
function buildKillSwitchPoll(rawTrigger: Record<string, unknown>): KillSwitchPoll {
  // Extract the GitHub token from the raw (pre-redaction) trigger payload.
  // The token is used to poll the issue for the `agent-stop` label.
  const auth = rawTrigger["auth"] as Record<string, unknown> | undefined;
  const githubToken = typeof auth?.["githubInstallationToken"] === "string"
    ? auth["githubInstallationToken"]
    : undefined;

  return {
    async isAgentStopLabelApplied(session) {
      // When no token is available, fail open (do not halt the loop).
      if (githubToken === undefined) {
        return false;
      }
      try {
        const { issue, module: mod } = session.trigger;
        const [owner, repo] = mod.repository.split("/");
        const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issue.number}/labels`;
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
        if (!response.ok) {
          // Non-2xx: fail open (do not halt the loop on a transient error).
          return false;
        }
        const labels = (await response.json()) as Array<{ name: string }>;
        return labels.some((l) => l.name === "agent-stop");
      } catch {
        // Network error: fail open.
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 6.2 adaptReviewerResultToReviewerResult helper
// ---------------------------------------------------------------------------

/**
 * Severity levels in ascending order of severity.
 *
 * Used to determine whether a finding's severity meets or exceeds the
 * configured threshold. The order matches the reviewer's system prompt
 * and the `ReviewerSeverity` type in `agents/reviewer/agent.ts`.
 */
const SEVERITY_ORDER: ReadonlyArray<string> = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
];

/**
 * Input shape for `adaptReviewerResultToReviewerResult`.
 *
 * Mirrors `StandaloneReviewerResult` from
 * `harness/scheduled-reviewer/src/run.ts` without importing that package
 * (which is not a dependency of the orchestrator). The adapter only needs
 * the `findings` array; `tokenCostUSD` and `modelVersion` are carried
 * through for completeness but are not used in the shape adaptation.
 */
export interface StandaloneReviewerResultInput {
  /** Findings produced by the reviewer agent. */
  readonly findings: ReadonlyArray<{
    readonly id: string;
    readonly pillar: string;
    readonly severity: string;
    readonly description: string;
    readonly suggestedFix: string;
    readonly file?: string;
    readonly line?: number;
  }>;
  /** Estimated token cost in USD for this invocation. */
  readonly tokenCostUSD: number;
  /** Model version string returned by the Bedrock invocation. */
  readonly modelVersion: string;
}

/**
 * Map a `StandaloneReviewerResult` (the shape produced by
 * `ManagedHarnessReviewerInvocation`) into the `ReviewerResult` shape
 * that `runLoop`'s `LoopGates.runReviewer()` expects.
 *
 * The two shapes differ in two fields:
 *
 *   - `passed` (absent in `StandaloneReviewerResult`): computed from
 *     `findings` by checking whether any finding's severity meets or
 *     exceeds the configured `reviewerSeverityThreshold`. Mirrors the
 *     logic in `agents/reviewer/agent.ts`'s output-validation pass and
 *     the reviewer's system prompt (step 7: "Set `passed` to `true` if
 *     no finding has severity above the configured threshold").
 *
 *   - `severityCounts` (absent in `StandaloneReviewerResult`): computed
 *     by counting findings grouped by severity. Mirrors the
 *     `countFindingsBySeverity` helper in
 *     `harness/scheduled-reviewer/src/run.ts`.
 *
 *   - `tokenCostUSD` and `modelVersion` (present in
 *     `StandaloneReviewerResult`, absent in `ReviewerResult`): dropped
 *     by the adapter. The loop does not need them; cost accounting is
 *     handled separately by the orchestrator.
 *
 * The `severityThreshold` parameter is the value from
 * `agent-harness.config.json` `sensors.reviewerSeverityThreshold`
 * (e.g., `"MEDIUM"`). It is compared case-insensitively against each
 * finding's `severity` field (which uses lowercase values per the
 * reviewer's output schema).
 *
 * This is a pure function: no I/O, no side effects, deterministic output
 * for any given input. Tests in `app/orchestrator/__tests__/adapter.test.ts`
 * exercise it directly.
 *
 * @param result - The `StandaloneReviewerResult` to adapt.
 * @param severityThreshold - The minimum severity that blocks the loop
 *   (from `agent-harness.config.json` `sensors.reviewerSeverityThreshold`).
 *   Defaults to `"MEDIUM"` when not supplied, matching the config default.
 */
export function adaptReviewerResultToReviewerResult(
  result: StandaloneReviewerResultInput,
  severityThreshold: string = "MEDIUM",
): ReviewerResult {
  const thresholdLower = severityThreshold.toLowerCase();
  const thresholdIndex = SEVERITY_ORDER.indexOf(thresholdLower);

  // Compute severityCounts: count findings by severity.
  const severityCounts: Record<string, number> = {};
  for (const finding of result.findings) {
    const sev = finding.severity;
    severityCounts[sev] = (severityCounts[sev] ?? 0) + 1;
  }

  // Compute passed: true iff no finding has severity >= threshold.
  // When the threshold is unrecognised, default to blocking (passed = false)
  // so an unknown threshold does not silently allow bad findings through.
  let passed: boolean;
  if (thresholdIndex === -1) {
    // Unknown threshold: fail closed — treat as if every finding exceeds it.
    passed = result.findings.length === 0;
  } else {
    passed = result.findings.every((finding) => {
      const findingIndex = SEVERITY_ORDER.indexOf(finding.severity.toLowerCase());
      // Unknown finding severity: treat as below threshold (do not block).
      if (findingIndex === -1) return true;
      return findingIndex < thresholdIndex;
    });
  }

  return {
    findings: result.findings,
    passed,
    severityCounts,
  };
}

// ---------------------------------------------------------------------------
// Minimal ToolHandlerContext for local invocations
// ---------------------------------------------------------------------------

/**
 * Build a minimal `ToolHandlerContext` for calling tool handlers directly
 * (bypassing the wrapper layer). The trust gates run on the orchestrator
 * side as plain function calls; they do not go through the AgentCore
 * wrapper machinery.
 *
 * `moduleRoot` is the absolute path to the CDK module under maintenance.
 * `sessionId` and `iterationIndex` are carried through for logging
 * purposes inside the handlers that use them.
 */
function makeHandlerContext(
  moduleRoot: string,
  sessionId: string,
  iterationIndex: number,
) {
  return {
    resolvedModuleRoot: moduleRoot,
    sessionId,
    iterationIndex,
  };
}

// ---------------------------------------------------------------------------
// Local-runner adapter configuration
// ---------------------------------------------------------------------------

/**
 * Configuration the local-runner adapters need at call time.
 *
 * `moduleRoot` is the absolute path to the CDK module the sensors and CDK
 * deploy operate on. `sessionId` and `iterationIndex` are forwarded to the
 * tool handlers for logging.
 */
export interface LocalRunnerConfig {
  readonly moduleRoot: string;
  readonly sessionId: string;
  readonly iterationIndex: number;
}

/**
 * Configuration for the GitHub PR adapter.
 *
 * Kept separate from `LocalRunnerConfig` because the GitHub token and
 * repository are session-level constants (set once per Lambda invocation)
 * while the other config fields are iteration-level.
 */
export interface GitHubConfig {
  /** Short-lived GitHub installation token from the trigger payload. */
  readonly githubToken: string;
  /** `<org>/<repo>` from the trigger payload's `module.repository`. */
  readonly repository: string;
  /** PR title. */
  readonly title: string;
  /** PR body. */
  readonly body: string;
  /** Source branch the agent pushed its changes to. */
  readonly branch: string;
  /** Base ref the PR targets (typically `main`). */
  readonly baseRef: string;
}

// ---------------------------------------------------------------------------
// 6.1 Local-runner adapters
// ---------------------------------------------------------------------------

/**
 * Run all four computational sensors locally and return the aggregated
 * `SensorResults` shape that `LoopGates.runSensors()` expects.
 *
 * Delegates to the existing tool handlers in `agents/editor/tools/sensors.ts`
 * and unwraps the `{output, cost?}` envelope each handler returns into the
 * flat `SensorResults` shape.
 *
 * The sensors are run sequentially so that a failure in an earlier sensor
 * (e.g., tsc) does not mask a failure in a later one (e.g., eslint). All
 * four results are always collected and returned; the loop decides which
 * failures to act on.
 */
export async function runLocalSensors(
  config: LocalRunnerConfig,
): Promise<SensorResults> {
  const ctx = makeHandlerContext(
    config.moduleRoot,
    config.sessionId,
    config.iterationIndex,
  );

  const unitTestsTool = createUnitTestsTool();

  const [cdkNagResult, tscResult, eslintResult, unitTestsResult] =
    await Promise.all([
      cdkNagTool.handler({}, ctx),
      tscTool.handler({}, ctx),
      eslintTool.handler({}, ctx),
      unitTestsTool.handler({}, ctx),
    ]);

  return {
    cdkNag: cdkNagResult.output,
    tsc: tscResult.output,
    eslint: eslintResult.output,
    unitTests: unitTestsResult.output,
  };
}

/**
 * Run `cdk deploy` locally and return the `DeployResult` shape that
 * `LoopGates.runDeploy()` expects.
 *
 * Delegates to the existing `deployTool` handler in
 * `agents/editor/tools/cdk.ts` and unwraps the `{output, cost?}` envelope
 * into the flat `DeployResult` shape.
 */
export async function runLocalCdkDeploy(
  config: LocalRunnerConfig,
): Promise<DeployResult> {
  const ctx = makeHandlerContext(
    config.moduleRoot,
    config.sessionId,
    config.iterationIndex,
  );

  const result = await deployTool.handler({}, ctx);
  return result.output;
}

/**
 * Run the post-deploy harness locally and return the `PostDeployResult`
 * shape that `LoopGates.runPostDeploy()` expects.
 *
 * Delegates to `runPostDeploy` from `@agent-harness/post-deploy`. That
 * function already returns `PostDeployOutput` which is structurally
 * compatible with `PostDeployResult` (`{outcome, report}`), so this
 * wrapper only adds the `sessionId` and optional `stackOutputs` from the
 * config.
 *
 * `stackOutputs` carries the CDK stack outputs from the preceding deploy
 * step (e.g., `ApiEndpointUrl`, `QueueUrl`). When the deploy failed,
 * `deployFailureLogs` is passed through so the harness short-circuits with
 * `outcome: "deploy-failure"` rather than running the synthetic flow.
 */
export async function runLocalPostDeploy(
  sessionId: string,
  stackOutputs?: Record<string, string>,
  deployFailureLogs?: string,
): Promise<PostDeployResult> {
  const output = await runPostDeploy({
    sessionId,
    ...(stackOutputs !== undefined ? { stackOutputs } : {}),
    ...(deployFailureLogs !== undefined ? { deployFailureLogs } : {}),
  });
  // PostDeployOutput is structurally compatible with PostDeployResult:
  // both have `outcome: string` and `report: Record<string, unknown>`.
  return output;
}

/**
 * Open a GitHub pull request and return `{number, url}` as `LoopGates.openPR`
 * expects.
 *
 * Delegates to the `pr.open` tool handler in `agents/editor/tools/pr.ts`
 * via a session-bound `GitHubClient`. The token and repository are held
 * inside the client's closure and never appear in the tool's input schema
 * (matching the security contract documented in `pr.ts`).
 *
 * The `partial` flag is accepted for interface compatibility with
 * `LoopGates.openPR` but is not forwarded to the GitHub API — it is used
 * by the caller to decide the PR body content before calling this adapter.
 */
export async function openGitHubPR(
  config: GitHubConfig,
  _partial: boolean,
): Promise<{ number: number; url: string }> {
  const client = defaultGitHubClient({
    token: config.githubToken,
    repository: config.repository,
  });

  const prTool = createPrOpenTool(client);

  const ctx = {
    sessionId: "",
    iterationIndex: 0,
  };

  const result = await prTool.handler(
    {
      title: config.title,
      body: config.body,
      branch: config.branch,
      baseRef: config.baseRef,
    },
    ctx,
  );

  return result.output;
}

// ---------------------------------------------------------------------------
// 6.3 Lambda handler
// ---------------------------------------------------------------------------

/**
 * API Gateway proxy handler for the orchestrator Lambda.
 *
 * Invoked by API Gateway when the dispatch workflow POSTs a trigger payload
 * to the orchestrator endpoint. The handler:
 *
 *   1. Parses the trigger payload from `event.body`.
 *   2. Builds a `Session` via `createSessionFromTrigger`.
 *   3. Constructs `ManagedHarnessEditorInvocation` and
 *      `ManagedHarnessReviewerInvocation` from the harness ARNs in the
 *      Lambda environment variables.
 *   4. Builds the `LoopGates` object wiring the two invocations and the
 *      local trust-gate runners.
 *   5. Calls `runLoop()` with the session, an in-memory store, the
 *      stop-condition config from `agent-harness.config.json`, and the
 *      kill-switch poll.
 *   6. On success: returns 200 with `{ terminationReason, prNumber }`.
 *   7. On any throw: logs to stdout (CloudWatch Logs) and returns 500
 *      with `{ error: String(err) }`. No 200 is written in this path.
 *
 * The trust gates (sensors, cdk deploy, post-deploy) are NOT registered
 * as Managed Harness tools — they remain orchestrator-side custom code.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    // Step 1: Parse the trigger payload from the request body.
    const rawTrigger = JSON.parse(event.body ?? "{}") as Record<string, unknown>;

    // Step 2: Build the Session. createSessionFromTrigger redacts secrets
    // (auth.githubInstallationToken) before storing them in the session record.
    const session = createSessionFromTrigger(rawTrigger as unknown as SessionTrigger);

    // Step 3: Construct the Managed Harness invocations.
    const editorHarnessArn = process.env["EDITOR_HARNESS_ARN"];
    const reviewerHarnessArn = process.env["REVIEWER_HARNESS_ARN"];

    if (!editorHarnessArn) {
      throw new Error("EDITOR_HARNESS_ARN environment variable is not set");
    }
    if (!reviewerHarnessArn) {
      throw new Error("REVIEWER_HARNESS_ARN environment variable is not set");
    }

    const editorInvocation = new ManagedHarnessEditorInvocation({
      harnessArn: editorHarnessArn,
      sessionId: session.trigger.session.id,
    });

    const reviewerInvocation = new ManagedHarnessReviewerInvocation({
      harnessArn: reviewerHarnessArn,
      sessionId: session.trigger.session.id,
    });

    // Step 4: Load config and build the LoopGates.
    const agentConfig = loadConfig();
    const stopConditionConfig = buildStopConditionConfig(agentConfig);
    const killSwitchPoll = buildKillSwitchPoll(rawTrigger);

    // Extract session-level values from the trigger for the local runners.
    const moduleRoot = resolve(
      __dirname,
      "../../",
      (rawTrigger["module"] as Record<string, unknown> | undefined)?.["path"] as string ?? "modules/fanout",
    );
    const sessionId = session.trigger.session.id;

    // Extract GitHub config from the raw trigger for the PR adapter.
    const auth = rawTrigger["auth"] as Record<string, unknown> | undefined;
    const githubToken = typeof auth?.["githubInstallationToken"] === "string"
      ? auth["githubInstallationToken"]
      : "";
    const repository = typeof (rawTrigger["module"] as Record<string, unknown> | undefined)?.["repository"] === "string"
      ? (rawTrigger["module"] as Record<string, unknown>)["repository"] as string
      : "";

    let iterationIndex = 0;

    const gates: LoopGates = {
      // runEditor: delegate to the editor Managed Harness invocation.
      runEditor: (ctx) => editorInvocation.runEditor(ctx),

      // runReviewer: delegate to the reviewer Managed Harness invocation,
      // then adapt the StandaloneReviewerResult into the ReviewerResult shape.
      runReviewer: async (diff) => {
        const r = await reviewerInvocation.invoke({ diff });
        return adaptReviewerResultToReviewerResult(r);
      },

      // runSensors: run the four computational sensors locally.
      runSensors: () =>
        runLocalSensors({
          moduleRoot,
          sessionId,
          iterationIndex: iterationIndex++,
        }),

      // runDeploy: run cdk deploy locally.
      runDeploy: () =>
        runLocalCdkDeploy({
          moduleRoot,
          sessionId,
          iterationIndex,
        }),

      // runPostDeploy: run the post-deploy harness locally.
      runPostDeploy: (stackOutputs) =>
        runLocalPostDeploy(sessionId, stackOutputs),

      // openPR: open a GitHub pull request.
      openPR: (body, partial) =>
        openGitHubPR(
          {
            githubToken,
            repository,
            title: partial
              ? `[agent-harness] Partial: ${session.trigger.issue.title}`
              : `[agent-harness] ${session.trigger.issue.title}`,
            body,
            branch: `agent-harness/${sessionId}`,
            baseRef: session.trigger.module.ref,
          },
          partial,
        ),
    };

    // Step 5: Run the bounded loop.
    const result = await runLoop({
      session,
      store: new InMemorySessionStore(),
      config: stopConditionConfig,
      killSwitchPoll,
      gates,
    });

    // Step 6: Return 200 with the termination outcome.
    return {
      statusCode: 200,
      body: JSON.stringify({
        terminationReason: result.terminationReason,
        prNumber: result.prNumber,
      }),
    };
  } catch (err) {
    // Step 7: Log the error and return 500. No 200 is written in this path.
    console.error("Orchestrator Lambda failed:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String(err) }),
    };
  }
};
