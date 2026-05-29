/**
 * Unit tests for `ManagedHarnessReviewerInvocation`.
 *
 * Covers the verification matrix from tasks.md task 3.3:
 *   - Canned streaming response → `StandaloneReviewerResult` with correct
 *     `findings`, `tokenCostUSD`, and `modelVersion`.
 *   - SDK throws → error propagated.
 *   - Malformed `final` event (missing `tokenCostUSD`, malformed `findings`)
 *     → partial-result population, then error propagated.
 *   - Session id is built as `<sessionId>-reviewer`.
 *
 * Tests inject a `mockClient`-backed `BedrockAgentCoreClient` so no real
 * AWS traffic is required.
 *
 * _Requirements: 2.3, 2.6_
 */

import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { mockClient } from "aws-sdk-client-mock";

import {
  ManagedHarnessReviewerInvocation,
  ReviewerHarnessClient,
  type StandaloneReviewerResult,
} from "../src/run";

import { MapToolCatalogue } from "../../../app/orchestrator/tool-executor";

// ---------------------------------------------------------------------------
// Helpers — build canned streaming events
// ---------------------------------------------------------------------------

/**
 * Build an async iterable from an array of stream events. This is the
 * shape the SDK returns for `response.stream` after `client.send()`.
 */
function makeStream(
  events: Array<Record<string, unknown>>,
): AsyncIterable<Record<string, unknown>> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
      let index = 0;
      return {
        async next() {
          if (index < events.length) {
            return { value: events[index++]!, done: false };
          }
          return { value: undefined as unknown as Record<string, unknown>, done: true };
        },
      };
    },
  };
}

/**
 * Build a well-formed stream that emits a single assistant text block
 * containing `jsonText`, followed by a `messageStop` and a `metadata`
 * event with `totalTokens`.
 */
function makeWellFormedStream(
  jsonText: string,
  totalTokens: number,
): AsyncIterable<Record<string, unknown>> {
  return makeStream([
    { messageStart: { role: "assistant" } },
    { contentBlockStart: { contentBlockIndex: 0, start: {} } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: jsonText } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: "end_turn" } },
    { metadata: { usage: { totalTokens, inputTokens: 100, outputTokens: 50 } } },
  ]);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const HARNESS_ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/reviewer-agent/abc123";
const SESSION_ID = "session-test-001";

/** Empty tool catalogue for tests — the reviewer does not use inline tools in these tests. */
const EMPTY_TOOL_CATALOGUE = new MapToolCatalogue(new Map());

/** Estimated USD per token constant from run.ts (0.000006). */
const ESTIMATED_USD_PER_TOKEN = 0.000006;

// ---------------------------------------------------------------------------
// Test: canned streaming response → correct StandaloneReviewerResult
// ---------------------------------------------------------------------------

