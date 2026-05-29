/**
 * Unit tests for the `sensor.*` tool wrappers.
 *
 * Covers the verification matrix from tasks.md task 3.4: sensor self-tests
 * against fixtures cover passing and failing cases for each sensor.
 *
 * Tests inject a stub `SensorRunner` so no real CDK, tsc, ESLint, or Jest
 * installation is needed. Fixtures are canned outputs that match the
 * formats documented at the top of `tools/sensors.ts`.
 */

import { promises as fs, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  wrapTool,
  type SessionSink,
  type ToolInvocationRecord,
  type WrapperRuntime,
} from "@agent-harness/shared";

import {
  createCdkNagTool,
  createEslintTool,
  createTscTool,
  createUnitTestsTool,
  parseCdkNagOutput,
  parseEslintOutput,
  parseJestOutput,
  parseTscOutput,
  type SensorRunResult,
  type SensorRunner,
} from "../tools/sensors";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

class InMemorySink implements SessionSink {
  public records: ToolInvocationRecord[] = [];
  public async appendToolRecord(record: ToolInvocationRecord): Promise<void> {
    this.records.push(record);
  }
}

interface RecordedSensorInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/**
 * Stub runner that records every invocation and returns a scripted
 * result. Mirrors `StubCdkRunner` from `cdk.test.ts` so the two suites
 * share an idiom.
 */
class StubSensorRunner implements SensorRunner {
  public readonly invocations: RecordedSensorInvocation[] = [];
  private readonly results: SensorRunResult[] = [];
  public defaultResult: SensorRunResult = {
    exitCode: 0,
    stdout: "",
    stderr: "",
  };

  public enqueue(result: SensorRunResult): void {
    this.results.push(result);
  }

  public async run(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string }
  ): Promise<SensorRunResult> {
    this.invocations.push({ command, args, cwd: options.cwd });
    return this.results.shift() ?? this.defaultResult;
  }
}

interface Fixture {
  readonly root: string;
  readonly sink: InMemorySink;
  readonly runner: StubSensorRunner;
  readonly runtime: WrapperRuntime;
}

async function makeFixture(): Promise<Fixture> {
  const base = realpathSync(
    await fs.mkdtemp(join(tmpdir(), "agent-harness-sensors-"))
  );
  const sink = new InMemorySink();
  const runner = new StubSensorRunner();
  const runtime: WrapperRuntime = {
    moduleRoot: base,
    sessionSink: sink,
    sessionId: "session-test-sensors",
    iterationIndex: 0,
  };
  return { root: base, sink, runner, runtime };
}

