/**
 * Scheduled reviewer runner.
 *
 * Entry point for the `scheduled-reviewer.yml` GitHub Actions workflow step:
 *
 *   node harness/scheduled-reviewer/run.js
 *
 * Responsibilities:
 *
 *   1. Read `agent-harness.config.json` to obtain:
 *        - `models.reviewer`                                  (model id)
 *        - `fitnessGapLoop.enabled`                           (kill switch)
 *        - `fitnessGapLoop.costGuardrail.reviewerTokenSpendCapUSD` (cost cap)
 *   2. Exit 0 immediately when `fitnessGapLoop.enabled` is false.
 *   3. Invoke the reviewer agent as a `bedrock-agentcore:InvokeHarness`
 *      call against the deployed reviewer Managed Harness. The harness
 *      itself owns the same restricted reviewer tool catalogue (Task 1's
 *      reviewer: diff-read and reference-lookup only) — no edit, deploy,
 *      CDK, or PR tools are registered. See `app/reviewer/harness.json`.
 *   4. Capture the findings output and token cost from the invocation.
 *   5. Check the cost cap: if `tokenCostUSD > reviewerTokenSpendCapUSD`,
 *      emit a failure run record and exit 1 before the auto-open step.
 *   6. Write findings to `/tmp/reviewer-findings.json` as a JSON array.
 *
 * The function `runScheduledReviewer()` is exported so it can be called
 * from tests or other harness scripts. When this module is executed
 * directly (`require.main === module`), it calls `runScheduledReviewer()`
 * and exits with the appropriate code.
 *
 * Isolation guarantee (Requirement 1.4):
 *   The reviewer is invoked as a managed-harness `InvokeHarness` call.
 *   The tool catalogue is restricted to `module.readFile`, `module.diff`,
 *   and `reference.checklist` — the same read-only surface as Task 1's
 *   reviewer. The catalogue is enforced by the harness deployment
 *   (`app/reviewer/harness.json`); the orchestrator cannot widen it at
 *   invocation time. The workflow has no AWS deploy permissions; it only
 *   needs GitHub issue-write and `bedrock-agentcore:InvokeHarness` on the
 *   reviewer harness ARN.
 *
 * Failure behaviour (Requirement 1.5):
 *   Any unhandled error causes the process to exit non-zero. GitHub Actions
 *   surfaces this as a failed workflow run visible to maintainers. There is
 *   no automatic retry; a human must re-run the workflow manually.
 *
 * Cost guardrail (Requirement 5.5):
 *   After the reviewer invocation, the token cost is compared against
 *   `fitnessGapLoop.costGuardrail.reviewerTokenSpendCapUSD`. If the cost
 *   exceeds the cap, the process exits 1 before the auto-open step runs.
 *   A failure run record is written to stdout (for CloudWatch Logs
 *   ingestion) with `outcome: "failure"` and
 *   `failureReason: "cost-cap-exceeded"`.
 *
 * Requirements: 1.1, 1.2, 1.4, 5.5
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
  type InvokeHarnessStreamOutput,
} from "@aws-sdk/client-bedrock-agentcore";

import type {
  ReviewerFinding,
  ScheduledReviewerRunRecord,
} from "../../shared/src/fitness-gap-types";

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

/**
 * The subset of `agent-harness.config.json` the scheduled reviewer needs.
 */
interface ScheduledReviewerConfig {
  readonly modelId: string;
  readonly enabled: boolean;
  readonly costCapUSD: number;
}

/**
 * Parse `agent-harness.config.json` and extract the fields the scheduled
 * reviewer needs.
 *
 * Throws with a descriptive message when required fields are missing or
 * malformed. The caller lets the throw surface; a misconfigured harness is
 * a build-time error, not a runtime condition the reviewer can recover from.
 */
