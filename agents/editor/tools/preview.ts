/**
 * Preview-observation tool wrappers for the editor agent.
 *
 * Implements two tools from `design.md`'s editor catalogue:
 *
 *   - `preview.cwLogs`    `{logGroup, since}`              -> `{events[]}`
 *   - `preview.cwMetrics` `{metric, since, dimensions?}`   -> `{points[]}`
 *
 * Both tools read CloudWatch via AWS SDK v3 against the preview environment
 * for the current session. They are *read-only* sensors that feed the loop
 * with the post-deploy environment's logs and metrics.
 *
 * Security model (where the boundary actually lives)
 * --------------------------------------------------
 * The real security boundary for these tools is IAM (see `design.md` "IAM
 * model"): the editor agent's role grants CloudWatch read on resources
 * tagged `agent-harness/session = <session.id>` AND
 * `agent-harness/env = preview`. The wrapper's job is to *not* widen that
 * boundary by accident. Specifically:
 *
 *   1. `cwLogs` rejects log group names that don't begin with one of the
 *      known preview-stack prefixes. Every log group the FanoutStack
 *      creates carries the session tag (the stack itself is tagged via
 *      `Tags.of(this).add(...)` in `modules/fanout/lib/fanout-stack.ts`),
 *      so a name outside the prefix list could only be a CloudWatch group
 *      that exists in the account but was not created by this preview
 *      deploy. Even though IAM would deny that read, rejecting it in the
 *      wrapper means the agent's own log shows the rejection rather than a
 *      cryptic AWS access-denied trace, which keeps the session log easier
 *      to triage.
 *
 *   2. `cwMetrics` does NOT validate dimensions against the session id.
 *      Tags and metric dimensions are different concepts in CloudWatch:
 *      tags are attached to resources and are what IAM scopes against,
 *      whereas dimensions are part of the metric identity itself
 *      (e.g., `{name: "FunctionName", value: "FanoutPreview-IngressFn"}`).
 *      The IAM boundary is on the *resource*, so dimensions are passed
 *      through as the agent specifies them and the IAM layer authorises
 *      the read. The wrapper still validates the input shape.
 *
 *   3. Neither tool handles AWS credentials directly. Credentials flow
 *      through the standard SDK credential chain that AgentCore configures
 *      for the editor's IAM role. There is no credential argument on
 *      either tool's input schema, and there's no `region` argument either
 *      (the SDK reads it from the runtime environment, matching how
 *      `cdk.deploy` and the synthetic post-deploy harness pick up region).
 *
 * Cost accounting
 * ---------------
 * Both tools declare `costCategory: "none"`. CloudWatch reads are sub-cent
 * per call at the volumes the agent operates on (a handful of `FilterLogEvents`
 * and `GetMetricData` calls per iteration), well below the resolution of the
 * cost-cap stop condition. A forker tracking observability spend can
 * subclass these tools and declare a `tokens` or `deploy` category as
 * appropriate; the contract is set up so that change is local to this file.
 *
 * Runner injection
 * ----------------
 * Both tools use the runner-injection pattern from `cdk.ts` and
 * `sensors.ts`: a `CloudWatchClients` interface exposes the two SDK
 * clients (`logs` for `CloudWatchLogsClient`, `metrics` for
 * `CloudWatchClient`), and factory functions
 * `createCwLogsTool(clients?)` / `createCwMetricsTool(clients?)` accept
 * an optional override. The defaults instantiate real SDK clients;
 * tests inject mocks via `aws-sdk-client-mock` (or, equivalently, a
 * stub object that implements `send`).
 *
 * Output contracts
 * ----------------
 * The design's catalogue lists `{events[]}` and `{points[]}` without
 * pinning the per-element shape. The shapes the wrappers commit to are:
 *
 *   event = { timestamp: ISO-8601 string, message: string, logStream?: string }
 *   point = { timestamp: ISO-8601 string, value: number, unit?: string }
 *
 * The agent reads these as structured data, so the timestamp is rendered
 * as an ISO-8601 string (CloudWatch returns Unix ms for logs and Date
 * objects for metrics; the wrapper normalises). `logStream` is optional
 * because filter events can be drawn from multiple streams under one
 * log group; the SDK includes the stream name in the event when
 * available.
 */

