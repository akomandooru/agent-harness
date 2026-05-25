/**
 * Unit tests for the synthetic post-deploy harness runner.
 *
 * Covers the verification matrix from tasks.md task 4: harness self-tests
 * run against a mocked preview environment; the runner returns `pass`,
 * `fail`, `partial`, and `deploy-failure` correctly across fixtures.
 *
 * Tests inject:
 *   - `aws-sdk-client-mock`-backed SQS and CloudWatchLogs clients so no
 *     real AWS credentials are needed.
 *   - A stub `fetch` for the API Gateway POST.
 *   - A virtual clock + immediate-resolve sleep so polling exits
 *     deterministically without real wall-clock waits.
 *
 * The fixtures intentionally drive the runner through every branch in
 * `decideOutcome`'s truth table plus the deploy-failure short-circuit
 * and the missing-stack-output guard.
 */

import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  SQSClient,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { mockClient, type AwsClientStub } from "aws-sdk-client-mock";

import {
  buildSyntheticMessage,
  decideOutcome,
  runPostDeploy,
  type FetchLike,
  type PostDeployClients,
} from "../src/runner";


// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a virtual clock starting at a fixed instant. The clock advances
 * only when the test explicitly calls `advance` or when the runner's
 * `sleep` runs (the fixture's `sleep` calls `advance`).
 */
function makeClock(startMs: number = 1_700_000_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

interface Fixture {
  readonly sqsMock: AwsClientStub<SQSClient>;
  readonly logsMock: AwsClientStub<CloudWatchLogsClient>;
  readonly fetchCalls: Array<{
    url: string;
    init?: { method?: string; headers?: Record<string, string>; body?: string };
  }>;
  readonly fetchResponses: Array<
    | { ok: boolean; status: number; body: string }
    | { throws: Error }
  >;
  readonly clients: PostDeployClients;
  readonly clock: ReturnType<typeof makeClock>;
}

function makeFixture(): Fixture {
  const sqsMock = mockClient(SQSClient);
  const logsMock = mockClient(CloudWatchLogsClient);

  const sqs = new SQSClient({});
  const logs = new CloudWatchLogsClient({});

  const fetchCalls: Fixture["fetchCalls"] = [];
  const fetchResponses: Fixture["fetchResponses"] = [];
  const fetchStub: FetchLike = async (url, init) => {
    fetchCalls.push({ url, init });
    const next = fetchResponses.shift();
    if (next === undefined) {
      // Default: 202 with empty body. Matches the reference module's
      // ingress handler.
      return {
        ok: true,
        status: 202,
        text: async () => "",
      };
    }
    if ("throws" in next) throw next.throws;
    return {
      ok: next.ok,
      status: next.status,
      text: async () => next.body,
    };
  };

  const clock = makeClock();

  const clients: PostDeployClients = {
    sqs,
    logs,
    fetch: fetchStub,
    sleep: async (ms: number) => {
      // Virtual sleep: advance the clock. The test loop relies on
      // this so the polling timeout fires deterministically without
      // waiting on real timers.
      clock.advance(ms);
    },
    now: clock.now,
    pollTimeoutMs: 100,
    pollIntervalMs: 10,
  };

  return { sqsMock, logsMock, fetchCalls, fetchResponses, clients, clock };
}


// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("buildSyntheticMessage", () => {
  it("embeds the session id and timestamp in the marker", () => {
    const { body, marker } = buildSyntheticMessage(
      "session-abc",
      () => 1_234_567_890,
    );
    expect(marker).toBe("post-deploy-session-abc-1234567890");
    expect(JSON.parse(body)).toEqual({ message: marker });
  });
});

describe("decideOutcome", () => {
  it("pass when message observed and encryption ok", () => {
    expect(
      decideOutcome({ messageObserved: true, queueEncryptionOk: true }),
    ).toBe("pass");
  });

  it("partial when message observed but encryption not ok", () => {
    expect(
      decideOutcome({ messageObserved: true, queueEncryptionOk: false }),
    ).toBe("partial");
  });

  it("fail when no message observed (encryption irrelevant)", () => {
    expect(
      decideOutcome({ messageObserved: false, queueEncryptionOk: true }),
    ).toBe("fail");
    expect(
      decideOutcome({ messageObserved: false, queueEncryptionOk: false }),
    ).toBe("fail");
  });
});


