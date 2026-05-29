/**
 * Unit tests for the `preview.*` tool wrappers.
 *
 * Covers the verification matrix from tasks.md task 3.5: integration tests
 * with mocked CloudWatch exercise log fetch and metric fetch with
 * tag-scoped credentials.
 *
 * Tests inject mocked SDK clients via `aws-sdk-client-mock`. The mocks
 * are created against the real `CloudWatchLogsClient` and
 * `CloudWatchClient` constructors and then exposed through the
 * wrapper's `CloudWatchClients` injection point so the wrapper code
 * runs with no real AWS credentials needed.
 *
 * The IAM tag-scoping is enforced at the AWS layer (see `design.md`
 * "IAM model"); these tests verify the wrapper's contributions to the
 * security model — log group prefix rejection, schema validation, and
 * faithful pass-through of dimensions.
 */

import {
  CloudWatchClient,
  GetMetricDataCommand,
  type Dimension,
} from "@aws-sdk/client-cloudwatch";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { mockClient, type AwsClientStub } from "aws-sdk-client-mock";

import {
  wrapTool,
  type SessionSink,
  type ToolInvocationRecord,
  type WrapperRuntime,
} from "@agent-harness/shared";

import {
  PREVIEW_LOG_GROUP_PREFIXES,
  createCwLogsTool,
  createCwMetricsTool,
} from "../tools/preview";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

class InMemorySink implements SessionSink {
  public records: ToolInvocationRecord[] = [];
  public async appendToolRecord(record: ToolInvocationRecord): Promise<void> {
    this.records.push(record);
  }
}

interface Fixture {
  readonly sink: InMemorySink;
  readonly runtime: WrapperRuntime;
}

function makeFixture(): Fixture {
  // No filesystem temp dir needed: the preview wrappers don't touch the
  // module root. `moduleRoot` still has to be set on the runtime
  // (the wrapper's type contract requires it), so a synthetic absolute
  // path stands in. Using a path that doesn't exist is fine because the
  // wrappers don't have a `pathField` and never resolve filesystem
  // paths.
  const sink = new InMemorySink();
  const runtime: WrapperRuntime = {
    moduleRoot: "/synthetic/module-root-for-preview-tests",
    sessionSink: sink,
    sessionId: "session-test-preview",
    iterationIndex: 0,
  };
  return { sink, runtime };
}

interface Mocks {
  readonly logsMock: AwsClientStub<CloudWatchLogsClient>;
  readonly metricsMock: AwsClientStub<CloudWatchClient>;
  readonly clients: {
    readonly logs: CloudWatchLogsClient;
    readonly metrics: CloudWatchClient;
  };
}

/** Build a fresh pair of mocked clients for one test. */
function makeMocks(): Mocks {
  const logsMock = mockClient(CloudWatchLogsClient);
  const metricsMock = mockClient(CloudWatchClient);
  // `mockClient` mutates the prototype of the constructor, so any new
  // instance routes through the mock. Constructing the clients here
  // (vs. accepting one off the global default) keeps the tests
  // self-contained.
  const clients = {
    logs: new CloudWatchLogsClient({}),
    metrics: new CloudWatchClient({}),
  };
  return { logsMock, metricsMock, clients };
}

// ---------------------------------------------------------------------------
// preview.cwLogs
// ---------------------------------------------------------------------------

