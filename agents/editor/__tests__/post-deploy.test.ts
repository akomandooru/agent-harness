/**
 * Unit tests for the `postDeploy.invoke` tool wrapper.
 *
 * Covers the integration between the editor agent's tool catalogue and
 * the synthetic post-deploy harness's runner contract:
 *   - Each of the four outcomes from `design.md` Data Models passes
 *     through the wrapper unchanged.
 *   - Stack outputs and deploy-failure logs flow from the
 *     orchestrator-owned `PostDeployContext` into the runner's input.
 *   - The wrapper rejects an output that does not match the schema
 *     (defence in depth against a buggy runner).
 *   - Session-id mismatch between the context and the runtime is
 *     surfaced as a handler error.
 */

import {
  wrapTool,
  type SessionSink,
  type ToolInvocationRecord,
  type WrapperRuntime,
} from "@agent-harness/shared";
import type {
  PostDeployInput,
  PostDeployOutput,
} from "@agent-harness/post-deploy";

import {
  createPostDeployTool,
  type PostDeployContext,
  type PostDeployRunner,
} from "../tools/post-deploy";


class InMemorySink implements SessionSink {
  public records: ToolInvocationRecord[] = [];
  public async appendToolRecord(record: ToolInvocationRecord): Promise<void> {
    this.records.push(record);
  }
}

interface Fixture {
  readonly sink: InMemorySink;
  readonly runtime: WrapperRuntime;
  readonly context: PostDeployContext;
  /** Captures every input the runner stub was invoked with. */
  readonly runnerCalls: PostDeployInput[];
  /** Set the next runner result. */
  setRunnerResult: (output: PostDeployOutput) => void;
  /** Make the runner throw on its next call. */
  setRunnerError: (err: Error) => void;
  /** The stub runner the wrapper invokes. */
  runner: PostDeployRunner;
}

function makeFixture(sessionId = "session-test-postdeploy"): Fixture {
  const sink = new InMemorySink();
  const runtime: WrapperRuntime = {
    moduleRoot: "/synthetic/module-root-for-postdeploy-tests",
    sessionSink: sink,
    sessionId,
    iterationIndex: 0,
  };
  const context: PostDeployContext = { sessionId };

  const runnerCalls: PostDeployInput[] = [];
  let nextResult: PostDeployOutput | undefined;
  let nextError: Error | undefined;
  const runner: PostDeployRunner = async (input) => {
    runnerCalls.push(input);
    if (nextError !== undefined) {
      const e = nextError;
      nextError = undefined;
      throw e;
    }
    if (nextResult === undefined) {
      throw new Error("test setup error: runner result was not set");
    }
    const out = nextResult;
    nextResult = undefined;
    return out;
  };
  return {
    sink,
    runtime,
    context,
    runnerCalls,
    setRunnerResult: (output) => {
      nextResult = output;
    },
    setRunnerError: (err) => {
      nextError = err;
    },
    runner,
  };
}


describe("postDeploy.invoke: outcome pass-through", () => {
  const outcomes: PostDeployOutput["outcome"][] = [
    "pass",
    "fail",
    "partial",
    "deploy-failure",
  ];

  for (const outcome of outcomes) {
    it(`passes outcome ${outcome} through unchanged`, async () => {
      const fixture = makeFixture();
      const expected: PostDeployOutput = {
        outcome,
        report: { sessionId: fixture.context.sessionId, marker: "x" },
        ...(outcome === "deploy-failure"
          ? { deployLogs: "stack creation failed" }
          : {}),
      };
      fixture.setRunnerResult(expected);

      const wrapped = wrapTool(
        createPostDeployTool(fixture.runner, fixture.context),
      );
      const result = await wrapped({}, fixture.runtime);

      expect(result).toEqual(expected);
      expect(fixture.runnerCalls).toHaveLength(1);
      expect(fixture.runnerCalls[0].sessionId).toBe(
        fixture.context.sessionId,
      );

      // Wrapper recorded the call as ok.
      expect(fixture.sink.records).toHaveLength(1);
      expect(fixture.sink.records[0]?.outcome).toBe("ok");
      expect(fixture.sink.records[0]?.tool).toBe("postDeploy.invoke");
    });
  }
});