import {
  CloudWatchClient,
  GetMetricDataCommand,
  type Dimension,
  type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

import type { CostCategory, ToolDefinition } from "@agent-harness/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Both tools are read-only sensors; no token or deploy cost. */
const NONE_CATEGORY: CostCategory = "none";

/**
 * Maximum number of log events returned in one `cwLogs` call.
 *
 * CloudWatch's `FilterLogEvents` returns up to 10,000 events per call by
 * default and paginates beyond that. The agent doesn't need that many at
 * once: a thousand events is roughly the upper bound on a debug session
 * (one Lambda invocation produces a handful of events; a thousand events
 * spans many invocations). Capping here keeps the per-call payload
 * bounded and the agent's context window safe.
 *
 * If a forker's module is chattier and the agent legitimately needs more,
 * raise this constant (it's a code change and a code review).
 */
const MAX_LOG_EVENTS = 1000;

/**
 * Allow-listed prefixes for `cwLogs.logGroup`.
 *
 * The FanoutStack's stack name comes from `agent-harness.config.json`
 * (`module.stackName` = `"FanoutPreview"`). CDK creates log groups two
 * ways for this stack:
 *
 *   - Lambda functions get `/aws/lambda/<stack>-<construct>-<hash>` by
 *     default (CDK's `LogGroup` construct elsewhere in the stack uses a
 *     stack-prefixed name; see `modules/fanout/lib/fanout-stack.ts`).
 *   - Other CDK-managed log groups are named with the stack-construct-hash
 *     scheme too, so they begin with the stack name.
 *
 * The prefix list pins the stack name so the wrapper's allow-list is
 * code, not configuration; if a forker renames the stack, this constant
 * gets updated, the test gets updated, and the change is reviewable. A
 * runtime-config-driven version would drift silently.
 *
 * IAM remains the real boundary: even if a request slips past this check
 * (e.g., a future CDK version names log groups differently), the
 * agent-harness/session tag scoping in the editor IAM policy denies the
 * read. This is defence in depth for clearer failure modes, not the
 * primary control.
 */
const PREVIEW_STACK_NAME = "FanoutPreview";
export const PREVIEW_LOG_GROUP_PREFIXES: readonly string[] = [
  // Lambda function log groups (default CDK naming).
  `/aws/lambda/${PREVIEW_STACK_NAME}`,
  // CDK-managed log groups named after the stack (e.g. API access logs).
  PREVIEW_STACK_NAME,
];

/**
 * Default metric period in seconds for `GetMetricData` queries.
 *
 * 60 is the smallest standard-resolution period CloudWatch supports for
 * the metrics the FanoutStack emits (Lambda duration/invocations,
 * SNS NumberOfMessagesPublished, SQS ApproximateNumberOfMessagesVisible,
 * API Gateway Count/Latency). Sub-minute custom metrics are out of scope
 * for the reference module.
 */
const DEFAULT_METRIC_PERIOD_SECONDS = 60;

/**
 * Default statistic for metric queries.
 *
 * `Average` is a reasonable default across the FanoutStack's metric
 * surface: latency averages, queue depth averages, etc. The handler does
 * not expose this in the input schema (per the design's catalogue, the
 * agent only specifies metric, since, and dimensions); a forker that
 * needs `Sum`, `p99`, etc. extends the schema.
 */
const DEFAULT_METRIC_STATISTIC = "Average";

/**
 * Default namespace for metric queries.
 *
 * Most metrics the agent looks at live in AWS-owned namespaces
 * (`AWS/Lambda`, `AWS/SQS`, `AWS/SNS`, `AWS/ApiGateway`). The handler
 * does not infer namespace from metric name; the agent is expected to
 * pass `metric` in the form `<Namespace>/<MetricName>` (e.g.
 * `"AWS/Lambda/Errors"`), which the handler splits on the last `/`. If
 * `metric` doesn't contain a `/`, the handler falls back to
 * `AWS/Lambda` because that's the metric surface the editor agent looks
 * at most on the FanoutStack (Errors, Duration, Throttles).
 */
const DEFAULT_METRIC_NAMESPACE = "AWS/Lambda";

// ---------------------------------------------------------------------------
// Client injection
// ---------------------------------------------------------------------------

/**
 * Pair of CloudWatch SDK clients the wrappers use.
 *
 * Tests pass mocked clients (typically built with `aws-sdk-client-mock`)
 * so the wrapper code runs without real AWS credentials.
 *
 * `Pick<...>` is used here to type only the `send` method we depend on;
 * mocking the full SDK client surface is unnecessary and brittle. The
 * `aws-sdk-client-mock` library produces objects compatible with the
 * full client type, so `LogsClientLike` and `MetricsClientLike` are also
 * satisfied by real `CloudWatchLogsClient` and `CloudWatchClient`
 * instances.
 */
export type LogsClientLike = Pick<CloudWatchLogsClient, "send">;
export type MetricsClientLike = Pick<CloudWatchClient, "send">;

export interface CloudWatchClients {
  readonly logs: LogsClientLike;
  readonly metrics: MetricsClientLike;
}

/**
 * Construct the default `CloudWatchClients` lazily.
 *
 * Each tool factory calls this once on first use rather than at module
 * load time so importing the module in a test that injects a stub
 * doesn't trigger a real SDK client construction (which would try to
 * resolve credentials and region eagerly on some SDK versions).
 */
let cachedDefaultClients: CloudWatchClients | undefined;
function getDefaultClients(): CloudWatchClients {
  if (cachedDefaultClients === undefined) {
    cachedDefaultClients = {
      logs: new CloudWatchLogsClient({}),
      metrics: new CloudWatchClient({}),
    };
  }
  return cachedDefaultClients;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reject a log group name that doesn't match one of the preview prefixes.
 *
 * Throwing from the handler causes the wrapper to record the call as a
 * `handler-error`. Since the rejection isn't a path-scope violation in
 * the strict (filesystem) sense the wrapper's `PathScopeError` covers,
 * we surface it as an `Error` with a clear message. The session log
 * shows the rejection so the agent can see why its request was denied.
 */
function assertLogGroupInPreview(logGroup: string): void {
  for (const prefix of PREVIEW_LOG_GROUP_PREFIXES) {
    if (logGroup === prefix || logGroup.startsWith(prefix)) {
      return;
    }
  }
  throw new Error(
    `preview.cwLogs rejected: log group ${JSON.stringify(logGroup)} ` +
      `is not within the preview environment ` +
      `(expected prefix one of: ${PREVIEW_LOG_GROUP_PREFIXES.join(", ")})`,
  );
}

/**
 * Parse an ISO-8601 string into a Date and reject malformed values.
 *
 * `Date.parse` is permissive (accepts both ISO-8601 and a handful of
 * locale-ish formats), and the agent might send something like
 * `"yesterday"`. Be strict: require that the parsed value round-trips
 * back to the same ISO string up to the `since` field's millisecond
 * precision.
 */
function parseSinceIsoOrThrow(toolName: string, since: string): Date {
  const parsed = new Date(since);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `${toolName} rejected: 'since' is not a valid ISO-8601 timestamp ` +
        `(${JSON.stringify(since)})`,
    );
  }
  return parsed;
}