// ---------------------------------------------------------------------------
// runPostDeploy — outcome paths
// ---------------------------------------------------------------------------

const STACK_OUTPUTS = {
  "FanoutPreview.ApiEndpointUrl":
    "https://abc.execute-api.us-east-1.amazonaws.com/prod/",
  "FanoutPreview.QueueUrl":
    "https://sqs.us-east-1.amazonaws.com/123456789012/FanoutPreview-Queue-AbCdEf",
};

describe("runPostDeploy: deploy-failure short-circuit", () => {
  it("returns deploy-failure with deployLogs and runs no SDK calls", async () => {
    const fixture = makeFixture();
    const output = await runPostDeploy(
      {
        sessionId: "session-deploy-failure",
        stackOutputs: STACK_OUTPUTS,
        deployFailureLogs: "CDK: stack creation failed: ResourceLimitExceeded",
      },
      fixture.clients,
    );

    expect(output.outcome).toBe("deploy-failure");
    expect(output.deployLogs).toMatch(/ResourceLimitExceeded/);
    expect(output.report.sessionId).toBe("session-deploy-failure");

    // No HTTP, no SDK calls — the short-circuit took the path.
    expect(fixture.fetchCalls).toHaveLength(0);
    expect(fixture.sqsMock.calls()).toHaveLength(0);
    expect(fixture.logsMock.calls()).toHaveLength(0);

    fixture.sqsMock.restore();
    fixture.logsMock.restore();
  });
});


describe("runPostDeploy: pass", () => {
  it("returns pass when the message is observed on the queue and encryption is on", async () => {
    const fixture = makeFixture();
    // Queue is KMS-encrypted: GetQueueAttributes returns a key id.
    fixture.sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: {
        KmsMasterKeyId: "arn:aws:kms:us-east-1:123456789012:key/aaaa-bbbb",
      },
    });

    // First poll: queue carries the synthetic message.
    fixture.sqsMock.on(ReceiveMessageCommand).callsFake(() => ({
      Messages: [
        {
          MessageId: "msg-1",
          ReceiptHandle: "rh-1",
          // Body matches the SNS-to-SQS envelope: the runner's check
          // is a substring match on the marker, so a plain JSON body
          // containing the marker works for the unit test.
          Body: JSON.stringify({
            message: `post-deploy-session-pass-${1_700_000_000_000}`,
          }),
        },
      ],
    }));
    fixture.sqsMock.on(DeleteMessageCommand).resolves({});

    const output = await runPostDeploy(
      { sessionId: "session-pass", stackOutputs: STACK_OUTPUTS },
      fixture.clients,
    );

    expect(output.outcome).toBe("pass");
    expect(output.report.messageObserved).toBe(true);
    expect(output.report.observedVia).toBe("queue");
    expect(output.report.queueEncryption).toMatchObject({
      ok: true,
      kmsMasterKeyId: "arn:aws:kms:us-east-1:123456789012:key/aaaa-bbbb",
    });

    // Synthetic POST hit the right URL.
    expect(fixture.fetchCalls).toHaveLength(1);
    expect(fixture.fetchCalls[0].url).toBe(
      "https://abc.execute-api.us-east-1.amazonaws.com/prod/messages",
    );
    const sentBody = JSON.parse(
      (fixture.fetchCalls[0].init?.body as string) ?? "{}",
    );
    expect(sentBody.message).toMatch(/^post-deploy-session-pass-/);

    // Cleanup: the matched message was deleted.
    expect(fixture.sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(1);

    fixture.sqsMock.restore();
    fixture.logsMock.restore();
  });
});