export function parseScheduledReviewerConfig(
  raw: string,
  configPath: string,
): ScheduledReviewerConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${configPath}: not valid JSON: ${message}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${configPath}: expected a JSON object at the root`);
  }

  const config = parsed as Record<string, unknown>;

  // models.reviewer
  const models = config["models"];
  if (typeof models !== "object" || models === null) {
    throw new Error(`${configPath}: missing required 'models' object`);
  }
  const reviewer = (models as Record<string, unknown>)["reviewer"];
  if (typeof reviewer !== "string" || reviewer.length === 0) {
    throw new Error(
      `${configPath}: missing required 'models.reviewer' string`,
    );
  }

  // fitnessGapLoop
  const fitnessGapLoop = config["fitnessGapLoop"];
  if (typeof fitnessGapLoop !== "object" || fitnessGapLoop === null) {
    throw new Error(
      `${configPath}: missing required 'fitnessGapLoop' object`,
    );
  }
  const fgl = fitnessGapLoop as Record<string, unknown>;

  // fitnessGapLoop.enabled
  const enabled = fgl["enabled"];
  if (typeof enabled !== "boolean") {
    throw new Error(
      `${configPath}: 'fitnessGapLoop.enabled' must be a boolean`,
    );
  }

  // fitnessGapLoop.costGuardrail.reviewerTokenSpendCapUSD
  const costGuardrail = fgl["costGuardrail"];
  if (typeof costGuardrail !== "object" || costGuardrail === null) {
    throw new Error(
      `${configPath}: missing required 'fitnessGapLoop.costGuardrail' object`,
    );
  }
  const capRaw = (costGuardrail as Record<string, unknown>)[
    "reviewerTokenSpendCapUSD"
  ];
  if (typeof capRaw !== "number" || !Number.isFinite(capRaw) || capRaw < 0) {
    throw new Error(
      `${configPath}: 'fitnessGapLoop.costGuardrail.reviewerTokenSpendCapUSD' must be a non-negative number`,
    );
  }

  return {
    modelId: reviewer,
    enabled,
    costCapUSD: capRaw,
  };
}

// ---------------------------------------------------------------------------
// Managed Harness reviewer invocation
// ---------------------------------------------------------------------------

/**
 * Result of a standalone reviewer agent invocation.
 *
 * Production: produced by `ManagedHarnessReviewerInvocation` from the
 * streaming `InvokeHarness` response.
 *
 * Tests: returned by a controlled stub registered as the
 * `reviewerInvocation` option to `runScheduledReviewer()`.
 */
export interface StandaloneReviewerResult {
  /** Findings produced by the reviewer agent. */
  readonly findings: ReadonlyArray<ReviewerFinding>;
  /** Estimated token cost in USD for this invocation. */
  readonly tokenCostUSD: number;
  /** Model version string returned by the Bedrock invocation. */
  readonly modelVersion: string;
}

/**
 * Optional input to a standalone reviewer invocation.
 *
 * The scheduled-reviewer entry point invokes the reviewer with no diff
 * (the reviewer reads the current state of the module on `main`).
 * In-loop callers (the orchestrator's `runReviewer` gate) supply the
 * diff produced by the most recent editor turn.
 */
export interface StandaloneReviewerInvocationInput {
  /** Optional diff for the reviewer to consider. Absent in scheduled mode. */
  readonly diff?: string;
}

/**
 * Single-method interface for the standalone reviewer invocation.
 *
 * Production: `ManagedHarnessReviewerInvocation`, which calls
 * `InvokeHarness` against the deployed reviewer Managed Harness.
 *
 * Tests: a controlled stub that returns a fixed `StandaloneReviewerResult`.
 *
 * The interface is intentionally narrow: one method, one optional input,
 * one output. This keeps the scheduled runner decoupled from the AWS SDK
 * so the runner can be unit-tested without a live Bedrock dependency.
 */
export interface StandaloneReviewerInvocation {
  invoke(input?: StandaloneReviewerInvocationInput): Promise<StandaloneReviewerResult>;
}

// ---------------------------------------------------------------------------
// ReviewerHarnessClient — thin SDK wrapper
// ---------------------------------------------------------------------------

/**
 * Construction options for `ReviewerHarnessClient` and
 * `ManagedHarnessReviewerInvocation`.
 *
 * `client` is optional and defaults to a freshly-constructed
 * `BedrockAgentCoreClient({})` that picks up region and credentials from
 * the AWS SDK chain. Tests inject a mocked client via
 * `aws-sdk-client-mock` so no real AWS traffic is required.
 */
export interface ReviewerHarnessClientOptions {
  /** ARN of the reviewer Managed Harness produced by `agentcore deploy`. */
  readonly harnessArn: string;
  /**
   * Session id for the orchestrator's session. The reviewer harness is
   * invoked with `<sessionId>-reviewer` to keep editor and reviewer
   * sessions distinct in AgentCore's session store while remaining
   * traceable back to the orchestrator's session id (per design.md).
   */
  readonly sessionId: string;
  /**
   * Pre-built SDK client. Defaults to `new BedrockAgentCoreClient({})`.
   * Tests pass an `aws-sdk-client-mock`-backed instance.
   */
  readonly client?: BedrockAgentCoreClient;
}

/**
 * Raw result of a single `InvokeHarness` round trip, before parsing into
 * a `StandaloneReviewerResult`. Surfaced so the parent invocation class
 * can decide on the partial-result population strategy without
 * re-walking the stream.
 */
interface ReviewerStreamResult {
  /** Concatenated text content from the assistant's final message. */
  readonly assistantText: string;
  /**
   * Total tokens consumed by this turn, taken from the SDK's
   * `metadata.usage` event. `undefined` when the harness did not emit
   * a metadata event with usage info.
   */
  readonly totalTokens: number | undefined;
}

/**
 * Thin wrapper around `bedrock-agentcore:InvokeHarness` for the reviewer
 * harness.
 *
 * Builds the `InvokeHarnessCommand` with `<sessionId>-reviewer` as the
 * runtime session id, sends the diff (or an empty input in scheduled
 * mode) as the user's first content block, and walks the streaming
 * response collecting:
 *
 *   - the assistant's final text content (the reviewer's structured
 *     JSON output, parsed by the parent invocation class), and
 *   - the metadata event's `usage.totalTokens` for cost computation.
 *
 * In-band server-side errors (`internalServerException`,
 * `validationException`, `runtimeClientError`) are re-thrown so the
 * parent's malformed-response handling treats them uniformly with SDK
 * throws. Tool-use and tool-result blocks executed during the harness's
 * own internal loop are ignored at this layer: the reviewer's tools run
 * inside the harness and produce no orchestrator-visible state.
 */
export class ReviewerHarnessClient {
  private readonly client: BedrockAgentCoreClient;
  private readonly harnessArn: string;
  private readonly runtimeSessionId: string;

  public constructor(options: ReviewerHarnessClientOptions) {
    this.harnessArn = options.harnessArn;
    this.runtimeSessionId = `${options.sessionId}-reviewer`;
    this.client = options.client ?? new BedrockAgentCoreClient({});
  }

  /**
   * Issue an `InvokeHarness` call to the reviewer harness with the
   * supplied diff (or an empty input in scheduled mode) and return the
   * raw stream result.
   *
   * SDK throws (network, throttling, access-denied, validation)
   * propagate without being caught; the parent invocation class
   * decides whether to populate partial fields and re-throw.
   */
  public async invoke(
    input?: StandaloneReviewerInvocationInput,
  ): Promise<ReviewerStreamResult> {
    // Serialise input as a single user message. The harness has its
    // system prompt and tool catalogue baked in (see app/reviewer/harness.json
    // and agents/reviewer/system.md); the user turn only carries the diff
    // the agent should review. In scheduled mode (no diff supplied), the
    // reviewer reads the module state directly via its module.readFile
    // tool, so we pass an empty payload.
    const userMessage = JSON.stringify({ diff: input?.diff ?? null });

    const command = new InvokeHarnessCommand({
      harnessArn: this.harnessArn,
      runtimeSessionId: this.runtimeSessionId,
      messages: [
        {
          role: "user",
          content: [{ text: userMessage }],
        },
      ],
    });

    const response = await this.client.send(command);

    if (response.stream === undefined) {
      throw new Error(
        "ReviewerHarnessClient: InvokeHarness response did not include a " +
          "stream. This indicates a malformed SDK response.",
      );
    }

    return this.walkStream(response.stream);
  }

  /**
   * Walk the streaming response and accumulate the assistant's final
   * text content and the metadata's token usage.
   */
  private async walkStream(
    stream: AsyncIterable<InvokeHarnessStreamOutput>,
  ): Promise<ReviewerStreamResult> {
    /** Per-block-index accumulator for assistant text content blocks. */
    const textBlocks = new Map<number, string[]>();
    /** Order in which text blocks completed, so we can use the *last* one. */
    const finishedTextBlocks: string[] = [];

    let totalTokens: number | undefined;
    let sawMessageStop = false;

    for await (const event of stream) {
      // Surface server-side errors as throws so the parent's
      // malformed-response handling treats them uniformly with SDK throws.
      if (event.internalServerException !== undefined) {
        throw new Error(
          "ReviewerHarnessClient: InternalServerException from harness: " +
            (event.internalServerException.message ?? "(no message)"),
        );
      }
      if (event.validationException !== undefined) {
        throw new Error(
          "ReviewerHarnessClient: ValidationException from harness: " +
            `${event.validationException.message} ` +
            `(reason=${event.validationException.reason})`,
        );
      }
      if (event.runtimeClientError !== undefined) {
        throw new Error(
          "ReviewerHarnessClient: RuntimeClientError from harness: " +
            (event.runtimeClientError.message ?? "(no message)"),
        );
      }

      if (event.contentBlockStart !== undefined) {
        const idx = event.contentBlockStart.contentBlockIndex;
        const start = event.contentBlockStart.start;
        if (idx === undefined) continue;
        // Only track plain text blocks. Tool-use and tool-result blocks
        // are the harness's internal loop and produce no
        // orchestrator-visible state.
        if (start === undefined || (start.toolUse === undefined && start.toolResult === undefined)) {
          textBlocks.set(idx, []);
        }
        continue;
      }
      if (event.contentBlockDelta !== undefined) {
        const idx = event.contentBlockDelta.contentBlockIndex;
        const delta = event.contentBlockDelta.delta;
        if (idx === undefined || delta === undefined) continue;
        const fragments = textBlocks.get(idx);
        if (fragments === undefined) continue;
        if (delta.text !== undefined) {
          fragments.push(delta.text);
        }
        continue;
      }
      if (event.contentBlockStop !== undefined) {
        const idx = event.contentBlockStop.contentBlockIndex;
        if (idx === undefined) continue;
        const fragments = textBlocks.get(idx);
        if (fragments === undefined) continue;
        textBlocks.delete(idx);
        finishedTextBlocks.push(fragments.join(""));
        continue;
      }
      if (event.messageStop !== undefined) {
        sawMessageStop = true;
        // Don't break: the harness usually emits a `metadata` event
        // after `messageStop`. Keep draining until the iterator ends.
        continue;
      }
      if (event.metadata !== undefined) {
        const usage = event.metadata.usage;
        if (usage !== undefined) {
          totalTokens = usage.totalTokens;
        }
        continue;
      }
      // Other event kinds (messageStart) carry no information we need.
    }

    if (!sawMessageStop) {
      throw new Error(
        "ReviewerHarnessClient: harness stream ended without a messageStop " +
          "event. Treating as a malformed response.",
      );
    }

    // The reviewer's structured JSON output is the *last* assistant text
    // block. Earlier text blocks (if any) are reasoning the agent emitted
    // before its final answer; the system prompt instructs the model to
    // emit only one JSON object as its final message.
    const assistantText =
      finishedTextBlocks.length > 0
        ? finishedTextBlocks[finishedTextBlocks.length - 1]
        : "";

    return { assistantText, totalTokens };
  }
}

// ---------------------------------------------------------------------------
// ManagedHarnessReviewerInvocation
// ---------------------------------------------------------------------------

/**
 * Per-token cost rate used to convert the harness's reported token usage
 * into a USD estimate for the cost guardrail.
 *
 * The exact USD-per-token rate depends on the model in use (the reviewer
 * harness reads `models.reviewer` from `agent-harness.config.json`). Rather
 * than embedding a per-model price table here — which would drift from
 * AWS pricing and would have to be updated whenever AWS publishes a new
 * tier — we use a single conservative estimate. The cost guardrail's job
 * is to halt run-away spend, not to perform billing-grade accounting; an
 * approximate rate is sufficient for that purpose. The value is the
 * input+output blended rate for `us.anthropic.claude-sonnet-4-6-v1:0` on
 * Bedrock at the time of writing, expressed in USD per token.
 *
 * If the reviewer harness uses a different model, update this constant
 * (or, in a future spec, source it from `agent-harness.config.json`).
 */
const ESTIMATED_USD_PER_TOKEN = 0.000006;

/**
 * Default model version returned when the harness's response does not
 * carry one. The streaming events from `InvokeHarness` do not currently
 * expose the resolved model id; the reviewer harness's deployment
 * declares it via `app/reviewer/harness.json`. Until the SDK or the
 * agent's structured output surfaces a runtime version, we record
 * "unknown" so the run record's `modelVersion` field is populated rather
 * than missing.
 */
const UNKNOWN_MODEL_VERSION = "unknown";

/**
 * Standalone reviewer invocation backed by AWS Bedrock AgentCore Managed
 * Harness.
 *
 * Replaces the prior placeholder implementation (which threw on every
 * call). On `invoke({ diff }?)`:
 *
 *   1. Delegate to `ReviewerHarnessClient` to issue `InvokeHarness` and
 *      walk the streaming response, collecting the assistant's final
 *      text content and the metadata's token usage.
 *   2. Parse the assistant text as a `ReviewerOutput` JSON object and
 *      extract `findings`. The reviewer's system prompt instructs the
 *      model to emit exactly one JSON object matching the
 *      `ReviewerOutput` schema; deviations are surfaced via the
 *      partial-result fallback below.
 *   3. Compute `tokenCostUSD` from the metadata's `totalTokens` using
 *      `ESTIMATED_USD_PER_TOKEN`. Defaults to `0` when the harness did
 *      not emit a metadata event with usage info.
 *   4. Record `modelVersion` from the parsed output if present, else
 *      `UNKNOWN_MODEL_VERSION`.
 *   5. Return a `StandaloneReviewerResult`.
 *
 * On a malformed response (Requirement 2.6):
 *
 *   - When the assistant text is absent or unparseable as JSON, default
 *     `findings` to `[]`.
 *   - When the parsed object's `findings` field is absent or not an
 *     array of valid finding objects, default it to `[]`.
 *   - When `totalTokens` is absent from the metadata, default
 *     `tokenCostUSD` to `0`.
 *
 * Partial-result population happens *before* the parse error is
 * propagated. The caller (`runScheduledReviewer()`) sees the throw and
 * exits non-zero; the partial fields are recorded for diagnostics on
 * the way through.
 *
 * Implements `StandaloneReviewerInvocation` so callers (the existing
 * scheduled-reviewer entry point and, in a later task, the orchestrator
 * Lambda) can inject a stub for unit tests without changing shape.
 *
 * Constructor takes `{ harnessArn, sessionId, client? }`; the client is
 * injectable for tests.
 */
export class ManagedHarnessReviewerInvocation
  implements StandaloneReviewerInvocation
{
  private readonly harnessClient: ReviewerHarnessClient;

  public constructor(options: ReviewerHarnessClientOptions) {
    this.harnessClient = new ReviewerHarnessClient(options);
  }

  public async invoke(
    input?: StandaloneReviewerInvocationInput,
  ): Promise<StandaloneReviewerResult> {
    // Step 1: Issue InvokeHarness and walk the stream. SDK throws and
    // in-band server errors propagate; the caller treats them as a
    // run failure and exits non-zero.
    const stream = await this.harnessClient.invoke(input);

    // Step 2: Compute tokenCostUSD. Default to 0 when usage was missing.
    const tokenCostUSD =
      stream.totalTokens !== undefined
        ? stream.totalTokens * ESTIMATED_USD_PER_TOKEN
        : 0;

    // Step 3: Parse the assistant's JSON output. Track the parse error
    // separately so we can populate partial-result fields *before*
    // re-throwing per Requirement 2.6.
    let parsed: unknown;
    let parseError: Error | undefined;
    if (stream.assistantText.trim().length === 0) {
      parseError = new Error(
        "ManagedHarnessReviewerInvocation: harness response contained no " +
          "assistant text. Expected a ReviewerOutput JSON object.",
      );
    } else {
      try {
        parsed = JSON.parse(stream.assistantText);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        parseError = new Error(
          "ManagedHarnessReviewerInvocation: failed to parse assistant " +
            `text as JSON: ${message}`,
        );
      }
    }

    // Step 4: Extract findings, defaulting to [] when absent or
    // malformed.
    const findings = extractFindings(parsed);

    // Step 5: Extract modelVersion, defaulting when absent.
    const modelVersion = extractModelVersion(parsed);

    const result: StandaloneReviewerResult = {
      findings,
      tokenCostUSD,
      modelVersion,
    };

    // Requirement 2.6: when the response is malformed (parse failure or
    // findings missing/malformed in a way that signals broader corruption),
    // populate the partial fields above and *then* propagate the parse
    // error. A successful parse with valid findings short-circuits the
    // throw and returns the result directly.
    if (parseError !== undefined) {
      // Attach the partial result to the error for diagnostics. Callers
      // that catch this throw can recover the partial result via
      // `(err as Error & { partialResult?: StandaloneReviewerResult }).partialResult`.
      const enriched = parseError as Error & {
        partialResult?: StandaloneReviewerResult;
      };
      enriched.partialResult = result;
      throw enriched;
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// Internal parsing helpers
// ---------------------------------------------------------------------------

/**
 * Severity values the reviewer's output schema permits, mirroring the
 * `ReviewerSeverity` type and the system prompt's enum. Used to filter
 * out malformed findings from the parsed JSON without dragging the
 * shared types module's enum into runtime checks (which would couple
 * runtime parsing to the type module's compile-time-only declaration).
 */
const VALID_SEVERITIES = new Set<string>([
  "info",
  "low",
  "medium",
  "high",
  "critical",
]);

/**
 * Extract a `findings` array from the parsed assistant JSON, returning
 * `[]` on any deviation from the expected shape. This is the partial
 * fallback path for Requirement 2.6: a malformed `findings` field
 * defaults to an empty array rather than throwing inside the parser.
 *
 * The shape check enforces the same fields the reviewer's system prompt
 * requires (`id`, `pillar`, `severity`, `description`, `suggestedFix`)
 * and the optional `file`/`line` pair. Findings missing required fields
 * or carrying invalid `severity` values are dropped silently — they're
 * indistinguishable from the agent emitting partial output.
 */
function extractFindings(parsed: unknown): ReadonlyArray<ReviewerFinding> {
  if (parsed === null || typeof parsed !== "object") return [];
  const findingsRaw = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findingsRaw)) return [];

  const valid: ReviewerFinding[] = [];
  for (const candidate of findingsRaw) {
    if (candidate === null || typeof candidate !== "object") continue;
    const c = candidate as Record<string, unknown>;
    if (
      typeof c.id !== "string" ||
      c.id.length === 0 ||
      typeof c.pillar !== "string" ||
      c.pillar.length === 0 ||
      typeof c.severity !== "string" ||
      !VALID_SEVERITIES.has(c.severity) ||
      typeof c.description !== "string" ||
      typeof c.suggestedFix !== "string"
    ) {
      continue;
    }
    const finding: ReviewerFinding = {
      id: c.id,
      pillar: c.pillar,
      severity: c.severity as ReviewerFinding["severity"],
      description: c.description,
      suggestedFix: c.suggestedFix,
      ...(typeof c.file === "string" && c.file.length > 0
        ? { file: c.file }
        : {}),
      ...(typeof c.line === "number" && Number.isInteger(c.line) && c.line > 0
        ? { line: c.line }
        : {}),
    };
    valid.push(finding);
  }
  return valid;
}

/**
 * Extract the `modelVersion` field from the parsed assistant JSON, if
 * the reviewer chose to include one. Falls back to a placeholder when
 * absent: the SDK's streaming events do not currently carry the
 * resolved model id.
 */
function extractModelVersion(parsed: unknown): string {
  if (parsed === null || typeof parsed !== "object") return UNKNOWN_MODEL_VERSION;
  const candidate = (parsed as { modelVersion?: unknown }).modelVersion;
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }
  return UNKNOWN_MODEL_VERSION;
}

// ---------------------------------------------------------------------------
// Run record helpers
// ---------------------------------------------------------------------------

/**
 * Build a run ID from the current ISO timestamp.
 *
 * Format: `scheduled-reviewer-run-<iso-timestamp>` with colons replaced
 * by hyphens so the ID is safe to use as a file name or log key.
 */
export function buildRunId(timestamp: string): string {
  return `scheduled-reviewer-run-${timestamp.replace(/:/g, "-")}`;
}

/**
 * Count findings by severity.
 *
 * Returns a record keyed by severity string with integer counts. Only
 * severities that appear in the findings are included; the caller should
 * not assume all five severity levels are present.
 */
export function countFindingsBySeverity(
  findings: ReadonlyArray<ReviewerFinding>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  }
  return counts;
}

/**
 * Emit a `ScheduledReviewerRunRecord` to stdout as a single-line JSON
 * object.
 *
 * The GitHub Actions log ingestion picks this up and forwards it to
 * CloudWatch Logs at `/agent-harness/scheduled-reviewer`. Writing to
 * stdout (rather than a file) keeps the emitter side-effect free and
 * testable without a CloudWatch SDK dependency.
 */
export function emitRunRecord(record: ScheduledReviewerRunRecord): void {
  process.stdout.write(JSON.stringify(record) + "\n");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Options for `runScheduledReviewer`. Tests inject these to control the
 * config path, the reviewer invocation, and the findings output path.
 */
export interface RunScheduledReviewerOptions {
  /**
   * Absolute path to `agent-harness.config.json`.
   * Default: repo root (three levels up from this file's compiled location).
   */
  readonly configPath?: string;
  /**
   * Reviewer invocation to use.
   *
   * Default: a `ManagedHarnessReviewerInvocation` constructed from the
   * `REVIEWER_HARNESS_ARN` environment variable (supplied by the
   * scheduled-reviewer workflow). The session id is derived from the
   * run timestamp so AgentCore's session store keeps each scheduled
   * run distinct. Tests inject a controlled stub via this option so
   * `runScheduledReviewer()` can be unit-tested without an SDK call.
   *
   * The scheduled workflow supplies `REVIEWER_HARNESS_ARN` as an env var
   * (see `.github/workflows/scheduled-reviewer.yml`); for tests in this
   * package the stub is supplied directly and the env var is never read.
   */
  readonly reviewerInvocation?: StandaloneReviewerInvocation;
  /**
   * Path to write the findings JSON array.
   * Default: `/tmp/reviewer-findings.json`.
   */
  readonly findingsOutputPath?: string;
}

/**
 * Run the scheduled reviewer.
 *
 * Steps:
 *   1. Read and parse `agent-harness.config.json`.
 *   2. Exit 0 immediately if `fitnessGapLoop.enabled` is false.
 *   3. Invoke the reviewer agent.
 *   4. Check cost cap; exit 1 if exceeded (emits failure run record).
 *   5. Write findings to the output path as a JSON array.
 *
 * Returns the `StandaloneReviewerResult` on success so callers (e.g., the
 * emit-run-record step) can read the findings and cost without re-parsing
 * the output file.
 *
 * Throws on any unrecoverable error (config parse failure, reviewer
 * invocation failure). The `require.main` guard below converts throws to
 * `process.exit(1)`.
 */
export async function runScheduledReviewer(
  options: RunScheduledReviewerOptions = {},
): Promise<StandaloneReviewerResult | null> {
  const configPath = options.configPath ?? defaultConfigPath();
  const findingsOutputPath =
    options.findingsOutputPath ?? "/tmp/reviewer-findings.json";

  // Step 1: Read and parse config.
  const configRaw = readFileSync(configPath, "utf8");
  const config = parseScheduledReviewerConfig(configRaw, configPath);

  // Step 2: Kill switch — exit 0 immediately when disabled.
  // Requirement 6.4: disable-able via a single configuration flag.
  if (!config.enabled) {
    process.stdout.write(
      "fitnessGapLoop.enabled is false — scheduled reviewer is disabled. Exiting 0.\n",
    );
    return null;
  }

  // Step 3: Invoke the reviewer agent.
  // Requirement 1.4: standalone managed-harness InvokeHarness call, same
  // tool catalogue as Task 1's reviewer (diff-read and reference-lookup
  // only) — enforced by the harness deployment, not by this caller.
  const invocation =
    options.reviewerInvocation ?? defaultReviewerInvocation();
  const result = await invocation.invoke();

  const timestamp = new Date().toISOString();
  const runId = buildRunId(timestamp);

  // Step 4: Check cost cap.
  // Requirement 5.5: fail loudly if reviewer cost crosses the configured
  // threshold. Exit non-zero before the auto-open step.
  if (result.tokenCostUSD > config.costCapUSD) {
    const failureRecord: ScheduledReviewerRunRecord = {
      schemaVersion: "1.0",
      runId,
      timestamp,
      modelId: config.modelId,
      modelVersion: result.modelVersion,
      outcome: "failure",
      failureReason: "cost-cap-exceeded",
      findingsBySeverity: countFindingsBySeverity(result.findings),
      issuesOpened: 0,
      duplicatesSkipped: 0,
      tokenCostUSD: result.tokenCostUSD,
    };
    emitRunRecord(failureRecord);
    process.stderr.write(
      `Scheduled reviewer cost cap exceeded: ` +
        `tokenCostUSD=${result.tokenCostUSD} > cap=${config.costCapUSD}. ` +
        `Exiting 1.\n`,
    );
    process.exit(1);
  }

  // Step 5: Write findings to the output path.
  // Requirement 1.2: produce the same structured checklist output as Task 1.
  // The auto-open step reads this file via:
  //   node harness/auto-open/run.js --findings /tmp/reviewer-findings.json
  const findingsJson = JSON.stringify(Array.from(result.findings), null, 2);
  writeFileSync(findingsOutputPath, findingsJson, "utf8");

  process.stdout.write(
    `Scheduled reviewer completed: ` +
      `${result.findings.length} finding(s), ` +
      `tokenCostUSD=${result.tokenCostUSD}. ` +
      `Findings written to ${findingsOutputPath}.\n`,
  );

  return result;
}

// ---------------------------------------------------------------------------
// Direct execution guard
// ---------------------------------------------------------------------------

/**
 * Default path to `agent-harness.config.json`.
 *
 * `__dirname` resolves to `harness/scheduled-reviewer/src` (or its
 * compiled equivalent). The config lives at the repo root, three levels up.
 */
function defaultConfigPath(): string {
  return resolve(__dirname, "..", "..", "..", "agent-harness.config.json");
}

/**
 * Default `StandaloneReviewerInvocation` used by `runScheduledReviewer()`
 * when the caller did not inject one.
 *
 * Reads the reviewer harness ARN from the `REVIEWER_HARNESS_ARN`
 * environment variable. The scheduled-reviewer workflow
 * (`.github/workflows/scheduled-reviewer.yml`) supplies this env var;
 * if it is missing, construction throws so the
 * scheduled run fails loudly rather than silently invoking against an
 * undefined harness.
 *
 * The session id is a per-run timestamp string so AgentCore keeps each
 * scheduled run's session distinct from any other session in flight.
 */
function defaultReviewerInvocation(): StandaloneReviewerInvocation {
  const harnessArn = process.env.REVIEWER_HARNESS_ARN;
  if (typeof harnessArn !== "string" || harnessArn.length === 0) {
    throw new Error(
      "runScheduledReviewer: REVIEWER_HARNESS_ARN environment variable is " +
        "required when no reviewerInvocation is supplied. The scheduled-" +
        "reviewer workflow injects this from the deployed reviewer harness " +
        "ARN; supply it explicitly when invoking from a script or test.",
    );
  }
  const sessionId = `scheduled-reviewer-${new Date().toISOString().replace(/:/g, "-")}`;
  return new ManagedHarnessReviewerInvocation({ harnessArn, sessionId });
}

// Run when executed directly: `node harness/scheduled-reviewer/run.js`
if (require.main === module) {
  runScheduledReviewer()
    .then((result) => {
      // null means the kill switch fired; exit 0 was already called inside
      // runScheduledReviewer. If we reach here with null, exit 0 again to
      // be safe (process.exit inside the function may not have been reached
      // in all code paths during testing).
      if (result === null) {
        process.exit(0);
      }
      // Success: the auto-open step runs next in the workflow.
      process.exit(0);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Scheduled reviewer failed: ${message}\n`);
      if (err instanceof Error && err.stack) {
        process.stderr.write(err.stack + "\n");
      }
      process.exit(1);
    });
}