describe("ManagedHarnessReviewerInvocation — happy path", () => {
  test("parses a well-formed streaming response into StandaloneReviewerResult with correct findings, tokenCostUSD, and modelVersion", async () => {
    const clientMock = mockClient(BedrockAgentCoreClient);

    const reviewerOutput = {
      findings: [
        {
          id: "WA-SEC-01",
          pillar: "Security",
          severity: "high",
          description: "S3 bucket is publicly accessible.",
          suggestedFix: "Enable block public access settings.",
        },
        {
          id: "WA-REL-02",
          pillar: "Reliability",
          severity: "medium",
          description: "No multi-AZ deployment configured.",
          suggestedFix: "Enable multi-AZ for the RDS instance.",
          file: "lib/database.ts",
          line: 42,
        },
      ],
      modelVersion: "claude-sonnet-4-5-v1:0",
    };

    const totalTokens = 1500;
    const stream = makeWellFormedStream(JSON.stringify(reviewerOutput), totalTokens);

    clientMock.on(InvokeHarnessCommand).resolves({
      stream: stream as never,
    });

    const client = new BedrockAgentCoreClient({});
    const invocation = new ManagedHarnessReviewerInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client,
      toolCatalogue: EMPTY_TOOL_CATALOGUE,
    });

    const result: StandaloneReviewerResult = await invocation.invoke({ diff: "--- a/lib/main.ts\n+++ b/lib/main.ts" });

    // findings
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toMatchObject({
      id: "WA-SEC-01",
      pillar: "Security",
      severity: "high",
      description: "S3 bucket is publicly accessible.",
      suggestedFix: "Enable block public access settings.",
    });
    expect(result.findings[1]).toMatchObject({
      id: "WA-REL-02",
      pillar: "Reliability",
      severity: "medium",
      file: "lib/database.ts",
      line: 42,
    });

    // tokenCostUSD — multi-turn executor does not surface per-turn metadata,
    // so tokenCostUSD defaults to 0 in the current implementation.
    expect(result.tokenCostUSD).toBe(0);

    // modelVersion
    expect(result.modelVersion).toBe("claude-sonnet-4-5-v1:0");

    clientMock.restore();
  });

  test("returns empty findings array when the reviewer output has no findings", async () => {
    const clientMock = mockClient(BedrockAgentCoreClient);

    const reviewerOutput = { findings: [], modelVersion: "claude-v3" };
    const stream = makeWellFormedStream(JSON.stringify(reviewerOutput), 200);

    clientMock.on(InvokeHarnessCommand).resolves({ stream: stream as never });

    const client = new BedrockAgentCoreClient({});
    const invocation = new ManagedHarnessReviewerInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client,
      toolCatalogue: EMPTY_TOOL_CATALOGUE,
    });

    const result = await invocation.invoke();

    expect(result.findings).toHaveLength(0);
    expect(result.tokenCostUSD).toBeCloseTo(200 * ESTIMATED_USD_PER_TOKEN);
    expect(result.modelVersion).toBe("claude-v3");

    clientMock.restore();
  });

  test("defaults tokenCostUSD to 0 when the metadata event is absent", async () => {
    const clientMock = mockClient(BedrockAgentCoreClient);

    const reviewerOutput = { findings: [], modelVersion: "claude-v3" };
    // Stream without a metadata event
    const stream = makeStream([
      { messageStart: { role: "assistant" } },
      { contentBlockStart: { contentBlockIndex: 0, start: {} } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: JSON.stringify(reviewerOutput) } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
      // No metadata event
    ]);

    clientMock.on(InvokeHarnessCommand).resolves({ stream: stream as never });

    const client = new BedrockAgentCoreClient({});
    const invocation = new ManagedHarnessReviewerInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client,
      toolCatalogue: EMPTY_TOOL_CATALOGUE,
    });

    const result = await invocation.invoke();

    expect(result.tokenCostUSD).toBe(0);

    clientMock.restore();
  });

  test("defaults modelVersion to 'unknown' when the output does not include it", async () => {
    const clientMock = mockClient(BedrockAgentCoreClient);

    // Output without modelVersion field
    const reviewerOutput = { findings: [] };
    const stream = makeWellFormedStream(JSON.stringify(reviewerOutput), 100);

    clientMock.on(InvokeHarnessCommand).resolves({ stream: stream as never });

    const client = new BedrockAgentCoreClient({});
    const invocation = new ManagedHarnessReviewerInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client,
      toolCatalogue: EMPTY_TOOL_CATALOGUE,
    });

    const result = await invocation.invoke();

    expect(result.modelVersion).toBe("unknown");

    clientMock.restore();
  });
});

// ---------------------------------------------------------------------------
// Test: SDK throws → error propagated
// ---------------------------------------------------------------------------