describe("preview.cwLogs", () => {
  let fixture: Fixture;
  let mocks: Mocks;

  beforeEach(() => {
    fixture = makeFixture();
    mocks = makeMocks();
  });

  afterEach(() => {
    mocks.logsMock.restore();
    mocks.metricsMock.restore();
  });

  it("happy path: returns events transformed into the typed output", async () => {
    // Mock CloudWatch to return two events from one stream and one from
    // another, plus no nextToken so pagination terminates immediately.
    const t1 = Date.UTC(2024, 0, 15, 10, 0, 0); // 2024-01-15T10:00:00Z
    const t2 = Date.UTC(2024, 0, 15, 10, 0, 1);
    const t3 = Date.UTC(2024, 0, 15, 10, 0, 2);
    mocks.logsMock.on(FilterLogEventsCommand).resolves({
      events: [
        {
          timestamp: t1,
          message: "ingress: received",
          logStreamName: "2024/01/15/[$LATEST]abc",
        },
        {
          timestamp: t2,
          message: "ingress: published",
          logStreamName: "2024/01/15/[$LATEST]abc",
        },
        {
          timestamp: t3,
          message: "egress: consumed",
          logStreamName: "2024/01/15/[$LATEST]xyz",
        },
      ],
      // No nextToken => pagination loop terminates after one call.
    });

    const wrapped = wrapTool(createCwLogsTool(mocks.clients));
    const result = await wrapped(
      {
        logGroup: "/aws/lambda/FanoutPreview-IngressFn",
        since: "2024-01-15T09:00:00.000Z",
      },
      fixture.runtime,
    );

    expect(result.events).toEqual([
      {
        timestamp: "2024-01-15T10:00:00.000Z",
        message: "ingress: received",
        logStream: "2024/01/15/[$LATEST]abc",
      },
      {
        timestamp: "2024-01-15T10:00:01.000Z",
        message: "ingress: published",
        logStream: "2024/01/15/[$LATEST]abc",
      },
      {
        timestamp: "2024-01-15T10:00:02.000Z",
        message: "egress: consumed",
        logStream: "2024/01/15/[$LATEST]xyz",
      },
    ]);

    // The SDK was called exactly once (no pagination needed).
    expect(mocks.logsMock.commandCalls(FilterLogEventsCommand)).toHaveLength(1);
    const sentInput = mocks.logsMock
      .commandCalls(FilterLogEventsCommand)[0]
      .args[0].input;
    expect(sentInput.logGroupName).toBe(
      "/aws/lambda/FanoutPreview-IngressFn",
    );
    // `since` is converted to Unix ms for the SDK call.
    expect(sentInput.startTime).toBe(Date.UTC(2024, 0, 15, 9, 0, 0));

    // Wrapper records the call as ok with the transformed output.
    expect(fixture.sink.records[0]?.outcome).toBe("ok");
  });

  it("rejects log groups outside the preview prefix", async () => {
    // The IAM policy is the real boundary, but the wrapper rejects
    // before issuing the SDK call so the session log shows a clear
    // wrapper rejection rather than an AWS access-denied trace.
    mocks.logsMock.on(FilterLogEventsCommand).resolves({ events: [] });

    const wrapped = wrapTool(createCwLogsTool(mocks.clients));

    await expect(
      wrapped(
        {
          logGroup: "/aws/lambda/SomeOtherStack-Function",
          since: "2024-01-15T09:00:00.000Z",
        },
        fixture.runtime,
      ),
    ).rejects.toThrow(/not within the preview environment/);

    // No SDK call happened: the wrapper rejected before sending.
    expect(mocks.logsMock.commandCalls(FilterLogEventsCommand)).toHaveLength(0);

    // The wrapper logs the rejection as a handler-error (the rejection
    // is a domain check inside the handler, not a path-scope error from
    // the shared wrapper).
    expect(fixture.sink.records[0]?.outcome).toBe("handler-error");
    expect(fixture.sink.records[0]?.error).toMatch(/preview environment/);
  });

  it("accepts log groups matching every documented preview prefix", async () => {
    // Pin the allow-list semantics: the exported constant defines the
    // accepted shapes. Each prefix value is a valid log group on its
    // own (even with no suffix), and any name that begins with one of
    // them is also accepted.
    mocks.logsMock.on(FilterLogEventsCommand).resolves({ events: [] });

    const wrapped = wrapTool(createCwLogsTool(mocks.clients));
    for (const prefix of PREVIEW_LOG_GROUP_PREFIXES) {
      // Fresh fixture per iteration so the sink and the mock counters
      // don't bleed across cases.
      const localFixture = makeFixture();
      await expect(
        wrapped(
          {
            logGroup: `${prefix}-Suffix-AbC123`,
            since: "2024-01-15T09:00:00.000Z",
          },
          localFixture.runtime,
        ),
      ).resolves.toEqual({ events: [] });
    }
    // One SDK call per prefix.
    expect(mocks.logsMock.commandCalls(FilterLogEventsCommand)).toHaveLength(
      PREVIEW_LOG_GROUP_PREFIXES.length,
    );
  });

  it("rejects malformed `since` timestamps before sending an SDK call", async () => {
    mocks.logsMock.on(FilterLogEventsCommand).resolves({ events: [] });

    const wrapped = wrapTool(createCwLogsTool(mocks.clients));

    // The schema's `format: date-time` validation kicks in first.
    // ajv-formats accepts ISO-8601-ish strings; "yesterday" is not one,
    // so the wrapper rejects with an input-schema-error.
    await expect(
      wrapped(
        {
          logGroup: "/aws/lambda/FanoutPreview-IngressFn",
          since: "yesterday",
        },
        fixture.runtime,
      ),
    ).rejects.toThrow();

    expect(mocks.logsMock.commandCalls(FilterLogEventsCommand)).toHaveLength(0);
    expect(fixture.sink.records[0]?.outcome).toBe("input-schema-error");
  });

  it("paginates via nextToken until the SDK returns no more pages", async () => {
    // Two-page response. The handler should issue two SDK calls and
    // concatenate the events.
    mocks.logsMock
      .on(FilterLogEventsCommand)
      // First call: one event + a nextToken.
      .resolvesOnce({
        events: [
          {
            timestamp: Date.UTC(2024, 0, 15, 10, 0, 0),
            message: "page 1",
            logStreamName: "stream-a",
          },
        ],
        nextToken: "TOKEN-1",
      })
      // Second call: one event, no nextToken.
      .resolvesOnce({
        events: [
          {
            timestamp: Date.UTC(2024, 0, 15, 10, 0, 1),
            message: "page 2",
            logStreamName: "stream-b",
          },
        ],
      });

    const wrapped = wrapTool(createCwLogsTool(mocks.clients));
    const result = await wrapped(
      {
        logGroup: "/aws/lambda/FanoutPreview-IngressFn",
        since: "2024-01-15T09:00:00.000Z",
      },
      fixture.runtime,
    );

    expect(result.events).toHaveLength(2);
    expect(result.events[0].message).toBe("page 1");
    expect(result.events[1].message).toBe("page 2");

    const calls = mocks.logsMock.commandCalls(FilterLogEventsCommand);
    expect(calls).toHaveLength(2);
    // The second call carried the nextToken from the first.
    expect(calls[1].args[0].input.nextToken).toBe("TOKEN-1");
  });
});

