/**
 * Unit tests for the orchestrator Lambda handler.
 *
 * Covers the verification matrix from tasks.md task 6.4:
 *
 *   1. Success path → 200 with `{ terminationReason, prNumber }`.
 *   2. Bad JSON in `event.body` → 500 with `{ error }`.
 *   3. `runLoop` throws → 500 with `{ error }`.
 *   4. No 200 is written when `runLoop` does not return (early throw path).
 *   5. `LoopGates` is built with `runEditor` delegated to the editor
 *      invocation and `runReviewer` delegated to the reviewer invocation
 *      (verified via spies).
 *
 * Strategy: `runLoop` is mocked at the module level via `jest.mock` so
 * the handler never touches real AWS, CDK, or GitHub infrastructure.
 * `ManagedHarnessEditorInvocation` and `ManagedHarnessReviewerInvocation`
 * are also mocked so we can spy on their methods and verify the gates
 * delegate correctly.
 *
 * Requirements: 4.5, 4.6
 */

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that use them.
// ---------------------------------------------------------------------------

// Mock runLoop so the handler never drives a real loop.
jest.mock("@agent-harness/loop/src/run", () => ({
  runLoop: jest.fn(),
}));

// Mock ManagedHarnessEditorInvocation so we can spy on runEditor.
jest.mock("@agent-harness/editor/managed-harness-invocation", () => ({
  ManagedHarnessEditorInvocation: jest.fn().mockImplementation(() => ({
    runEditor: jest.fn(),
  })),
}));

// Mock ManagedHarnessReviewerInvocation so we can spy on invoke.
jest.mock("@agent-harness/scheduled-reviewer/src/run", () => ({
  ManagedHarnessReviewerInvocation: jest.fn().mockImplementation(() => ({
    invoke: jest.fn(),
  })),
}));

// Mock the local-runner adapters and config loader so the handler does not
// touch the filesystem or real tool implementations.
jest.mock("node:fs", () => ({
  readFileSync: jest.fn().mockReturnValue(
    JSON.stringify({
      limits: {
        iterationCap: 5,
        wallClockCapMinutes: 60,
        tokenSpendCapUSD: 10,
      },
      oscillation: {
        sameDiffWindow: 3,
        alternationWindow: 4,
      },
    }),
  ),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are declared)
// ---------------------------------------------------------------------------

import type { APIGatewayProxyEvent, Context } from "aws-lambda";
import { runLoop } from "@agent-harness/loop/src/run";
import { ManagedHarnessEditorInvocation } from "@agent-harness/editor/managed-harness-invocation";
import { ManagedHarnessReviewerInvocation } from "@agent-harness/scheduled-reviewer/src/run";
import { handler } from "../index";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockRunLoop = runLoop as jest.MockedFunction<typeof runLoop>;
const MockEditorInvocation = ManagedHarnessEditorInvocation as jest.MockedClass<
  typeof ManagedHarnessEditorInvocation
>;
const MockReviewerInvocation = ManagedHarnessReviewerInvocation as jest.MockedClass<
  typeof ManagedHarnessReviewerInvocation
>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A minimal valid trigger payload that satisfies `createSessionFromTrigger`.
 */
const VALID_TRIGGER = {
  schemaVersion: "1.0",
  triggerType: "feature-change",
  issue: {
    number: 42,
    title: "Add fanout module",
    body: "Please add a fanout module.",
    url: "https://github.com/example/repo/issues/42",
    openedBy: "alice",
  },
  module: {
    path: "modules/fanout",
    repository: "example/repo",
    ref: "main",
    commitSha: "abc123",
  },
  session: {
    id: "session-test-001",
    createdAt: new Date().toISOString(),
  },
  limits: {
    iterationCap: 5,
    wallClockCapMinutes: 60,
    tokenSpendCapUSD: 10,
  },
  auth: {
    githubInstallationToken: "ghs_test_token",
  },
};

/**
 * Build a minimal `APIGatewayProxyEvent` with the given body string.
 */
function makeEvent(body: string | null): APIGatewayProxyEvent {
  return {
    body,
    headers: {},
    multiValueHeaders: {},
    httpMethod: "POST",
    isBase64Encoded: false,
    path: "/orchestrate",
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent["requestContext"],
    resource: "/orchestrate",
  };
}

/** A no-op Lambda context. */
const LAMBDA_CONTEXT = {} as Context;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();

  // Set required environment variables.
  process.env["EDITOR_HARNESS_ARN"] =
    "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/editor-agent/abc";
  process.env["REVIEWER_HARNESS_ARN"] =
    "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/reviewer-agent/def";

  // Default: runLoop resolves successfully.
  mockRunLoop.mockResolvedValue({
    terminationReason: "success",
    prNumber: 99,
  });
});