async function cleanup(fixture: Fixture): Promise<void> {
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

// ---------------------------------------------------------------------------
// sensor.cdkNag
// ---------------------------------------------------------------------------

describe("sensor.cdkNag", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(async () => {
    await cleanup(fixture);
  });

  it("passing case: clean synth produces no findings and passed=true", async () => {
    fixture.runner.enqueue({
      exitCode: 0,
      stdout: [
        "Successfully synthesized to /tmp/cdk.out",
        "Supply a stack id (FanoutPreview) to display its template.",
      ].join("\n"),
      stderr: "",
    });
    const wrapped = wrapTool(createCdkNagTool(fixture.runner));

    const result = await wrapped({}, fixture.runtime);

    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
    // The CLI ran in the module root, with the strict synth flags.
    expect(fixture.runner.invocations).toHaveLength(1);
    const call = fixture.runner.invocations[0];
    expect(call.command).toBe("npx");
    expect(call.args[0]).toBe("cdk");
    expect(call.args).toContain("synth");
    expect(call.args).toContain("--strict");
    expect(call.cwd).toBe(fixture.runtime.moduleRoot);
    // The wrapper recorded the call as ok and with no cost.
    expect(fixture.sink.records[0]?.outcome).toBe("ok");
    expect(fixture.sink.records[0]?.cost).toBeUndefined();
  });

  it("failing case: error annotations parsed into findings with passed=false", async () => {
    // Two error annotations and one warning, mixed in among regular
    // synth chatter. Severity error trips passed=false; the warning is
    // surfaced but does not flip the gate.
    const stderr = [
      "[Error at /FanoutPreview/Topic/Resource] AwsSolutions-SNS3: The SNS Topic does not require publishers to use SSL.",
      "[Warning at /FanoutPreview/Queue/Resource] AwsSolutions-SQS3: The SQS queue is not used as a dead-letter queue.",
      "[Error at /FanoutPreview/IngressFn/ServiceRole/DefaultPolicy/Resource] AwsSolutions-IAM5[Resource::*]: The IAM entity contains wildcard permissions.",
      "synth completed with errors",
    ].join("\n");
    fixture.runner.enqueue({ exitCode: 1, stdout: "", stderr });
    const wrapped = wrapTool(createCdkNagTool(fixture.runner));

    const result = await wrapped({}, fixture.runtime);

    expect(result.passed).toBe(false);
    expect(result.findings).toHaveLength(3);
    // First finding: HTTPS-only on SNS, severity error.
    expect(result.findings[0]).toMatchObject({
      resourceId: "/FanoutPreview/Topic/Resource",
      ruleId: "AwsSolutions-SNS3",
      severity: "error",
    });
    expect(result.findings[0].message).toMatch(/SSL/);
    // Second finding: warning passes through.
    expect(result.findings[1]).toMatchObject({
      ruleId: "AwsSolutions-SQS3",
      severity: "warning",
    });
    // Third finding: rule id strips the optional `[Resource::*]` block.
    expect(result.findings[2]).toMatchObject({
      ruleId: "AwsSolutions-IAM5",
      severity: "error",
    });
    expect(result.findings[2].resourceId).toContain("IngressFn");
  });

  it("warnings only: passed=true even though findings is non-empty", async () => {
    // The design treats cdk-nag warnings as informational; only errors
    // fail the sensor.
    const stderr =
      "[Warning at /FanoutPreview/Queue/Resource] AwsSolutions-SQS3: not a DLQ.";
    fixture.runner.enqueue({ exitCode: 0, stdout: "", stderr });
    const wrapped = wrapTool(createCdkNagTool(fixture.runner));

    const result = await wrapped({}, fixture.runtime);

    expect(result.passed).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("warning");
  });

  it("parser unit: ignores lines that don't match the cdk-nag annotation shape", () => {
    const out = [
      "Some unrelated synth log line",
      "[Info at /FanoutPreview/X] Something info-level we drop",
      "[Error at /A/B] AwsSolutions-X1: real finding",
      "  ", // blank
    ].join("\n");
    const findings = parseCdkNagOutput(out);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "AwsSolutions-X1",
      resourceId: "/A/B",
      severity: "error",
    });
  });
});

// ---------------------------------------------------------------------------
// sensor.tsc
// ---------------------------------------------------------------------------

describe("sensor.tsc", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(async () => {
    await cleanup(fixture);
  });

  it("passing case: clean compile -> passed=true and zero errors", async () => {
    fixture.runner.enqueue({ exitCode: 0, stdout: "", stderr: "" });
    const wrapped = wrapTool(createTscTool(fixture.runner));

    const result = await wrapped({}, fixture.runtime);

    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(fixture.runner.invocations).toHaveLength(1);
    const call = fixture.runner.invocations[0];
    expect(call.command).toBe("npx");
    expect(call.args).toEqual(["tsc", "--noEmit", "--pretty", "false"]);
    expect(call.cwd).toBe(fixture.runtime.moduleRoot);
  });

  it("failing case: parses tsc diagnostics into structured errors", async () => {
    // Two diagnostics. Note the trailing summary line ("Found 2 errors")
    // that tsc emits — the parser ignores it.
    const stdout = [
      "lib/fanout-stack.ts(10,5): error TS2304: Cannot find name 'foo'.",
      "lib/fanout-stack.ts(42,12): error TS2322: Type 'string' is not assignable to type 'number'.",
      "Found 2 errors in 1 file.",
    ].join("\n");
    fixture.runner.enqueue({ exitCode: 1, stdout, stderr: "" });
    const wrapped = wrapTool(createTscTool(fixture.runner));

    const result = await wrapped({}, fixture.runtime);

    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toEqual({
      file: "lib/fanout-stack.ts",
      line: 10,
      col: 5,
      message: "TS2304: Cannot find name 'foo'.",
    });
    expect(result.errors[1]).toEqual({
      file: "lib/fanout-stack.ts",
      line: 42,
      col: 12,
      message:
        "TS2322: Type 'string' is not assignable to type 'number'.",
    });
  });

  it("non-zero exit with no parseable diagnostics still fails closed", async () => {
    // tsc itself errored (e.g. tsconfig missing). Without parseable
    // diagnostics the `errors` list is empty, but the non-zero exit
    // still trips passed=false so the loop sees a failure.
    fixture.runner.enqueue({
      exitCode: 1,
      stdout: "",
      stderr: "error TS5057: Cannot find a tsconfig.json file.",
    });
    const wrapped = wrapTool(createTscTool(fixture.runner));

    const result = await wrapped({}, fixture.runtime);

    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it("parser unit: ignores summary lines and warnings-style lines", () => {
    const stdout = [
      "Found 0 errors. Watching for file changes.",
      "lib/x.ts(1,1): warning TS6133: 'foo' is declared but never used.",
      "lib/x.ts(2,2): error TS9999: real one.",
    ].join("\n");
    const errors = parseTscOutput(stdout);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      file: "lib/x.ts",
      line: 2,
      col: 2,
      message: "TS9999: real one.",
    });
  });
});

