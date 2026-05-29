/**
 * Emitter for `GapClosureOutcomeRecord`.
 *
 * Writes a single structured log event to CloudWatch Logs at
 * `/agent-harness/gap-closure-outcomes` when an auto-opened issue closes
 * (merged, closed without merge, or expired past `expiryDays`).
 *
 * Triggered by the GitHub Actions `issues.closed` event. The emitter reads
 * the issue's session log to extract timing and outcome fields.
 *
 * Each issue gets its own log stream named `issue-<issueNumber>` so that
 * CloudWatch Insights queries can correlate all events for a single issue
 * without filtering.
 *
 * Error handling: CloudWatch errors are logged to stderr and swallowed.
 * Emitting the outcome record must never fail the workflow — it is
 * observability infrastructure, not a correctness gate.
 *
 * Requirements: 5.3
 */

import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand,
  ResourceAlreadyExistsException,
} from "@aws-sdk/client-cloudwatch-logs";

import type { GapClosureOutcomeRecord } from "../../shared/src/fitness-gap-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * CloudWatch Logs group that receives all gap-closure outcome records.
 * Matches the log group documented in `design.md`'s Observability section.
 */
export const LOG_GROUP_NAME = "/agent-harness/gap-closure-outcomes";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emits a `GapClosureOutcomeRecord` to CloudWatch Logs.
 *
 * Creates the log group and log stream if they do not already exist, then
 * puts a single log event containing the record serialised as JSON.
 *
 * The log stream is named `issue-<record.issueNumber>` (one stream per issue).
 *
 * On any CloudWatch error the function logs to stderr and returns without
 * throwing, so the caller's workflow is never failed by an observability
 * side-effect.
 *
 * @param record - The outcome record to emit.
 * @param client - Optional pre-constructed `CloudWatchLogsClient`. When
 *   omitted a default client is constructed (uses ambient AWS credentials
 *   and the `AWS_REGION` / `AWS_DEFAULT_REGION` environment variables).
 */
