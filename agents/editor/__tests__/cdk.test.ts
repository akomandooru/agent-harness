/**
 * Unit tests for the `cdk.*` tool wrappers.
 *
 * Covers the verification matrix from tasks.md task 3.3:
 *   - `cdk.diff` invokes the CDK CLI with the preview-context flags and
 *     the session-context flag, and returns the captured diff text.
 *   - `cdk.deploy` happy path: runner exits 0, logs returned, outcome
 *     `"ok"`, session/env context flags passed.
 *   - `cdk.deploy` failure path: runner exits non-zero, outcome
 *     `"deploy-error"`, logs still captured.
 *   - The deploy cost report fires the wrapper's `recordDeployCost` hook.
 *   - Stack outputs are parsed from `cdk deploy` stdout when present.
 *
 * Tests inject a stub `CdkRunner` so no real CDK installation or AWS
 * credentials are needed. The fixture creates a temp directory to act as
 * the module root, mirroring the pattern from `module.test.ts`.
 */

import { promises as fs, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HandlerError,
  wrapTool,
  type CostCounter,
  type SessionSink,
  type ToolInvocationRecord,
  type WrapperRuntime,
} from "@agent-harness/shared";

import {
  createCdkDeployTool,
  createCdkDiffTool,
  type CdkRunResult,
  type CdkRunner,
} from "../tools/cdk";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

class InMemorySink implements SessionSink {
  public records: ToolInvocationRecord[] = [];
  public async appendToolRecord(record: ToolInvocationRecord): Promise<void> {
    this.records.push(record);
  }
}

class InMemoryCostCounter implements CostCounter {
  public tokenCalls: number[] = [];
  public deployCalls: number[] = [];
  public recordTokenUsage(usd: number): void {
    this.tokenCalls.push(usd);
  }
  public recordDeployCost(usd: number): void {
    this.deployCalls.push(usd);
  }
}

interface RecordedInvocation {
  readonly args: readonly string[];
  readonly cwd: string;
}

/**
 * Stub runner that records every invocation and returns a scripted result.
 * The `nextResult` field is a queue: each call pops the head, falling back
 * to a default success result if the queue is empty.
 */
class StubCdkRunner implements CdkRunner {
  public readonly invocations: RecordedInvocation[] = [];
  private readonly results: CdkRunResult[] = [];
  public defaultResult: CdkRunResult = {
    exitCode: 0,
    stdout: "",
    stderr: "",
  };

  public enqueue(result: CdkRunResult): void {
    this.results.push(result);
  }

  public async run(
    args: readonly string[],
    options: { readonly cwd: string }
  ): Promise<CdkRunResult> {
    this.invocations.push({ args, cwd: options.cwd });
    return this.results.shift() ?? this.defaultResult;
  }
}

interface Fixture {
  readonly root: string;
  readonly sink: InMemorySink;
  readonly costCounter: InMemoryCostCounter;
  readonly runner: StubCdkRunner;
  readonly runtime: WrapperRuntime;
}

async function makeFixture(
  overrides: Partial<WrapperRuntime> = {}
): Promise<Fixture> {
  // Canonicalise so the wrapper's symlink resolution agrees with what we
  // pass in. The CDK tools don't enforce path scope themselves (no
  // `pathField`), but mirroring `module.test.ts` keeps the fixture shape
  // consistent.
  const base = realpathSync(
    await fs.mkdtemp(join(tmpdir(), "agent-harness-cdk-"))
  );
  const sink = new InMemorySink();
  const costCounter = new InMemoryCostCounter();
  const runner = new StubCdkRunner();
  const runtime: WrapperRuntime = {
    moduleRoot: base,
    sessionSink: sink,
    costCounter,
    sessionId: "session-test-abc",
    iterationIndex: 0,
    ...overrides,
  };
  return { root: base, sink, costCounter, runner, runtime };
}

async function cleanup(fixture: Fixture): Promise<void> {
  // Match the retry-on-EBUSY pattern from module.test.ts so Windows
  // doesn't flake on transient locks.
  const attempts = 5;
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 5 });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** True if `args` contains both halves of `--context KEY=value`. */
function hasContextFlag(
  args: readonly string[],
  key: string,
  value: string
): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "--context" && args[i + 1] === `${key}=${value}`) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// cdk.diff
// ---------------------------------------------------------------------------