// ---------------------------------------------------------------------------
// sensor.eslint
// ---------------------------------------------------------------------------

describe("sensor.eslint", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(async () => {
    await cleanup(fixture);
  });

  it("passing case: empty JSON array -> passed=true with no findings", async () => {
    fixture.runner.enqueue({ exitCode: 0, stdout: "[]", stderr: "" });
    const wrapped = wrapTool(createEslintTool(fixture.runner));

    const result = await wrapped({}, fixture.runtime);

    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(fixture.runner.invocations).toHaveLength(1);
    const call = fixture.runner.invocations[0];
    expect(call.command).toBe("npx");
    expect(call.args).toEqual(["eslint", ".", "--format", "json"]);
    expect(call.cwd).toBe(fixture.runtime.moduleRoot);
  });

  it("passing case: warning-only findings still pass", async () => {
    // ESLint exits 0 when there are warnings but no errors; the parser
    // surfaces the warnings, the sensor stays passed.
    const stdout = JSON.stringify([
      {
        filePath: "/abs/lib/fanout-stack.ts",
        messages: [
          {
            ruleId: "no-unused-vars",
            severity: 1,
            line: 12,
            message: "'unused' is declared but never used.",
          },
        ],
      },
    ]);
    fixture.runner.enqueue({ exitCode: 0, stdout, stderr: "" });
    const wrapped = wrapTool(createEslintTool(fixture.runner));

    const result = await wrapped({}, fixture.runtime);

    expect(result.passed).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      ruleId: "no-unused-vars",
      severity: "warning",
      line: 12,
    });
  });

  it("failing case: error severity flips passed=false", async () => {
    const stdout = JSON.stringify([
      {
        filePath: "/abs/lib/fanout-stack.ts",
        messages: [
          {
            ruleId: "no-undef",
            severity: 2,
            line: 7,
            message: "'undeclared' is not defined.",
          },
          {
            ruleId: "prefer-const",
            severity: 1,
            line: 3,
            message: "'x' is never reassigned. Use 'const'.",
          },
        ],
      },
      {
        filePath: "/abs/lib/other.ts",
        messages: [],
      },
    ]);
    fixture.runner.enqueue({ exitCode: 1, stdout, stderr: "" });
    const wrapped = wrapTool(createEslintTool(fixture.runner));

    const result = await wrapped({}, fixture.runtime);

    expect(result.passed).toBe(false);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].severity).toBe("error");
    expect(result.findings[1].severity).toBe("warning");
  });

  it("parser unit: maps null ruleId to <parse-error> placeholder", () => {
    const stdout = JSON.stringify([
      {
        filePath: "/abs/lib/x.ts",
        messages: [
          {
            ruleId: null,
            severity: 2,
            line: 1,
            message: "Parsing error: Unexpected token",
          },
        ],
      },
    ]);
    const findings = parseEslintOutput(stdout);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe("<parse-error>");
    expect(findings[0].severity).toBe("error");
  });

  it("parser unit: malformed JSON surfaces a synthetic failing finding", () => {
    const findings = parseEslintOutput("not json {");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].ruleId).toBe("<parse-error>");
  });
});

// ---------------------------------------------------------------------------
// sensor.unitTests
// ---------------------------------------------------------------------------