export async function emitOutcomeRecord(
  record: GapClosureOutcomeRecord,
  client?: CloudWatchLogsClient,
): Promise<void> {
  const logs = client ?? new CloudWatchLogsClient({});
  const logStreamName = `issue-${record.issueNumber}`;

  try {
    await ensureLogGroup(logs);
    await ensureLogStream(logs, logStreamName);
    await putLogEvent(logs, logStreamName, record);
  } catch (err) {
    // Observability must not fail the workflow.
    process.stderr.write(
      `[emit-outcome-record] Failed to emit GapClosureOutcomeRecord: ${String(err)}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// buildOutcomeRecord helper
// ---------------------------------------------------------------------------

/**
 * Optional session data extracted from the issue's session log.
 *
 * All fields are nullable — they are absent when the agent was never
 * dispatched, never opened a PR, or the gap-closure check was not run.
 */
export interface SessionData {
  /** Milliseconds from issue open to first PR open. */
  timeToFirstPrOpenMs?: number | null;
  /** Number of agent loop iterations. */
  agentIterations?: number | null;
  /** Outcome of the post-deploy harness on the final iteration. */
  postDeployOutcome?: "pass" | "fail" | "partial" | "deploy-failure" | null;
  /** Whether the gap-closure probe confirmed the gap was closed. */
  gapClosureOutcome?: "closed" | "not-closed" | "not-checked" | null;
}

/**
 * Builds a `GapClosureOutcomeRecord` from issue metadata and optional
 * session data.
 *
 * Extracts structured fields from the issue body using the HTML comment
 * markers and heading patterns embedded by the auto-open mechanism:
 *
 * - `findingSignature` — from `<!-- agent-harness:finding-signature:<sig> -->`
 * - `findingId` — from `## Architecture fitness gap: <id> — ...`
 * - `openedAt` — from `- **Date:** <runDate>`
 *
 * Nullable fields (`timeToFirstPrOpenMs`, `agentIterations`,
 * `postDeployOutcome`, `gapClosureOutcome`) are set to `null` when not
 * provided in `sessionData`.
 *
 * @param issueNumber  - GitHub issue number.
 * @param issueBody    - Raw issue body string (Markdown with HTML comments).
 * @param closedAt     - ISO-8601 timestamp when the issue was closed.
 * @param closeReason  - How the issue was closed.
 * @param sessionData  - Optional session log data for the issue.
 */
export function buildOutcomeRecord(
  issueNumber: number,
  issueBody: string,
  closedAt: string,
  closeReason: "merged" | "closed-without-merge" | "expired",
  sessionData?: SessionData,
): GapClosureOutcomeRecord {
  const findingSignature = extractFindingSignature(issueBody);
  const findingId = extractFindingId(issueBody);
  const openedAt = extractOpenedAt(issueBody);

  return {
    schemaVersion: "1.0",
    issueNumber,
    findingSignature,
    findingId,
    openedAt,
    closedAt,
    closeReason,
    timeToFirstPrOpenMs: sessionData?.timeToFirstPrOpenMs ?? null,
    agentIterations: sessionData?.agentIterations ?? null,
    postDeployOutcome: sessionData?.postDeployOutcome ?? null,
    gapClosureOutcome: sessionData?.gapClosureOutcome ?? null,
  };
}

// ---------------------------------------------------------------------------
// Issue body extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the finding signature from the issue body.
 *
 * Looks for: `<!-- agent-harness:finding-signature:<sig> -->`
 *
 * Returns an empty string when the marker is absent.
 */
function extractFindingSignature(issueBody: string): string {
  const match = issueBody.match(
    /<!--\s*agent-harness:finding-signature:([a-f0-9]+)\s*-->/,
  );
  return match?.[1] ?? "";
}

/**
 * Extracts the finding ID from the issue body.
 *
 * Looks for: `## Architecture fitness gap: <id> — ...`
 *
 * Returns an empty string when the heading is absent.
 */
function extractFindingId(issueBody: string): string {
  const match = issueBody.match(
    /^##\s+Architecture fitness gap:\s+([^\s—–-]+)/m,
  );
  return match?.[1] ?? "";
}

/**
 * Extracts the `openedAt` timestamp from the issue body.
 *
 * Looks for: `- **Date:** <runDate>` in the Reviewer run section.
 *
 * Returns an empty string when the date line is absent.
 */
function extractOpenedAt(issueBody: string): string {
  const match = issueBody.match(/^-\s+\*\*Date:\*\*\s+(.+)$/m);
  return match?.[1]?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// Internal CloudWatch helpers
// ---------------------------------------------------------------------------

/**
 * Creates the log group if it does not already exist.
 * Silently ignores `ResourceAlreadyExistsException`.
 */
async function ensureLogGroup(client: CloudWatchLogsClient): Promise<void> {
  try {
    await client.send(
      new CreateLogGroupCommand({ logGroupName: LOG_GROUP_NAME }),
    );
  } catch (err) {
    if (err instanceof ResourceAlreadyExistsException) {
      return;
    }
    throw err;
  }
}

/**
 * Creates a log stream if it does not already exist.
 * Silently ignores `ResourceAlreadyExistsException`.
 */
async function ensureLogStream(
  client: CloudWatchLogsClient,
  logStreamName: string,
): Promise<void> {
  try {
    await client.send(
      new CreateLogStreamCommand({
        logGroupName: LOG_GROUP_NAME,
        logStreamName,
      }),
    );
  } catch (err) {
    if (err instanceof ResourceAlreadyExistsException) {
      return;
    }
    throw err;
  }
}

/**
 * Puts a single log event containing the record serialised as JSON.
 *
 * The event timestamp is taken from `record.closedAt` (ISO-8601) so the
 * CloudWatch event time matches the issue close time rather than the
 * emission time.
 */
async function putLogEvent(
  client: CloudWatchLogsClient,
  logStreamName: string,
  record: GapClosureOutcomeRecord,
): Promise<void> {
  const timestamp = new Date(record.closedAt).getTime();

  await client.send(
    new PutLogEventsCommand({
      logGroupName: LOG_GROUP_NAME,
      logStreamName,
      logEvents: [
        {
          timestamp,
          message: JSON.stringify(record),
        },
      ],
    }),
  );
}