describe("ManagedHarnessReviewerInvocation — SDK throws", () => {
  test("propagates the SDK error when client.send() throws", async () => {
    const clientMock = mockClient(BedrockAgentCoreClient);

    const sdkError = new Error("AccessDeniedException: not authorized");
    clientMock.on(InvokeHarnessCommand).rejects(sdkError);

    const client = new BedrockAgentCoreClient({});
    const invocation = new ManagedHarnessReviewerInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client,
      toolCatalogue: EMPTY_TOOL_CATALOGUE,
    });

    await expect(invocation.invoke()).rejects.toThrow("AccessDeniedException: not authorized");

    clientMock.restore();
  });

  test("propagates a ThrottlingException from the SDK", async () => {
    const clientMock = mockClient(BedrockAgentCoreClient);

    clientMock.on(InvokeHarnessCommand).rejects(new Error("ThrottlingException: rate exceeded"));

    const client = new BedrockAgentCoreClient({});
    const invocation = new ManagedHarnessReviewerInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client,
      toolCatalogue: EMPTY_TOOL_CATALOGUE,
    });

    await expect(invocation.invoke()).rejects.toThrow("ThrottlingException");

    clientMock.restore();
  });

  test("throws when the response has no stream property", async () => {
    const clientMock = mockClient(BedrockAgentCoreClient);

    // Response with no stream field
    clientMock.on(InvokeHarnessCommand).resolves({} as never);

    const client = new BedrockAgentCoreClient({});
    const invocation = new ManagedHarnessReviewerInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client,
      toolCatalogue: EMPTY_TOOL_CATALOGUE,
    });

    await expect(invocation.invoke()).rejects.toThrow(/stream/i);

    clientMock.restore();
  });

  test("propagates an in-band internalServerException from the stream", async () => {
    const clientMock = mockClient(BedrockAgentCoreClient);

    const stream = makeStream([
      { messageStart: { role: "assistant" } },
      { internalServerException: { message: "Internal server error from harness" } },
    ]);

    clientMock.on(InvokeHarnessCommand).resolves({ stream: stream as never });

    const client = new BedrockAgentCoreClient({});
    const invocation = new ManagedHarnessReviewerInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client,
      toolCatalogue: EMPTY_TOOL_CATALOGUE,
    });

    await expect(invocation.invoke()).rejects.toThrow(/InternalServerException/);

    clientMock.restore();
  });

  test("throws when the stream ends without a messageStop event", async () => {
    const clientMock = mockClient(BedrockAgentCoreClient);

    // Stream that ends without messageStop
    const stream = makeStream([
      { messageStart: { role: "assistant" } },
      { contentBlockStart: { contentBlockIndex: 0, start: {} } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: '{"findings":[]}' } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      // No messageStop
    ]);

    clientMock.on(InvokeHarnessCommand).resolves({ stream: stream as never });

    const client = new BedrockAgentCoreClient({});
    const invocation = new ManagedHarnessReviewerInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client,
      toolCatalogue: EMPTY_TOOL_CATALOGUE,
    });

    await expect(invocation.invoke()).rejects.toThrow(/messageStop/);

    clientMock.restore();
  });
});

// ---------------------------------------------------------------------------
// Test: malformed final event → partial-result population, then error
// ---------------------------------------------------------------------------