// ---------------------------------------------------------------------------
// preview.cwMetrics
// ---------------------------------------------------------------------------

describe("preview.cwMetrics", () => {
  let fixture: Fixture;
  let mocks: Mocks;

  beforeEach(() => {
    fixture = makeFixture();
    mocks = makeMocks();
  });

  afterEach(() => {
    mocks.logsMock.restore();
    mocks.metricsMock.restore();
  });

  it("happy path: returns timestamp/value pairs transformed into points", async () => {
    const t1 = new Date(Date.UTC(2024, 0, 15, 10, 0, 0));
    const t2 = new Date(Date.UTC(2024, 0, 15, 10, 1, 0));
    const t3 = new Date(Date.UTC(2024, 0, 15, 10, 2, 0));

    mocks.metricsMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        {
          Id: "m1",
          Label: "Errors",
          Timestamps: [t1, t2, t3],
          Values: [0, 1, 2],
          StatusCode: "Complete",
        },
      ],
    });

    const wrapped = wrapTool(createCwMetricsTool(mocks.clients));
    const result = await wrapped(
      {
        metric: "AWS/Lambda/Errors",
        since: "2024-01-15T09:00:00.000Z",
      },
      fixture.runtime,
    );

    expect(result.points).toEqual([
      { timestamp: "2024-01-15T10:00:00.000Z", value: 0 },
      { timestamp: "2024-01-15T10:01:00.000Z", value: 1 },
      { timestamp: "2024-01-15T10:02:00.000Z", value: 2 },
    ]);

    expect(mocks.metricsMock.commandCalls(GetMetricDataCommand)).toHaveLength(
      1,
    );
    const sentInput = mocks.metricsMock
      .commandCalls(GetMetricDataCommand)[0]
      .args[0].input;
    expect(sentInput.MetricDataQueries).toBeDefined();
    const query = sentInput.MetricDataQueries![0];
    // Namespace and metric name are split on the last `/`.
    expect(query.MetricStat?.Metric?.Namespace).toBe("AWS/Lambda");
    expect(query.MetricStat?.Metric?.MetricName).toBe("Errors");
    // Default period and statistic from the wrapper's constants.
    expect(query.MetricStat?.Period).toBe(60);
    expect(query.MetricStat?.Stat).toBe("Average");
    // The agent's `since` is the `StartTime` on the SDK call.
    expect(sentInput.StartTime).toBeInstanceOf(Date);
    expect((sentInput.StartTime as Date).toISOString()).toBe(
      "2024-01-15T09:00:00.000Z",
    );

    expect(fixture.sink.records[0]?.outcome).toBe("ok");
  });

  it("passes dimensions through to GetMetricDataCommand", async () => {
    mocks.metricsMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        {
          Id: "m1",
          Timestamps: [],
          Values: [],
          StatusCode: "Complete",
        },
      ],
    });

    const wrapped = wrapTool(createCwMetricsTool(mocks.clients));
    await wrapped(
      {
        metric: "AWS/Lambda/Duration",
        since: "2024-01-15T09:00:00.000Z",
        dimensions: [
          { name: "FunctionName", value: "FanoutPreview-IngressFn" },
        ],
      },
      fixture.runtime,
    );

    const sentInput = mocks.metricsMock
      .commandCalls(GetMetricDataCommand)[0]
      .args[0].input;
    const sentDimensions: Dimension[] | undefined =
      sentInput.MetricDataQueries![0].MetricStat?.Metric?.Dimensions;
    expect(sentDimensions).toEqual([
      { Name: "FunctionName", Value: "FanoutPreview-IngressFn" },
    ]);
  });

  it("falls back to the default namespace when the metric has no `/`", async () => {
    // The handler splits on the last `/`. A bare metric name has no
    // slash, so the wrapper supplies the default namespace
    // (`AWS/Lambda`) so the agent can pass shorthand for the most
    // common metric source.
    mocks.metricsMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        {
          Id: "m1",
          Timestamps: [],
          Values: [],
          StatusCode: "Complete",
        },
      ],
    });

    const wrapped = wrapTool(createCwMetricsTool(mocks.clients));
    await wrapped(
      {
        metric: "Errors",
        since: "2024-01-15T09:00:00.000Z",
      },
      fixture.runtime,
    );

    const sentInput = mocks.metricsMock
      .commandCalls(GetMetricDataCommand)[0]
      .args[0].input;
    const metric = sentInput.MetricDataQueries![0].MetricStat?.Metric;
    expect(metric?.Namespace).toBe("AWS/Lambda");
    expect(metric?.MetricName).toBe("Errors");
  });

  it("rejects malformed `since` timestamps via the input schema", async () => {
    mocks.metricsMock.on(GetMetricDataCommand).resolves({});

    const wrapped = wrapTool(createCwMetricsTool(mocks.clients));

    await expect(
      wrapped(
        {
          metric: "AWS/Lambda/Errors",
          since: "not-a-date",
        },
        fixture.runtime,
      ),
    ).rejects.toThrow();

    expect(mocks.metricsMock.commandCalls(GetMetricDataCommand)).toHaveLength(
      0,
    );
    expect(fixture.sink.records[0]?.outcome).toBe("input-schema-error");
  });

  it("returns an empty points array when CloudWatch returns no data", async () => {
    mocks.metricsMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        {
          Id: "m1",
          Timestamps: [],
          Values: [],
          StatusCode: "Complete",
        },
      ],
    });

    const wrapped = wrapTool(createCwMetricsTool(mocks.clients));
    const result = await wrapped(
      {
        metric: "AWS/SQS/ApproximateNumberOfMessagesVisible",
        since: "2024-01-15T09:00:00.000Z",
      },
      fixture.runtime,
    );

    expect(result.points).toEqual([]);
    expect(fixture.sink.records[0]?.outcome).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Cost accounting
