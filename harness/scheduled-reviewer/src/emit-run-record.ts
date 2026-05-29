/**
 * Emitter for `ScheduledReviewerRunRecord`.
 *
 * Writes a single structured log event to CloudWatch Logs at
 * `/agent-harness/scheduled-reviewer` after every scheduled reviewer
 * invocation, on both success and failure paths.
 *
 * Each run gets its own log stream named after `record.runId` so that
 * CloudWatch Insights queries can correlate all events for a single run
 * without filtering.
 *
 * Error handling: CloudWatch errors are logged to stderr and swallowed.
 * Emitting the run record must never fail the workflow — it is
 * observability infrastructure, not a correctness gate.
 *
 * Requirements: 5.1
 */

import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand,
  ResourceAlreadyExistsException,
} from "@aws-sdk/client-cloudwatch-logs";

import type { ScheduledReviewerRunRecord } from "../../shared/src/fitness-gap-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * CloudWatch Logs group that receives all scheduled reviewer run records.
 * Matches the log group documented in `design.md`'s Observability section.
 */
export const LOG_GROUP_NAME = "/agent-harness/scheduled-reviewer";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emits a `ScheduledReviewerRunRecord` to CloudWatch Logs.
 *
 * Creates the log group and log stream if they do not already exist, then
 * puts a single log event containing the record serialised as JSON.
 *
 * The log stream is named after `record.runId` (one stream per run).
 *
 * On any CloudWatch error the function logs to stderr and returns without
 * throwing, so the caller's workflow is never failed by an observability
 * side-effect.
 *
 * @param record - The run record to emit.
 * @param client - Optional pre-constructed `CloudWatchLogsClient`. When
 *   omitted a default client is constructed (uses ambient AWS credentials
 *   and the `AWS_REGION` / `AWS_DEFAULT_REGION` environment variables).
 */
export async function emitRunRecord(
  record: ScheduledReviewerRunRecord,
  client?: CloudWatchLogsClient,
): Promise<void> {
  const logs = client ?? new CloudWatchLogsClient({});

  try {
    await ensureLogGroup(logs);
    await ensureLogStream(logs, record.runId);
    await putLogEvent(logs, record);
  } catch (err) {
    // Observability must not fail the workflow.
    process.stderr.write(
      `[emit-run-record] Failed to emit ScheduledReviewerRunRecord: ${String(err)}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
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
 * Creates a log stream named after the run ID if it does not already exist.
 * Silently ignores `ResourceAlreadyExistsException`.
 */
async function ensureLogStream(
  client: CloudWatchLogsClient,
  runId: string,
): Promise<void> {
  try {
    await client.send(
      new CreateLogStreamCommand({
        logGroupName: LOG_GROUP_NAME,
        logStreamName: runId,
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
 * The event timestamp is taken from `record.timestamp` (ISO-8601) so the
 * CloudWatch event time matches the run time rather than the emission time.
 */
async function putLogEvent(
  client: CloudWatchLogsClient,
  record: ScheduledReviewerRunRecord,
): Promise<void> {
  const timestamp = new Date(record.timestamp).getTime();

  await client.send(
    new PutLogEventsCommand({
      logGroupName: LOG_GROUP_NAME,
      logStreamName: record.runId,
      logEvents: [
        {
          timestamp,
          message: JSON.stringify(record),
        },
      ],
    }),
  );
}