describe("cdk.diff", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(async () => {
    await cleanup(fixture);
  });

  it("invokes the CDK CLI with the preview env context and the session id", async () => {
    fixture.runner.enqueue({
      exitCode: 0,
      stdout: "Stack FanoutPreview\nResources\n[+] AWS::SQS::Queue ...\n",
      stderr: "",
    });
    const wrapped = wrapTool(createCdkDiffTool(fixture.runner));

    const result = await wrapped({}, fixture.runtime);

    // Only one CLI invocation per tool call.
    expect(fixture.runner.invocations).toHaveLength(1);
    const call = fixture.runner.invocations[0];
    // First positional arg is the CDK subcommand.
    expect(call.args[0]).toBe("diff");
    // CDK ran in the module root, not the harness's CWD.
    expect(call.cwd).toBe(fixture.runtime.moduleRoot);
    // Hard-coded preview env tag.
    expect(
      hasContextFlag(call.args, "agent-harness/env", "preview")
    ).toBe(true);
    // Session id flows from `WrapperRuntime.sessionId`.
    expect(
      hasContextFlag(
        call.args,
        "agent-harness/session",
        "session-test-abc"
      )
    ).toBe(true);
    // Returned diff text is the runner's stdout.
    expect(result.diff).toContain("AWS::SQS::Queue");
    expect(fixture.sink.records[0]?.outcome).toBe("ok");
  });

  it("returns an empty string when the diff has no changes", async () => {
    fixture.runner.enqueue({ exitCode: 0, stdout: "", stderr: "" });
    const wrapped = wrapTool(createCdkDiffTool(fixture.runner));

    const result = await wrapped({}, fixture.runtime);

    expect(result.diff).toBe("");
    expect(fixture.sink.records[0]?.outcome).toBe("ok");
  });

  it("surfaces stderr when the CDK CLI exits non-zero", async () => {
    // `cdk diff` is a read-only sensor in the design; non-zero exit is
    // information for the loop, not a tool error. The handler folds
    // stdout+stderr into the diff text so the agent sees what went wrong.
    fixture.runner.enqueue({
      exitCode: 1,
      stdout: "",
      stderr: "Error: synth failed",
    });
    const wrapped = wrapTool(createCdkDiffTool(fixture.runner));

    const result = await wrapped({}, fixture.runtime);

    expect(result.diff).toMatch(/synth failed/);
    expect(fixture.sink.records[0]?.outcome).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// cdk.deploy
// ---------------------------------------------------------------------------

describe("cdk.deploy", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(async () => {
    await cleanup(fixture);
  });

  it("happy path: returns outcome 'ok' with logs and passes preview/session context", async () => {
    fixture.runner.enqueue({
      exitCode: 0,
      stdout:
        "FanoutPreview: deploying...\n" +
        "FanoutPreview: creating CloudFormation changeset...\n" +
        "FanoutPreview: success\n",
      stderr: "",
    });
    const wrapped = wrapTool(createCdkDeployTool(fixture.runner));

    const result = await wrapped({}, fixture.runtime);

    expect(result.outcome).toBe("ok");
    expect(result.logs).toMatch(/FanoutPreview: success/);
    // The deploy subcommand ran with the preview env tag and the session id.
    expect(fixture.runner.invocations).toHaveLength(1);
    const call = fixture.runner.invocations[0];
    expect(call.args[0]).toBe("deploy");
    expect(call.cwd).toBe(fixture.runtime.moduleRoot);
    expect(
      hasContextFlag(call.args, "agent-harness/env", "preview")
    ).toBe(true);
    expect(
      hasContextFlag(
        call.args,
        "agent-harness/session",
        "session-test-abc"
      )
    ).toBe(true);
    // Non-interactive: the wrapper has to pass a non-interactive flag so
    // the deploy doesn't hang waiting for confirmation.
    expect(call.args).toContain("--require-approval");
    // The session record carries the cost report shape.
    expect(fixture.sink.records[0]?.outcome).toBe("ok");
    expect(fixture.sink.records[0]?.cost).toBeDefined();
    expect(fixture.sink.records[0]?.cost?.category).toBe("deploy");
  });

  it("parses stack outputs from CDK deploy stdout when present", async () => {
    // Mimic the typical CDK 2.x deploy output format: an `Outputs:` header,
    // then `StackName.Key = Value` lines, then a blank line.
    const stdout = [
      "FanoutPreview: deploying...",
      "FanoutPreview: success",
      "",
      "Outputs:",
      "FanoutPreview.ApiEndpointUrl = https://abc.execute-api.us-east-1.amazonaws.com/prod/",
      "FanoutPreview.QueueUrl = https://sqs.us-east-1.amazonaws.com/123/queue",
      "",
      "Stack ARN:",
      "arn:aws:cloudformation:us-east-1:123:stack/FanoutPreview/abc",
    ].join("\n");
    fixture.runner.enqueue({ exitCode: 0, stdout, stderr: "" });
    const wrapped = wrapTool(createCdkDeployTool(fixture.runner));

    const result = await wrapped({}, fixture.runtime);

    expect(result.outcome).toBe("ok");
    expect(result.stackOutputs).toBeDefined();
    expect(result.stackOutputs).toMatchObject({
      "FanoutPreview.ApiEndpointUrl":
        "https://abc.execute-api.us-east-1.amazonaws.com/prod/",
      "FanoutPreview.QueueUrl":
        "https://sqs.us-east-1.amazonaws.com/123/queue",
    });
  });

  it("failure path: returns outcome 'deploy-error' and captures logs", async () => {
    fixture.runner.enqueue({
      exitCode: 1,
      stdout: "FanoutPreview: deploying...\n",
      stderr:
        "FanoutPreview failed: CloudFormation stack rollback required\n",
    });
    const wrapped = wrapTool(createCdkDeployTool(fixture.runner));

    const result = await wrapped({}, fixture.runtime);

    expect(result.outcome).toBe("deploy-error");
    expect(result.logs).toMatch(/FanoutPreview: deploying/);
    expect(result.logs).toMatch(/CloudFormation stack rollback/);
    // Deploy errors are still recorded as `ok` from the wrapper's
    // perspective: the tool ran successfully and produced a contract-
    // conforming output. The agent (not the wrapper) decides what to do
    // with `outcome: "deploy-error"`.
    expect(fixture.sink.records[0]?.outcome).toBe("ok");
  });

  it("fires the deploy cost counter with the wrapper's cost report", async () => {
    fixture.runner.enqueue({ exitCode: 0, stdout: "ok\n", stderr: "" });
    const wrapped = wrapTool(createCdkDeployTool(fixture.runner));

    await wrapped({}, fixture.runtime);

    // Exactly one deploy cost call per deploy. The dollar amount is
    // provisional (task 10.3 measures it); we only assert that the hook
    // fired with a non-negative finite number.
    expect(fixture.costCounter.deployCalls).toHaveLength(1);
    expect(fixture.costCounter.deployCalls[0]).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(fixture.costCounter.deployCalls[0])).toBe(true);
    expect(fixture.costCounter.tokenCalls).toEqual([]);
  });

  it("fires the deploy cost counter even when the deploy fails", async () => {
    // Deploy errors still consume preview infrastructure (CFN rollback,
    // half-created resources). The cost report fires regardless of
    // outcome so the cost-cap stop condition reflects reality.
    fixture.runner.enqueue({
      exitCode: 1,
      stdout: "",
      stderr: "boom",
    });
    const wrapped = wrapTool(createCdkDeployTool(fixture.runner));

    const result = await wrapped({}, fixture.runtime);

    expect(result.outcome).toBe("deploy-error");
    expect(fixture.costCounter.deployCalls).toHaveLength(1);
  });

  it("rejects session ids with shell-meaningful characters", async () => {
    // The trigger payload validator should never let one of these
    // through, but the wrapper has its own allow-list as
    // defence-in-depth. A session id with a `;` would otherwise let
    // a malformed payload break out of the `--context KEY=value` shape.
    const badRuntime: WrapperRuntime = {
      ...fixture.runtime,
      sessionId: "session-evil; rm -rf /",
    };
    const wrapped = wrapTool(createCdkDeployTool(fixture.runner));

    await expect(wrapped({}, badRuntime)).rejects.toBeInstanceOf(
      HandlerError
    );
    // No CLI invocation happened: the rejection fired before spawn.
    expect(fixture.runner.invocations).toHaveLength(0);
  });
});