describe("runPostDeploy: pass via logs (queue drained by EgressFn first)", () => {
  it("returns pass when the marker shows up in CloudWatch Logs", async () => {
    const fixture = makeFixture();
    fixture.sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { KmsMasterKeyId: "alias/aws/sqs" },
    });
    // Queue read finds nothing — the EgressFn drained it first.
    fixture.sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [] });

    // Logs return an event with the marker on the first poll.
    fixture.logsMock.on(FilterLogEventsCommand).callsFake((input) => {
      // Sanity-check the wrapper-level filter pattern is the marker
      // surrounded by quotes (CloudWatch Logs filter syntax).
      const filterPattern = (
        input as { filterPattern?: string }
      ).filterPattern;
      expect(filterPattern).toMatch(/^"post-deploy-session-logs-/);
      return {
        events: [
          {
            timestamp: 1_700_000_000_500,
            message: JSON.stringify({
              messageId: "msg-egress",
              body: `{"message":"post-deploy-session-logs-${1_700_000_000_000}"}`,
            }),
            logStreamName: "2024/01/15/[$LATEST]xyz",
          },
        ],
      };
    });

    const output = await runPostDeploy(
      { sessionId: "session-logs", stackOutputs: STACK_OUTPUTS },
      fixture.clients,
    );

    expect(output.outcome).toBe("pass");
    expect(output.report.observedVia).toBe("logs");
    expect(output.logs?.egressFn).toMatch(/post-deploy-session-logs-/);

    fixture.sqsMock.restore();
    fixture.logsMock.restore();
  });
});


describe("runPostDeploy: partial", () => {
  it("returns partial when the message is observed but encryption is missing", async () => {
    const fixture = makeFixture();
    // Queue is unencrypted: KmsMasterKeyId attribute absent.
    fixture.sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: {
        // No KmsMasterKeyId here — represents a misconfigured queue.
        QueueArn:
          "arn:aws:sqs:us-east-1:123456789012:FanoutPreview-Queue",
      },
    });
    fixture.sqsMock.on(ReceiveMessageCommand).callsFake(() => ({
      Messages: [
        {
          MessageId: "msg-partial",
          ReceiptHandle: "rh-partial",
          Body: JSON.stringify({
            message: `post-deploy-session-partial-${1_700_000_000_000}`,
          }),
        },
      ],
    }));
    fixture.sqsMock.on(DeleteMessageCommand).resolves({});

    const output = await runPostDeploy(
      { sessionId: "session-partial", stackOutputs: STACK_OUTPUTS },
      fixture.clients,
    );

    expect(output.outcome).toBe("partial");
    expect(output.report.messageObserved).toBe(true);
    expect(output.report.queueEncryption).toMatchObject({
      ok: false,
      kmsMasterKeyId: null,
    });

    fixture.sqsMock.restore();
    fixture.logsMock.restore();
  });
});


describe("runPostDeploy: fail (timeout)", () => {
  it("returns fail when the marker never appears within the polling window", async () => {
    const fixture = makeFixture();
    fixture.sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: {
        KmsMasterKeyId: "alias/aws/sqs",
      },
    });
    fixture.sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [] });
    fixture.logsMock.on(FilterLogEventsCommand).resolves({ events: [] });

    const output = await runPostDeploy(
      { sessionId: "session-fail-timeout", stackOutputs: STACK_OUTPUTS },
      fixture.clients,
    );

    expect(output.outcome).toBe("fail");
    expect(output.report.messageObserved).toBe(false);
    expect(output.report.observedVia).toBeNull();
    // The runner did poll multiple times before giving up. Pollers
    // call ReceiveMessage and FilterLogEvents alternately; expect
    // at least two of each given pollTimeoutMs/pollIntervalMs ratio
    // (100/10 = ~10 iterations).
    expect(
      fixture.sqsMock.commandCalls(ReceiveMessageCommand).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      fixture.logsMock.commandCalls(FilterLogEventsCommand).length,
    ).toBeGreaterThanOrEqual(2);

    fixture.sqsMock.restore();
    fixture.logsMock.restore();
  });

  it("returns fail when the synthetic POST returns non-2xx", async () => {
    const fixture = makeFixture();
    fixture.fetchResponses.push({
      ok: false,
      status: 500,
      body: "internal error",
    });

    const output = await runPostDeploy(
      { sessionId: "session-fail-http", stackOutputs: STACK_OUTPUTS },
      fixture.clients,
    );

    expect(output.outcome).toBe("fail");
    expect(output.report.httpStatus).toBe(500);
    expect(output.report.reason).toMatch(/non-2xx/);

    // The runner should not have proceeded to the polling stage.
    expect(fixture.sqsMock.calls()).toHaveLength(0);

    fixture.sqsMock.restore();
    fixture.logsMock.restore();
  });

  it("returns fail when the synthetic POST throws", async () => {
    const fixture = makeFixture();
    fixture.fetchResponses.push({ throws: new Error("ECONNREFUSED") });

    const output = await runPostDeploy(
      { sessionId: "session-fail-net", stackOutputs: STACK_OUTPUTS },
      fixture.clients,
    );

    expect(output.outcome).toBe("fail");
    expect(output.report.error).toMatch(/ECONNREFUSED/);

    fixture.sqsMock.restore();
    fixture.logsMock.restore();
  });
});