describe("postDeploy.invoke: context flows into the runner", () => {
  it("forwards stackOutputs and clears them when context is reset", async () => {
    const fixture = makeFixture();
    fixture.context.stackOutputs = {
      "FanoutPreview.ApiEndpointUrl": "https://api/",
      "FanoutPreview.QueueUrl": "https://sqs/",
    };
    fixture.setRunnerResult({
      outcome: "pass",
      report: {},
    });

    const wrapped = wrapTool(
      createPostDeployTool(fixture.runner, fixture.context),
    );
    await wrapped({}, fixture.runtime);

    expect(fixture.runnerCalls[0].stackOutputs).toEqual({
      "FanoutPreview.ApiEndpointUrl": "https://api/",
      "FanoutPreview.QueueUrl": "https://sqs/",
    });

    // Simulate the orchestrator clearing outputs (e.g., after a deploy
    // error). The next call to the wrapper should pass undefined.
    fixture.context.stackOutputs = undefined;
    fixture.setRunnerResult({ outcome: "fail", report: {} });
    await wrapped({}, fixture.runtime);
    expect(fixture.runnerCalls[1].stackOutputs).toBeUndefined();
  });

  it("forwards deployFailureLogs when set", async () => {
    const fixture = makeFixture();
    fixture.context.deployFailureLogs = "CFN: ResourceLimitExceeded";
    fixture.setRunnerResult({
      outcome: "deploy-failure",
      report: {},
      deployLogs: "CFN: ResourceLimitExceeded",
    });

    const wrapped = wrapTool(
      createPostDeployTool(fixture.runner, fixture.context),
    );
    const result = await wrapped({}, fixture.runtime);

    expect(fixture.runnerCalls[0].deployFailureLogs).toBe(
      "CFN: ResourceLimitExceeded",
    );
    expect(result.outcome).toBe("deploy-failure");
    expect(result.deployLogs).toBe("CFN: ResourceLimitExceeded");
  });
});


describe("postDeploy.invoke: schema validation", () => {
  it("rejects extra properties on the input (the agent cannot smuggle stackOutputs)", async () => {
    const fixture = makeFixture();
    const wrapped = wrapTool(
      createPostDeployTool(fixture.runner, fixture.context),
    );

    await expect(
      wrapped(
        // The handler signature is `Record<string, never>`, so we cast
        // through unknown to simulate the agent supplying extra
        // properties at the schema layer.
        { stackOutputs: { ApiEndpointUrl: "x" } } as unknown as Record<
          string,
          never
        >,
        fixture.runtime,
      ),
    ).rejects.toThrow();

    expect(fixture.runnerCalls).toHaveLength(0);
    expect(fixture.sink.records[0]?.outcome).toBe("input-schema-error");
  });

  it("rejects an output that does not match the schema", async () => {
    const fixture = makeFixture();
    fixture.setRunnerResult({
      // Invalid outcome value: not one of the four enum literals.
      outcome: "completely-broken" as PostDeployOutput["outcome"],
      report: {},
    });

    const wrapped = wrapTool(
      createPostDeployTool(fixture.runner, fixture.context),
    );

    await expect(wrapped({}, fixture.runtime)).rejects.toThrow();
    expect(fixture.sink.records[0]?.outcome).toBe("output-schema-error");
  });
});


describe("postDeploy.invoke: session id mismatch", () => {
  it("rejects when the runtime's session id disagrees with the context", async () => {
    const fixture = makeFixture("session-runtime");
    fixture.context.sessionId = "session-context-stale";
    fixture.setRunnerResult({ outcome: "pass", report: {} });

    const wrapped = wrapTool(
      createPostDeployTool(fixture.runner, fixture.context),
    );

    await expect(wrapped({}, fixture.runtime)).rejects.toThrow(
      /session id mismatch/,
    );
    expect(fixture.runnerCalls).toHaveLength(0);
    expect(fixture.sink.records[0]?.outcome).toBe("handler-error");
  });
});