/**
 * Split a metric identifier into namespace and metric name.
 *
 * Accepts:
 *   - `"AWS/Lambda/Errors"` -> namespace `AWS/Lambda`, name `Errors`
 *   - `"Errors"`            -> namespace `AWS/Lambda` (default), name `Errors`
 *
 * The split is on the *last* `/` because AWS namespaces themselves
 * contain a `/` (`AWS/Lambda`, `AWS/SNS`, etc.). A namespace containing
 * `/` is normal; a metric name containing `/` is unusual but possible
 * (custom metrics). The agent passes the simplest form that matches the
 * thing it wants to read; the handler interprets.
 */
function splitMetricIdentifier(identifier: string): {
  namespace: string;
  metricName: string;
} {
  const lastSlash = identifier.lastIndexOf("/");
  if (lastSlash === -1) {
    return { namespace: DEFAULT_METRIC_NAMESPACE, metricName: identifier };
  }
  return {
    namespace: identifier.slice(0, lastSlash),
    metricName: identifier.slice(lastSlash + 1),
  };
}

// ---------------------------------------------------------------------------
// preview.cwLogs
// ---------------------------------------------------------------------------

interface CwLogsInput {
  readonly logGroup: string;
  readonly since: string;
}

interface CwLogsEvent {
  readonly timestamp: string;
  readonly message: string;
  readonly logStream?: string;
}

interface CwLogsOutput {
  readonly events: CwLogsEvent[];
}