describe("runPostDeploy: missing stack outputs", () => {
  it("returns fail when ApiEndpointUrl is missing", async () => {
    const fixture = makeFixture();
    const output = await runPostDeploy(
      {
        sessionId: "session-missing-outputs",
        stackOutputs: { "FanoutPreview.QueueUrl": "https://sqs..." },
      },
      fixture.clients,
    );
    expect(output.outcome).toBe("fail");
    expect(output.report.reason).toMatch(/missing required stack outputs/);
    // No HTTP, no SDK.
    expect(fixture.fetchCalls).toHaveLength(0);
    expect(fixture.sqsMock.calls()).toHaveLength(0);

    fixture.sqsMock.restore();
    fixture.logsMock.restore();
  });

  it("accepts both bare and CDK-qualified stack output keys", async () => {
    const fixture = makeFixture();
    fixture.sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { KmsMasterKeyId: "alias/aws/sqs" },
    });
    fixture.sqsMock.on(ReceiveMessageCommand).callsFake(() => ({
      Messages: [
        {
          MessageId: "msg-bare",
          ReceiptHandle: "rh-bare",
          Body: JSON.stringify({
            message: `post-deploy-session-bare-${1_700_000_000_000}`,
          }),
        },
      ],
    }));
    fixture.sqsMock.on(DeleteMessageCommand).resolves({});

    const output = await runPostDeploy(
      {
        sessionId: "session-bare",
        // Bare keys (the GitHub Action's `cdk deploy --outputs-file`
        // dumps either flat or nested; the CLI flattens to flat).
        stackOutputs: {
          ApiEndpointUrl:
            "https://abc.execute-api.us-east-1.amazonaws.com/prod/",
          QueueUrl:
            "https://sqs.us-east-1.amazonaws.com/123456789012/Q",
        },
      },
      fixture.clients,
    );
    expect(output.outcome).toBe("pass");

    fixture.sqsMock.restore();
    fixture.logsMock.restore();
  });
});


describe("runPostDeploy: encryption read failure", () => {
  it("treats GetQueueAttributes errors as encryption-not-ok and yields partial when message observed", async () => {
    const fixture = makeFixture();
    fixture.sqsMock
      .on(GetQueueAttributesCommand)
      .rejects(new Error("AccessDeniedException"));
    fixture.sqsMock.on(ReceiveMessageCommand).callsFake(() => ({
      Messages: [
        {
          MessageId: "msg-enc-fail",
          ReceiptHandle: "rh-enc-fail",
          Body: JSON.stringify({
            message: `post-deploy-session-encfail-${1_700_000_000_000}`,
          }),
        },
      ],
    }));
    fixture.sqsMock.on(DeleteMessageCommand).resolves({});

    const output = await runPostDeploy(
      { sessionId: "session-encfail", stackOutputs: STACK_OUTPUTS },
      fixture.clients,
    );

    expect(output.outcome).toBe("partial");
    expect(output.report.queueEncryption).toMatchObject({
      ok: false,
      kmsMasterKeyId: null,
      detail: expect.stringMatching(/AccessDeniedException/),
    });

    fixture.sqsMock.restore();
    fixture.logsMock.restore();
  });
});


// ---------------------------------------------------------------------------
// runPostDeploy: gap-closure check dispatch (task 5.5)
// ---------------------------------------------------------------------------

// Mock the gap-closure module so tests don't make real AWS calls.
jest.mock("../gap-closure/index", () => ({
  runGapClosureCheck: jest.fn(),
}));

import { runGapClosureCheck } from "../gap-closure/index";

const mockRunGapClosureCheck = runGapClosureCheck as jest.MockedFunction<
  typeof runGapClosureCheck
>;