describe("sensor.unitTests", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(async () => {
    await cleanup(fixture);
  });

  it("passing case: all tests pass -> passed=true with parsed results", async () => {
    const report = {
      success: true,
      testResults: [
        {
          testFilePath: "/abs/test/fanout-stack.test.ts",
          assertionResults: [
            {
              fullName: "FanoutStack creates an SNS topic",
              status: "passed",
              duration: 12,
              failureMessages: [],
            },
            {
              fullName: "FanoutStack encrypts the SQS queue",
              status: "passed",
              duration: 8,
              failureMessages: [],
            },
          ],
        },
      ],
    };
    fixture.runner.enqueue({
      exitCode: 0,
      stdout: JSON.stringify(report),
      stderr: "",
    });
    const wrapped = wrapTool(createUnitTestsTool(fixture.runner));

    const result = await wrapped({}, fixture.runtime);

    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      name: "FanoutStack creates an SNS topic",
      status: "pass",
      durationMs: 12,
    });
    expect(result.results[1].status).toBe("pass");
    // Verify the runner was invoked with --json.
    expect(fixture.runner.invocations).toHaveLength(1);
    const call = fixture.runner.invocations[0];
    expect(call.command).toBe("npx");
    expect(call.args).toEqual(["jest", "--json"]);
    expect(call.cwd).toBe(fixture.runtime.moduleRoot);
  });

  it("failing case: any failed test trips passed=false; failure message captured", async () => {
    const report = {
      success: false,
      testResults: [
        {
          testFilePath: "/abs/test/fanout-stack.test.ts",
          assertionResults: [
            {
              fullName: "FanoutStack encrypts the SQS queue",
              status: "failed",
              duration: 14,
              failureMessages: [
                "Expected SQS queue to have KMS encryption, but found none.",
              ],
            },
            {
              fullName: "FanoutStack creates an SNS topic",
              status: "passed",
              duration: 5,
              failureMessages: [],
            },
            {
              fullName: "FanoutStack supports filter policies",
              status: "skipped",
              duration: null,
              failureMessages: [],
            },
          ],
        },
      ],
    };
    fixture.runner.enqueue({
      exitCode: 1,
      stdout: JSON.stringify(report),
      stderr: "",
    });
    const wrapped = wrapTool(createUnitTestsTool(fixture.runner));

    const result = await wrapped({}, fixture.runtime);

    expect(result.passed).toBe(false);
    expect(result.results).toHaveLength(3);
    expect(result.results[0].status).toBe("fail");
    expect(result.results[0].failureMessage).toContain("KMS encryption");
    expect(result.results[1].status).toBe("pass");
    expect(result.results[2].status).toBe("skip");
    expect(result.results[2].durationMs).toBe(0);
  });

  it("runner crash: non-zero exit with no parseable JSON surfaces synthetic failure", async () => {
    fixture.runner.enqueue({
      exitCode: 1,
      stdout: "",
      stderr: "Cannot find module 'jest-runtime'",
    });
    const wrapped = wrapTool(createUnitTestsTool(fixture.runner));

    const result = await wrapped({}, fixture.runtime);

    expect(result.passed).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      name: "<jest>",
      status: "fail",
    });
    expect(result.results[0].failureMessage).toContain("jest-runtime");
  });

  it("parser unit: maps Jest status vocabulary onto pass/fail/skip", () => {
    const report = {
      testResults: [
        {
          testFilePath: "/abs/x.test.ts",
          assertionResults: [
            { fullName: "a", status: "passed", duration: 1 },
            { fullName: "b", status: "failed", duration: 2, failureMessages: ["nope"] },
            { fullName: "c", status: "pending", duration: 0 },
            { fullName: "d", status: "skipped", duration: 0 },
            { fullName: "e", status: "todo", duration: 0 },
            { fullName: "f", status: "weird-future-status", duration: 0 },
          ],
        },
      ],
    };
    const results = parseJestOutput(JSON.stringify(report));
    expect(results.map((r) => [r.name, r.status])).toEqual([
      ["a", "pass"],
      ["b", "fail"],
      ["c", "skip"],
      ["d", "skip"],
      ["e", "skip"],
      ["f", "skip"],
    ]);
  });

  it("parser unit: builds a name from ancestorTitles when fullName missing", () => {
    const report = {
      testResults: [
        {
          assertionResults: [
            {
              ancestorTitles: ["FanoutStack", "encryption"],
              title: "uses KMS",
              status: "passed",
              duration: 4,
            },
          ],
        },
      ],
    };
    const results = parseJestOutput(JSON.stringify(report));
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("FanoutStack > encryption > uses KMS");
  });

  it("parser unit: malformed JSON surfaces a synthetic failed result", () => {
    const results = parseJestOutput("not json");
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("fail");
    expect(results[0].name).toBe("<jest>");
  });
});