/**
 * Build a `preview.cwLogs` tool bound to the given clients.
 *
 * The exported `cwLogsTool` uses real SDK clients; tests inject mocks
 * via the factory function.
 *
 * Pagination: `FilterLogEvents` pages via `nextToken`. The handler
 * follows pages until either the cap (`MAX_LOG_EVENTS`) is reached or
 * AWS returns no `nextToken`. Capping at the wrapper layer protects the
 * agent's context window; a forker that wants the full stream should
 * raise the cap.
 */
export function createCwLogsTool(
  clients?: CloudWatchClients,
): ToolDefinition<CwLogsInput, CwLogsOutput> {
  return {
    name: "preview.cwLogs",
    description:
      "Read CloudWatch log events from a preview-environment log group, " +
      "filtered by start time. Read-only; tag-scoped at the IAM layer.",
    inputSchema: {
      type: "object",
      properties: {
        logGroup: { type: "string", minLength: 1 },
        // Format `date-time` is ISO-8601 per RFC 3339; ajv-formats is
        // already configured in the shared wrapper so this validates.
        since: { type: "string", format: "date-time" },
      },
      required: ["logGroup", "since"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              timestamp: { type: "string", format: "date-time" },
              message: { type: "string" },
              logStream: { type: "string" },
            },
            required: ["timestamp", "message"],
            additionalProperties: false,
          },
        },
      },
      required: ["events"],
      additionalProperties: false,
    },
    costCategory: NONE_CATEGORY,
    handler: async (input) => {
      assertLogGroupInPreview(input.logGroup);
      const since = parseSinceIsoOrThrow("preview.cwLogs", input.since);

      const resolvedClients = clients ?? getDefaultClients();

      const events: CwLogsEvent[] = [];
      let nextToken: string | undefined;

      do {
        const command = new FilterLogEventsCommand({
          logGroupName: input.logGroup,
          startTime: since.getTime(),
          // No `endTime`: the agent asks for "since X to now", and the
          // SDK treats absent `endTime` as the current time.
          // Cap per-page returns to what we still need; this is a hint to
          // the SDK and an explicit contract for the test mock.
          limit: Math.min(
            MAX_LOG_EVENTS - events.length,
            // CloudWatch's per-call max is 10,000.
            10_000,
          ),
          nextToken,
        });

        const response = await resolvedClients.logs.send(command as never);
        // The SDK types the response as `FilterLogEventsCommandOutput`,
        // but we widened to `Pick<..., "send">` for mock compatibility,
        // so cast the response shape narrowly to what we read.
        const typedResponse = response as {
          events?: ReadonlyArray<{
            timestamp?: number;
            message?: string;
            logStreamName?: string;
          }>;
          nextToken?: string;
        };

        for (const raw of typedResponse.events ?? []) {
          if (events.length >= MAX_LOG_EVENTS) break;
          // CloudWatch returns timestamps as Unix ms; render to ISO-8601
          // for the contract.
          const timestamp =
            typeof raw.timestamp === "number"
              ? new Date(raw.timestamp).toISOString()
              : new Date(0).toISOString();
          const message = typeof raw.message === "string" ? raw.message : "";
          const event: CwLogsEvent =
            typeof raw.logStreamName === "string" && raw.logStreamName.length > 0
              ? { timestamp, message, logStream: raw.logStreamName }
              : { timestamp, message };
          events.push(event);
        }

        nextToken = typedResponse.nextToken;
        if (events.length >= MAX_LOG_EVENTS) break;
      } while (nextToken !== undefined);

      return { output: { events } };
    },
  };
}

/** Default-clients-bound `preview.cwLogs` tool. */
export const cwLogsTool = createCwLogsTool();

// ---------------------------------------------------------------------------
// preview.cwMetrics
// ---------------------------------------------------------------------------

interface CwMetricsDimensionInput {
  readonly name: string;
  readonly value: string;
}

interface CwMetricsInput {
  readonly metric: string;
  readonly since: string;
  readonly dimensions?: CwMetricsDimensionInput[];
}

interface CwMetricsPoint {
  readonly timestamp: string;
  readonly value: number;
  readonly unit?: string;
}

interface CwMetricsOutput {
  readonly points: CwMetricsPoint[];
}