/** Minimal originating finding for test fixtures. */
const ORIGINATING_FINDING = {
  signature: "a3f7c2d1e8b94f20",
  id: "WA-SEC-02",
  pillar: "Security",
  severity: "high" as const,
  description: "SNS topic does not enforce HTTPS-only",
  suggestedFix: "Add a Deny policy on aws:SecureTransport=false",
  runId: "scheduled-reviewer-run-2025-01-15T06:00:00Z",
  runDate: "2025-01-15T06:00:00Z",
};

/** Stack outputs that satisfy the smoke-test path (message + encryption). */
const PASSING_STACK_OUTPUTS = {
  "FanoutPreview.ApiEndpointUrl":
    "https://abc.execute-api.us-east-1.amazonaws.com/prod/",
  "FanoutPreview.QueueUrl":
    "https://sqs.us-east-1.amazonaws.com/123456789012/FanoutPreview-Queue-AbCdEf",
};

/**
 * Build a fixture where the smoke-test path passes (message observed,
 * encryption ok) so gap-closure outcome rules are isolated.
 */
function makePassingSmokeFanoutFixture(sessionId: string = "session-gc"): Fixture {
  const fixture = makeFixture();
  fixture.sqsMock.on(GetQueueAttributesCommand).resolves({
    Attributes: {
      KmsMasterKeyId: "arn:aws:kms:us-east-1:123456789012:key/aaaa-bbbb",
    },
  });
  fixture.sqsMock.on(ReceiveMessageCommand).callsFake(() => ({
    Messages: [
      {
        MessageId: "msg-gc",
        ReceiptHandle: "rh-gc",
        Body: JSON.stringify({
          message: `post-deploy-${sessionId}-${1_700_000_000_000}`,
        }),
      },
    ],
  }));
  fixture.sqsMock.on(DeleteMessageCommand).resolves({});
  return fixture;
}

describe("runPostDeploy: gap-closure check — probeError → partial", () => {
  afterEach(() => {
    mockRunGapClosureCheck.mockReset();
  });

  it("sets outcome to partial when probeError is set on the gap-closure result", async () => {
    // Validates: Requirements 4.1, 4.4
    const fixture = makePassingSmokeFanoutFixture("session-gc");

    mockRunGapClosureCheck.mockResolvedValue({
      gapId: "WA-SEC-02",
      closed: false,
      evidence: {},
      probeMethod: "sns:GetTopicAttributes",
      probeError: "AccessDeniedException",
    });

    const output = await runPostDeploy(
      {
        sessionId: "session-gc",
        stackOutputs: PASSING_STACK_OUTPUTS,
        triggerType: "fitness-gap",
        originatingFinding: ORIGINATING_FINDING,
      },
      fixture.clients,
    );

    expect(output.outcome).toBe("partial");
    expect(output.report.gapClosure).toMatchObject({
      gapId: "WA-SEC-02",
      probeError: "AccessDeniedException",
    });

    fixture.sqsMock.restore();
    fixture.logsMock.restore();
  });

  it("keeps fail outcome when smoke/fanout already failed and probeError is set", async () => {
    // Validates: Requirements 4.1, 4.4
    // Smoke/fanout fails (no message observed), gap-closure has probeError.
    // The harder "fail" should not be downgraded to "partial".
    const fixture = makeFixture();
    fixture.sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { KmsMasterKeyId: "alias/aws/sqs" },
    });
    fixture.sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [] });
    fixture.logsMock.on(FilterLogEventsCommand).resolves({ events: [] });

    mockRunGapClosureCheck.mockResolvedValue({
      gapId: "WA-SEC-02",
      closed: false,
      evidence: {},
      probeMethod: "sns:GetTopicAttributes",
      probeError: "stack-output-missing",
    });

    const output = await runPostDeploy(
      {
        sessionId: "session-gc-fail-probe",
        stackOutputs: PASSING_STACK_OUTPUTS,
        triggerType: "fitness-gap",
        originatingFinding: ORIGINATING_FINDING,
      },
      fixture.clients,
    );

    expect(output.outcome).toBe("fail");

    fixture.sqsMock.restore();
    fixture.logsMock.restore();
  });
});