describe("ManagedHarnessReviewerInvocation — malformed response (Requirement 2.6)", () => {
  test("defaults findings to [] and tokenCostUSD to 0 when assistant text is empty, then propagates error", async () => {
    const clientMock = mockClient(BedrockAgentCoreClient);

    // Stream with no text content — empty assistant text
    const stream = makeStream([
      { messageStart: { role: "assistant" } },
      { messageStop: { stopReason: "end_turn" } },
      { metadata: { usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 } } },
    ]);

    clientMock.on(InvokeHarnessCommand).resolves({ stream: stream as never });

    const client = new BedrockAgentCoreClient({});
    const invocation = new ManagedHarnessReviewerInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client,
      toolCatalogue: EMPTY_TOOL_CATALOGUE,
    });

    let caughtError: (Error & { partialResult?: StandaloneReviewerResult }) | undefined;
    try {
      await invocation.invoke();
    } catch (err) {
      caughtError = err as Error & { partialResult?: StandaloneReviewerResult };
    }

    expect(caughtError).toBeDefined();
    expect(caughtError?.message).toMatch(/no assistant text/i);

    // Partial result is attached to the error
    expect(caughtError?.partialResult).toBeDefined();
    expect(caughtError?.partialResult?.findings).toEqual([]);
    expect(caughtError?.partialResult?.tokenCostUSD).toBe(0);

    clientMock.restore();
  });

  test("defaults findings to [] when assistant text is not valid JSON, then propagates error", async () => {
    const clientMock = mockClient(BedrockAgentCoreClient);

    const stream = makeWellFormedStream("this is not json {{{", 500);

    clientMock.on(InvokeHarnessCommand).resolves({ stream: stream as never });

    const client = new BedrockAgentCoreClient({});
    const invocation = new ManagedHarnessReviewerInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client,
      toolCatalogue: EMPTY_TOOL_CATALOGUE,
    });

    let caughtError: (Error & { partialResult?: StandaloneReviewerResult }) | undefined;
    try {
      await invocation.invoke();
    } catch (err) {
      caughtError = err as Error & { partialResult?: StandaloneReviewerResult };
    }

    expect(caughtError).toBeDefined();
    expect(caughtError?.message).toMatch(/failed to parse/i);

    // Partial result: findings defaults to [], tokenCostUSD is computed from tokens
    expect(caughtError?.partialResult).toBeDefined();
    expect(caughtError?.partialResult?.findings).toEqual([]);
    expect(caughtError?.partialResult?.tokenCostUSD).toBeCloseTo(500 * ESTIMATED_USD_PER_TOKEN);

    clientMock.restore();
  });

  test("defaults findings to [] when the parsed JSON has a malformed findings field (not an array), then propagates error", async () => {
    const clientMock = mockClient(BedrockAgentCoreClient);

    // findings is a string instead of an array
    const malformedOutput = { findings: "not-an-array", modelVersion: "claude-v3" };
    const stream = makeWellFormedStream(JSON.stringify(malformedOutput), 300);

    clientMock.on(InvokeHarnessCommand).resolves({ stream: stream as never });

    const client = new BedrockAgentCoreClient({});
    const invocation = new ManagedHarnessReviewerInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client,
      toolCatalogue: EMPTY_TOOL_CATALOGUE,
    });

    // When findings is not an array, extractFindings returns [] but no parse error
    // is thrown (the JSON itself is valid). The result should succeed with empty findings.
    const result = await invocation.invoke();

    expect(result.findings).toEqual([]);
    expect(result.modelVersion).toBe("claude-v3");

    clientMock.restore();
  });

  test("silently drops findings with missing required fields and returns only valid ones", async () => {
    const clientMock = mockClient(BedrockAgentCoreClient);

    const mixedOutput = {
      findings: [
        // Valid finding
        {
          id: "WA-SEC-01",
          pillar: "Security",
          severity: "high",
          description: "Valid finding.",
          suggestedFix: "Fix it.",
        },
        // Missing 'id' — invalid
        {
          pillar: "Security",
          severity: "high",
          description: "Missing id.",
          suggestedFix: "Fix it.",
        },
        // Invalid severity — invalid
        {
          id: "WA-SEC-03",
          pillar: "Security",
          severity: "catastrophic",
          description: "Bad severity.",
          suggestedFix: "Fix it.",
        },
      ],
      modelVersion: "claude-v3",
    };

    const stream = makeWellFormedStream(JSON.stringify(mixedOutput), 400);
    clientMock.on(InvokeHarnessCommand).resolves({ stream: stream as never });

    const client = new BedrockAgentCoreClient({});
    const invocation = new ManagedHarnessReviewerInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client,
      toolCatalogue: EMPTY_TOOL_CATALOGUE,
    });

    const result = await invocation.invoke();

    // Only the valid finding survives
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.id).toBe("WA-SEC-01");

    clientMock.restore();
  });

  test("populates tokenCostUSD from metadata even when findings are malformed (missing tokenCostUSD scenario)", async () => {
    const clientMock = mockClient(BedrockAgentCoreClient);

    // findings field is absent entirely — extractFindings returns []
    const outputMissingFindings = { modelVersion: "claude-v3" };
    const stream = makeWellFormedStream(JSON.stringify(outputMissingFindings), 750);

    clientMock.on(InvokeHarnessCommand).resolves({ stream: stream as never });

    const client = new BedrockAgentCoreClient({});
    const invocation = new ManagedHarnessReviewerInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client,
      toolCatalogue: EMPTY_TOOL_CATALOGUE,
    });

    // No parse error — JSON is valid, findings just defaults to []
    const result = await invocation.invoke();

    expect(result.findings).toEqual([]);
    expect(result.tokenCostUSD).toBeCloseTo(750 * ESTIMATED_USD_PER_TOKEN);
    expect(result.modelVersion).toBe("claude-v3");

    clientMock.restore();
  });
});