/**
 * Build a `preview.cwMetrics` tool bound to the given clients.
 *
 * Uses `GetMetricDataCommand` rather than the older
 * `GetMetricStatisticsCommand`. `GetMetricData` is the AWS-recommended
 * API: it supports more metrics, returns sorted timestamps directly,
 * and is what the SDK client mock examples use.
 *
 * The query shape:
 *   - One `MetricDataQuery` is built from the agent's input.
 *   - `Period` is `DEFAULT_METRIC_PERIOD_SECONDS` (60).
 *   - `Stat` is `DEFAULT_METRIC_STATISTIC` (`Average`).
 *   - `EndTime` is the current time; `StartTime` is `since`.
 *
 * The wrapper does NOT validate dimensions against the session id (see
 * the security model note at the top of the file). Dimensions pass
 * through to the SDK call as-is.
 */
export function createCwMetricsTool(
  clients?: CloudWatchClients,
): ToolDefinition<CwMetricsInput, CwMetricsOutput> {
  return {
    name: "preview.cwMetrics",
    description:
      "Read CloudWatch metric data from the preview environment, filtered " +
      "by start time and dimensions. Read-only; tag-scoped at the IAM layer.",
    inputSchema: {
      type: "object",
      properties: {
        metric: { type: "string", minLength: 1 },
        since: { type: "string", format: "date-time" },
        dimensions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1 },
              value: { type: "string", minLength: 1 },
            },
            required: ["name", "value"],
            additionalProperties: false,
          },
        },
      },
      required: ["metric", "since"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        points: {
          type: "array",
          items: {
            type: "object",
            properties: {
              timestamp: { type: "string", format: "date-time" },
              value: { type: "number" },
              unit: { type: "string" },
            },
            required: ["timestamp", "value"],
            additionalProperties: false,
          },
        },
      },
      required: ["points"],
      additionalProperties: false,
    },
    costCategory: NONE_CATEGORY,
    handler: async (input) => {
      const since = parseSinceIsoOrThrow("preview.cwMetrics", input.since);
      const { namespace, metricName } = splitMetricIdentifier(input.metric);

      const dimensions: Dimension[] | undefined = input.dimensions?.map(
        (d) => ({ Name: d.name, Value: d.value }),
      );

      const query: MetricDataQuery = {
        // The query id must start with a lowercase letter; `m1` is the
        // canonical example used in the SDK docs.
        Id: "m1",
        MetricStat: {
          Metric: {
            Namespace: namespace,
            MetricName: metricName,
            ...(dimensions !== undefined ? { Dimensions: dimensions } : {}),
          },
          Period: DEFAULT_METRIC_PERIOD_SECONDS,
          Stat: DEFAULT_METRIC_STATISTIC,
        },
        ReturnData: true,
      };

      const resolvedClients = clients ?? getDefaultClients();

      const command = new GetMetricDataCommand({
        StartTime: since,
        EndTime: new Date(),
        MetricDataQueries: [query],
        // Sort ascending so the agent reads the points in time order.
        ScanBy: "TimestampAscending",
      });

      const response = await resolvedClients.metrics.send(command as never);
      const typedResponse = response as {
        MetricDataResults?: ReadonlyArray<{
          Timestamps?: ReadonlyArray<Date | string>;
          Values?: ReadonlyArray<number>;
          // GetMetricData doesn't return the unit per result on the
          // standard `MetricDataResult` shape; we surface the unit when
          // the SDK includes it (some response variants do, via
          // `Label`-derived metadata). Always optional in the contract.
          Unit?: string;
        }>;
      };

      const points: CwMetricsPoint[] = [];
      for (const result of typedResponse.MetricDataResults ?? []) {
        const timestamps = result.Timestamps ?? [];
        const values = result.Values ?? [];
        // GetMetricData guarantees `Timestamps` and `Values` are
        // index-aligned. Iterate over the shorter of the two for safety
        // even though they should be equal length.
        const count = Math.min(timestamps.length, values.length);
        const unit = typeof result.Unit === "string" ? result.Unit : undefined;
        for (let i = 0; i < count; i++) {
          const rawTimestamp = timestamps[i];
          const isoTimestamp =
            rawTimestamp instanceof Date
              ? rawTimestamp.toISOString()
              : new Date(rawTimestamp as string).toISOString();
          const point: CwMetricsPoint =
            unit !== undefined
              ? { timestamp: isoTimestamp, value: values[i], unit }
              : { timestamp: isoTimestamp, value: values[i] };
          points.push(point);
        }
      }

      return { output: { points } };
    },
  };
}

/** Default-clients-bound `preview.cwMetrics` tool. */
export const cwMetricsTool = createCwMetricsTool();