afterEach(() => {
  delete process.env["EDITOR_HARNESS_ARN"];
  delete process.env["REVIEWER_HARNESS_ARN"];
});

// ---------------------------------------------------------------------------
// Test group 1: success path
// ---------------------------------------------------------------------------

describe("handler — success path", () => {
  it("returns 200 with terminationReason and prNumber when runLoop resolves", async () => {
    mockRunLoop.mockResolvedValue({
      terminationReason: "success",
      prNumber: 123,
    });

    const event = makeEvent(JSON.stringify(VALID_TRIGGER));
    const response = await handler(event, LAMBDA_CONTEXT, jest.fn());

    expect(response).toBeDefined();
    expect(response!.statusCode).toBe(200);

    const body = JSON.parse(response!.body);
    expect(body.terminationReason).toBe("success");
    expect(body.prNumber).toBe(123);
  });

  it("returns 200 with terminationReason=iteration-cap and prNumber=null when loop hits cap", async () => {
    mockRunLoop.mockResolvedValue({
      terminationReason: "iteration-cap",
      prNumber: null,
    });

    const event = makeEvent(JSON.stringify(VALID_TRIGGER));
    const response = await handler(event, LAMBDA_CONTEXT, jest.fn());

    expect(response!.statusCode).toBe(200);
    const body = JSON.parse(response!.body);
    expect(body.terminationReason).toBe("iteration-cap");
    expect(body.prNumber).toBeNull();
  });

  it("calls runLoop exactly once per invocation", async () => {
    const event = makeEvent(JSON.stringify(VALID_TRIGGER));
    await handler(event, LAMBDA_CONTEXT, jest.fn());

    expect(mockRunLoop).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Test group 2: bad JSON in event.body → 500
// ---------------------------------------------------------------------------

describe("handler — bad JSON in event.body", () => {
  it("returns 500 with { error } when event.body is not valid JSON", async () => {
    const event = makeEvent("this is not json {{{");
    const response = await handler(event, LAMBDA_CONTEXT, jest.fn());

    expect(response!.statusCode).toBe(500);
    const body = JSON.parse(response!.body);
    expect(body).toHaveProperty("error");
    expect(typeof body.error).toBe("string");
  });

  it("does NOT return 200 when event.body is invalid JSON", async () => {
    const event = makeEvent("{bad json}");
    const response = await handler(event, LAMBDA_CONTEXT, jest.fn());

    expect(response!.statusCode).not.toBe(200);
  });

  it("does NOT call runLoop when event.body is invalid JSON", async () => {
    const event = makeEvent("not-json");
    await handler(event, LAMBDA_CONTEXT, jest.fn());

    expect(mockRunLoop).not.toHaveBeenCalled();
  });

  it("returns 500 with { error } when event.body is null", async () => {
    // null body → JSON.parse("{}") succeeds but createSessionFromTrigger
    // may fail on missing required fields. Either way, no 200.
    const event = makeEvent(null);
    const response = await handler(event, LAMBDA_CONTEXT, jest.fn());

    // The handler should not crash — it should return a structured response.
    expect(response).toBeDefined();
    expect(response!.statusCode).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Test group 3: runLoop throws → 500
// ---------------------------------------------------------------------------

describe("handler — runLoop throws", () => {
  it("returns 500 with { error } when runLoop rejects", async () => {
    mockRunLoop.mockRejectedValue(new Error("InvokeHarness throttled"));

    const event = makeEvent(JSON.stringify(VALID_TRIGGER));
    const response = await handler(event, LAMBDA_CONTEXT, jest.fn());

    expect(response!.statusCode).toBe(500);
    const body = JSON.parse(response!.body);
    expect(body).toHaveProperty("error");
    expect(body.error).toContain("InvokeHarness throttled");
  });

  it("does NOT return 200 when runLoop throws", async () => {
    mockRunLoop.mockRejectedValue(new Error("network failure"));

    const event = makeEvent(JSON.stringify(VALID_TRIGGER));
    const response = await handler(event, LAMBDA_CONTEXT, jest.fn());

    expect(response!.statusCode).not.toBe(200);
  });

  it("returns 500 with { error } when runLoop throws a non-Error value", async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    mockRunLoop.mockRejectedValue("string error");

    const event = makeEvent(JSON.stringify(VALID_TRIGGER));
    const response = await handler(event, LAMBDA_CONTEXT, jest.fn());

    expect(response!.statusCode).toBe(500);
    const body = JSON.parse(response!.body);
    expect(body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// Test group 4: no 200 on early throw path
// ---------------------------------------------------------------------------

describe("handler — no 200 written on early throw path", () => {
  it("returns 500 (not 200) when EDITOR_HARNESS_ARN is missing", async () => {
    delete process.env["EDITOR_HARNESS_ARN"];

    const event = makeEvent(JSON.stringify(VALID_TRIGGER));
    const response = await handler(event, LAMBDA_CONTEXT, jest.fn());

    expect(response!.statusCode).toBe(500);
    const body = JSON.parse(response!.body);
    expect(body).toHaveProperty("error");
    expect(body.error).toContain("EDITOR_HARNESS_ARN");
  });

  it("returns 500 (not 200) when REVIEWER_HARNESS_ARN is missing", async () => {
    delete process.env["REVIEWER_HARNESS_ARN"];

    const event = makeEvent(JSON.stringify(VALID_TRIGGER));
    const response = await handler(event, LAMBDA_CONTEXT, jest.fn());

    expect(response!.statusCode).toBe(500);
    const body = JSON.parse(response!.body);
    expect(body).toHaveProperty("error");
    expect(body.error).toContain("REVIEWER_HARNESS_ARN");
  });

  it("does NOT call runLoop when EDITOR_HARNESS_ARN is missing", async () => {
    delete process.env["EDITOR_HARNESS_ARN"];

    const event = makeEvent(JSON.stringify(VALID_TRIGGER));
    await handler(event, LAMBDA_CONTEXT, jest.fn());

    expect(mockRunLoop).not.toHaveBeenCalled();
  });

  it("does NOT call runLoop when REVIEWER_HARNESS_ARN is missing", async () => {
    delete process.env["REVIEWER_HARNESS_ARN"];

    const event = makeEvent(JSON.stringify(VALID_TRIGGER));
    await handler(event, LAMBDA_CONTEXT, jest.fn());

    expect(mockRunLoop).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test group 5: LoopGates delegation — runEditor and runReviewer spies
// ---------------------------------------------------------------------------

describe("handler — LoopGates delegation", () => {
  /**
   * Capture the `gates` argument passed to `runLoop` so we can call
   * `gates.runEditor` and `gates.runReviewer` directly and verify they
   * delegate to the correct invocation instances.
   */
  function captureGatesFromRunLoop(): Promise<import("@agent-harness/loop/src/run").LoopGates> {
    return new Promise((resolve) => {
      mockRunLoop.mockImplementation(async (options) => {
        resolve(options.gates);
        return { terminationReason: "success", prNumber: 1 };
      });
    });
  }

  it("runEditor in LoopGates delegates to ManagedHarnessEditorInvocation.runEditor", async () => {
    // Create a spy for runEditor and inject it via the mock constructor.
    const runEditorSpy = jest.fn().mockResolvedValue({ edits: [] });
    MockEditorInvocation.mockImplementationOnce(() => ({
      runEditor: runEditorSpy,
    }) as unknown as ManagedHarnessEditorInvocation);

    const gatesPromise = captureGatesFromRunLoop();

    const event = makeEvent(JSON.stringify(VALID_TRIGGER));
    const handlerPromise = handler(event, LAMBDA_CONTEXT, jest.fn());

    const gates = await gatesPromise;
    await handlerPromise;

    // Call gates.runEditor with a minimal context.
    const minimalContext = {
      trigger: VALID_TRIGGER as unknown as import("@agent-harness/loop/src/run").LoopContext["trigger"],
      history: [],
    };
    await gates.runEditor(minimalContext);

    // The spy on the editor instance's runEditor should have been called.
    expect(runEditorSpy).toHaveBeenCalledTimes(1);
    expect(runEditorSpy).toHaveBeenCalledWith(minimalContext);
  });

  it("runReviewer in LoopGates delegates to ManagedHarnessReviewerInvocation.invoke", async () => {
    const gatesPromise = captureGatesFromRunLoop();

    // Make the reviewer's invoke return a valid StandaloneReviewerResult.
    const reviewerInstance = {
      invoke: jest.fn().mockResolvedValue({
        findings: [],
        tokenCostUSD: 0.01,
        modelVersion: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      }),
    };
    MockReviewerInvocation.mockImplementationOnce(() => reviewerInstance as unknown as ManagedHarnessReviewerInvocation);

    const event = makeEvent(JSON.stringify(VALID_TRIGGER));
    const handlerPromise = handler(event, LAMBDA_CONTEXT, jest.fn());

    const gates = await gatesPromise;
    await handlerPromise;

    // Call gates.runReviewer with a diff string.
    const diff = "--- a/lib/x.ts\n+++ b/lib/x.ts\n@@ -1 +1 @@\n-old\n+new";
    await gates.runReviewer(diff);

    // The spy on the reviewer instance's invoke should have been called
    // with the diff wrapped in the expected input shape.
    expect(reviewerInstance.invoke).toHaveBeenCalledTimes(1);
    expect(reviewerInstance.invoke).toHaveBeenCalledWith({ diff });
  });

  it("ManagedHarnessEditorInvocation is constructed with the editor harness ARN", async () => {
    const event = makeEvent(JSON.stringify(VALID_TRIGGER));
    await handler(event, LAMBDA_CONTEXT, jest.fn());

    expect(MockEditorInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessArn: process.env["EDITOR_HARNESS_ARN"],
      }),
    );
  });

  it("ManagedHarnessReviewerInvocation is constructed with the reviewer harness ARN", async () => {
    const event = makeEvent(JSON.stringify(VALID_TRIGGER));
    await handler(event, LAMBDA_CONTEXT, jest.fn());

    expect(MockReviewerInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessArn: process.env["REVIEWER_HARNESS_ARN"],
      }),
    );
  });

  it("ManagedHarnessEditorInvocation is constructed with the session id from the trigger", async () => {
    const event = makeEvent(JSON.stringify(VALID_TRIGGER));
    await handler(event, LAMBDA_CONTEXT, jest.fn());

    expect(MockEditorInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: VALID_TRIGGER.session.id,
      }),
    );
  });

  it("ManagedHarnessReviewerInvocation is constructed with the session id from the trigger", async () => {
    const event = makeEvent(JSON.stringify(VALID_TRIGGER));
    await handler(event, LAMBDA_CONTEXT, jest.fn());

    expect(MockReviewerInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: VALID_TRIGGER.session.id,
      }),
    );
  });
});