describe("runPostDeploy: gap-closure check — closed: false → fail", () => {
  afterEach(() => {
    mockRunGapClosureCheck.mockReset();
  });

  it("sets outcome to fail when gap is not closed and no probeError", async () => {
    // Validates: Requirements 4.1, 4.4
    const fixture = makePassingSmokeFanoutFixture("session-gc-not-closed");

    mockRunGapClosureCheck.mockResolvedValue({
      gapId: "WA-SEC-02",
      closed: false,
      evidence: { topicArn: "arn:aws:sns:us-east-1:123:topic" },
      probeMethod: "sns:GetTopicAttributes",
    });

    const output = await runPostDeploy(
      {
        sessionId: "session-gc-not-closed",
        stackOutputs: PASSING_STACK_OUTPUTS,
        triggerType: "fitness-gap",
        originatingFinding: ORIGINATING_FINDING,
      },
      fixture.clients,
    );

    expect(output.outcome).toBe("fail");
    expect(output.report.gapClosure).toMatchObject({
      gapId: "WA-SEC-02",
      closed: false,
    });

    fixture.sqsMock.restore();
    fixture.logsMock.restore();
  });
});

describe("runPostDeploy: gap-closure check — closed: true → does not override outcome", () => {
  afterEach(() => {
    mockRunGapClosureCheck.mockReset();
  });

  it("keeps pass outcome when gap is closed and smoke/fanout passed", async () => {
    // Validates: Requirements 4.1, 4.4
    const fixture = makePassingSmokeFanoutFixture("session-gc-closed");

    mockRunGapClosureCheck.mockResolvedValue({
      gapId: "WA-SEC-02",
      closed: true,
      evidence: { topicArn: "arn:aws:sns:us-east-1:123:topic" },
      probeMethod: "sns:GetTopicAttributes",
    });

    const output = await runPostDeploy(
      {
        sessionId: "session-gc-closed",
        stackOutputs: PASSING_STACK_OUTPUTS,
        triggerType: "fitness-gap",
        originatingFinding: ORIGINATING_FINDING,
      },
      fixture.clients,
    );

    expect(output.outcome).toBe("pass");
    expect(output.report.gapClosure).toMatchObject({
      gapId: "WA-SEC-02",
      closed: true,
    });

    fixture.sqsMock.restore();
    fixture.logsMock.restore();
  });
});

describe("runPostDeploy: gap-closure check — skipped for feature-change triggers", () => {
  afterEach(() => {
    mockRunGapClosureCheck.mockReset();
  });

  it("does not call runGapClosureCheck when triggerType is feature-change", async () => {
    // Validates: Requirements 4.1, 6.5
    const fixture = makePassingSmokeFanoutFixture("session-feature-change");

    const output = await runPostDeploy(
      {
        sessionId: "session-feature-change",
        stackOutputs: PASSING_STACK_OUTPUTS,
        triggerType: "feature-change",
        originatingFinding: ORIGINATING_FINDING,
      },
      fixture.clients,
    );

    expect(mockRunGapClosureCheck).not.toHaveBeenCalled();
    expect(output.report.gapClosure).toBeNull();
    // Outcome is determined solely by smoke/fanout.
    expect(output.outcome).toBe("pass");

    fixture.sqsMock.restore();
    fixture.logsMock.restore();
  });

  it("does not call runGapClosureCheck when triggerType is absent", async () => {
    // Validates: Requirements 4.1, 6.5 — backward compatibility
    const fixture = makePassingSmokeFanoutFixture("session-no-trigger-type");

    const output = await runPostDeploy(
      {
        sessionId: "session-no-trigger-type",
        stackOutputs: PASSING_STACK_OUTPUTS,
      },
      fixture.clients,
    );

    expect(mockRunGapClosureCheck).not.toHaveBeenCalled();
    expect(output.report.gapClosure).toBeNull();

    fixture.sqsMock.restore();
    fixture.logsMock.restore();
  });

  it("does not call runGapClosureCheck when triggerType is fitness-gap but originatingFinding is absent", async () => {
    // Validates: Requirements 4.1 — guard against incomplete payload
    const fixture = makePassingSmokeFanoutFixture("session-gc-no-finding");

    const output = await runPostDeploy(
      {
        sessionId: "session-gc-no-finding",
        stackOutputs: PASSING_STACK_OUTPUTS,
        triggerType: "fitness-gap",
        // originatingFinding intentionally absent
      },
      fixture.clients,
    );

    expect(mockRunGapClosureCheck).not.toHaveBeenCalled();
    expect(output.report.gapClosure).toBeNull();

    fixture.sqsMock.restore();
    fixture.logsMock.restore();
  });
});