// ---------------------------------------------------------------------------

describe("preview.* cost accounting", () => {
  // Both tools declare `costCategory: "none"`, so the cost counter
  // hooks should never fire. Verifying this protects the cost-cap stop
  // condition from drift if a forker accidentally adds a cost report
  // to a CloudWatch read.
  let fixture: Fixture;
  let mocks: Mocks;
  let costCalls: { token: number[]; deploy: number[] };

  beforeEach(() => {
    fixture = makeFixture();
    mocks = makeMocks();
    costCalls = { token: [], deploy: [] };
    // Add a cost counter to the runtime; it should remain untouched.
    (fixture.runtime as { costCounter?: unknown }).costCounter = {
      recordTokenUsage: (usd: number) => {
        costCalls.token.push(usd);
      },
      recordDeployCost: (usd: number) => {
        costCalls.deploy.push(usd);
      },
    };
  });

  afterEach(() => {
    mocks.logsMock.restore();
    mocks.metricsMock.restore();
  });

  it("does not record any cost for cwLogs", async () => {
    mocks.logsMock.on(FilterLogEventsCommand).resolves({ events: [] });
    const wrapped = wrapTool(createCwLogsTool(mocks.clients));
    await wrapped(
      {
        logGroup: "/aws/lambda/FanoutPreview-IngressFn",
        since: "2024-01-15T09:00:00.000Z",
      },
      fixture.runtime,
    );
    expect(costCalls.token).toEqual([]);
    expect(costCalls.deploy).toEqual([]);
    expect(fixture.sink.records[0]?.cost).toBeUndefined();
  });

  it("does not record any cost for cwMetrics", async () => {
    mocks.metricsMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        {
          Id: "m1",
          Timestamps: [],
          Values: [],
          StatusCode: "Complete",
        },
      ],
    });
    const wrapped = wrapTool(createCwMetricsTool(mocks.clients));
    await wrapped(
      {
        metric: "AWS/Lambda/Errors",
        since: "2024-01-15T09:00:00.000Z",
      },
      fixture.runtime,
    );
    expect(costCalls.token).toEqual([]);
    expect(costCalls.deploy).toEqual([]);
    expect(fixture.sink.records[0]?.cost).toBeUndefined();
  });
});