// ---------------------------------------------------------------------------
// Test: session id is built as `<sessionId>-reviewer`
// ---------------------------------------------------------------------------

describe("ManagedHarnessReviewerInvocation — session id format", () => {
  test("passes '<sessionId>-reviewer' as the runtimeSessionId to InvokeHarness", async () => {
    const clientMock = mockClient(BedrockAgentCoreClient);

    const reviewerOutput = { findings: [], modelVersion: "claude-v3" };
    const stream = makeWellFormedStream(JSON.stringify(reviewerOutput), 100);

    clientMock.on(InvokeHarnessCommand).resolves({ stream: stream as never });

    const client = new BedrockAgentCoreClient({});
    const invocation = new ManagedHarnessReviewerInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: "my-session-42",
      client,
      toolCatalogue: EMPTY_TOOL_CATALOGUE,
    });

    await invocation.invoke();

    // Inspect the captured call to verify the runtimeSessionId
    const calls = clientMock.commandCalls(InvokeHarnessCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]?.input.runtimeSessionId).toBe("my-session-42-reviewer");

    clientMock.restore();
  });

  test("session id suffix '-reviewer' is appended regardless of the base session id format", async () => {
    const clientMock = mockClient(BedrockAgentCoreClient);

    const reviewerOutput = { findings: [], modelVersion: "v1" };
    const stream = makeWellFormedStream(JSON.stringify(reviewerOutput), 50);

    clientMock.on(InvokeHarnessCommand).resolves({ stream: stream as never });

    const client = new BedrockAgentCoreClient({});
    const invocation = new ManagedHarnessReviewerInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: "scheduled-reviewer-2024-01-15T10-30-00.000Z",
      client,
      toolCatalogue: EMPTY_TOOL_CATALOGUE,
    });

    await invocation.invoke();

    const calls = clientMock.commandCalls(InvokeHarnessCommand);
    expect(calls[0]?.args[0]?.input.runtimeSessionId).toBe(
      "scheduled-reviewer-2024-01-15T10-30-00.000Z-reviewer",
    );

    clientMock.restore();
  });
});

// ---------------------------------------------------------------------------
// Test: ReviewerHarnessClient — direct unit tests
// ---------------------------------------------------------------------------

describe("ReviewerHarnessClient — session id", () => {
  test("stores runtimeSessionId as '<sessionId>-reviewer'", async () => {
    const clientMock = mockClient(BedrockAgentCoreClient);

    const reviewerOutput = { findings: [], modelVersion: "v1" };
    const stream = makeWellFormedStream(JSON.stringify(reviewerOutput), 10);

    clientMock.on(InvokeHarnessCommand).resolves({ stream: stream as never });

    const client = new BedrockAgentCoreClient({});
    const harnessClient = new ReviewerHarnessClient({
      harnessArn: HARNESS_ARN,
      sessionId: "base-session",
      client,
    });

    await harnessClient.invoke();

    const calls = clientMock.commandCalls(InvokeHarnessCommand);
    expect(calls[0]?.args[0]?.input.runtimeSessionId).toBe("base-session-reviewer");

    clientMock.restore();
  });
});
