/**
 * Computational sensor wrappers for the editor agent.
 *
 * Implements the four `sensor.*` tools from `design.md`'s editor catalogue:
 *
 *   - `sensor.cdkNag`    `{}` -> CdkNagOutput
 *   - `sensor.tsc`       `{}` -> TscOutput
 *   - `sensor.eslint`    `{}` -> EslintOutput
 *   - `sensor.unitTests` `{}` -> UnitTestsOutput
 *
 * Each sensor wrapper invokes its underlying CLI inside the module root
 * (`WrapperRuntime.moduleRoot`), captures the output, parses it into the
 * typed contract from `design.md` "Sensor output contracts", and returns
 * `passed: boolean` plus per-sensor structured details. The shared
 * `passed` shape is what makes the loop's gate logic uniform: the editor
 * checks the same field whichever sensor it ran.
 *
 * Runner injection: every sensor accepts an optional `SensorRunner` via
 * its factory (`createCdkNagTool(runner)`, etc.). The default runner
 * shells out via `child_process.spawn`, mirroring the pattern from
 * `cdk.ts`. Tests pass a stub runner so they can run without a real CDK,
 * tsc, ESLint, or Jest installation.
 *
 * `passed` semantics:
 *   - `sensor.cdkNag`:    no findings of severity `"error"`. Warning-only
 *                         findings still pass; the design treats cdk-nag
 *                         warnings as informational.
 *   - `sensor.tsc`:       zero parsed errors. tsc emits no warnings under
 *                         `--noEmit`, so any output line that parses as
 *                         an error fails the sensor.
 *   - `sensor.eslint`:    no findings of severity `"error"`. Warnings
 *                         don't fail the sensor; this matches ESLint's
 *                         own exit-code semantics (exits non-zero only
 *                         on errors by default).
 *   - `sensor.unitTests`: no test result has `status: "fail"`. Skipped
 *                         tests don't fail the sensor.
 *
 * Cost: every sensor declares `costCategory: "none"`. These are local
 * computational checks; no token spend, no AWS deploy. The wrapper layer
 * still records each invocation in the session log (the wrapper logs all
 * calls regardless of cost category).
 *
 * Output-format contracts:
 *
 *   - `cdk-nag` findings appear as CDK Annotations in `cdk synth` output.
 *     Format observed across cdk-nag 2.x:
 *       [<Severity> at <resourcePath>] <RuleId>[<details>]: <message>
 *     where `<Severity>` is `Error` or `Warning`. `<details>` is optional
 *     (some rules emit it, e.g. `IAM5[Resource::...]`); the parser ignores
 *     the details and uses `<RuleId>` (e.g. `AwsSolutions-IAM5`) as the
 *     finding's `ruleId`.
 *
 *   - `tsc --noEmit --pretty false` emits one diagnostic per line:
 *       <relativePath>(<line>,<col>): error TS<code>: <message>
 *     The parser captures `<relativePath>`, `<line>`, `<col>`, and the
 *     full diagnostic message (including the `TS<code>` prefix so the
 *     agent sees which rule fired).
 *
 *   - `eslint --format json` writes a JSON array to stdout. Each element
 *     is a file result with `messages[]` containing `{ ruleId, severity,
 *     line, message }`. ESLint maps `severity: 1 -> "warning"`, `2 ->
 *     "error"`. Findings with `ruleId: null` (e.g. parse errors) are
 *     reported with `ruleId: "<parse-error>"` so the agent has a stable
 *     identifier for the finding.
 *
 *   - Jest's `--json` output has `testResults[]` (per file), each with
 *     `assertionResults[]` (per test) carrying `{ fullName, status,
 *     duration, failureMessages[] }`. The parser maps Jest's status
 *     vocabulary onto the design's `pass | fail | skip` triple:
 *       passed                            -> "pass"
 *       failed                            -> "fail"
 *       pending | skipped | todo | <other>-> "skip"
 *     Duration falls back to 0 when Jest doesn't report it (rare but
 *     possible for skipped tests).
 *
 * Runner-output buffering matches `cdk.ts`'s 16 MiB cap: ESLint and
 * Jest can produce large JSON payloads on big modules, but 16 MiB
 * comfortably covers the reference module and well beyond. Output past
 * the cap is truncated and a marker line appended; the parser is
 * resilient to truncation (best-effort: malformed JSON falls back to
 * `passed: false` with a synthetic error finding).
 */

import { spawn } from "node:child_process";

import type {
  CostCategory,
  ToolDefinition,
} from "@agent-harness/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** All sensors are local checks with no token or deploy cost. */
const NONE_CATEGORY: CostCategory = "none";

/**
 * Output buffer cap for sensor runners. Matches `cdk.ts`'s cap so the
 * memory budget for any one tool invocation is uniform across the editor's
 * tool catalogue.
 */
const MAX_SENSOR_OUTPUT_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Runner abstraction
// ---------------------------------------------------------------------------

/**
 * Result of one sensor CLI invocation. The runner returns this even on
 * non-zero exit; sensors that need to distinguish "tool ran and found
 * problems" from "tool itself failed" inspect `exitCode` directly.
 */
export interface SensorRunResult {
  /** Exit code reported by the underlying CLI. `0` means success. */
  readonly exitCode: number;
  /** Captured stdout. UTF-8. May be empty. */
  readonly stdout: string;
  /** Captured stderr. UTF-8. May be empty. */
  readonly stderr: string;
}

/**
 * Abstract sensor runner. The default implementation shells out via
 * `child_process.spawn`; tests inject a stub.
 *
 * Implementations MUST resolve (not reject) on non-zero exit codes; the
 * caller inspects `exitCode` to decide what to do. Implementations MAY
 * reject only when the CLI cannot be launched at all (binary not found,
 * spawn error). The wrapper layer treats those as handler errors via the
 * standard `HandlerError` path.
 */
export interface SensorRunner {
  run(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string }
  ): Promise<SensorRunResult>;
}

/**
 * Default sensor runner. Spawns the requested CLI with `shell: true` so
 * Windows resolves `.cmd` shims (npx.cmd, eslint.cmd, jest.cmd) the same
 * way Unix resolves the bare names from PATH.
 */
export const defaultSensorRunner: SensorRunner = {
  async run(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string }
  ): Promise<SensorRunResult> {
    return new Promise<SensorRunResult>((resolveRun, rejectRun) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        shell: true,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutTruncated = false;
      let stderrTruncated = false;

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdoutBytes >= MAX_SENSOR_OUTPUT_BYTES) {
          stdoutTruncated = true;
          return;
        }
        const remaining = MAX_SENSOR_OUTPUT_BYTES - stdoutBytes;
        if (chunk.byteLength > remaining) {
          stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes += remaining;
          stdoutTruncated = true;
        } else {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.byteLength;
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBytes >= MAX_SENSOR_OUTPUT_BYTES) {
          stderrTruncated = true;
          return;
        }
        const remaining = MAX_SENSOR_OUTPUT_BYTES - stderrBytes;
        if (chunk.byteLength > remaining) {
          stderrChunks.push(chunk.subarray(0, remaining));
          stderrBytes += remaining;
          stderrTruncated = true;
        } else {
          stderrChunks.push(chunk);
          stderrBytes += chunk.byteLength;
        }
      });

      child.on("error", (err) => rejectRun(err));
      child.on("close", (exitCode) => {
        const stdout =
          Buffer.concat(stdoutChunks).toString("utf8") +
          (stdoutTruncated ? "\n[truncated: stdout exceeded cap]" : "");
        const stderr =
          Buffer.concat(stderrChunks).toString("utf8") +
          (stderrTruncated ? "\n[truncated: stderr exceeded cap]" : "");
        resolveRun({
          exitCode: typeof exitCode === "number" ? exitCode : 1,
          stdout,
          stderr,
        });
      });
    });
  },
};

// ---------------------------------------------------------------------------
// sensor.cdkNag
// ---------------------------------------------------------------------------

/**
 * One cdk-nag finding from the design's `CdkNagOutput` contract.
 *
 * `severity` is the design's `"error" | "warning"` triple, mapped from
 * cdk-nag's annotation kind: `[Error at ...]` -> `"error"`,
 * `[Warning at ...]` -> `"warning"`. `[Info at ...]` annotations are
 * dropped (informational, not actionable for the loop).
 */
interface CdkNagFinding {
  readonly resourceId: string;
  readonly ruleId: string;
  readonly message: string;
  readonly severity: "error" | "warning";
}

interface CdkNagInput {
  // Empty by design.
}

interface CdkNagOutput {
  readonly passed: boolean;
  readonly findings: CdkNagFinding[];
}

/**
 * Regex for one cdk-nag annotation line.
 *
 * Matches the format documented at the top of this file:
 *   [<Severity> at <resourcePath>] <RuleId>[<details>]: <message>
 *
 * The optional `[<details>]` block after `<RuleId>` is consumed but not
 * captured (the rule id alone is what the loop and the agent reason
 * about; the details are inside `<message>` if needed).
 *
 * `<RuleId>` is restricted to non-`[`, non-`]`, non-`:` characters to
 * stop the parser eating an inadvertently-formatted message that happens
 * to contain a colon.
 */
const CDK_NAG_LINE_RE =
  /^\[(Error|Warning) at ([^\]]+)\]\s+([^\[\]:]+?)(?:\[[^\]]*\])?:\s+(.*)$/;

/** Parse cdk-nag findings from `cdk synth` combined stdout+stderr. */
export function parseCdkNagOutput(combinedOutput: string): CdkNagFinding[] {
  const findings: CdkNagFinding[] = [];
  for (const rawLine of combinedOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || !line.startsWith("[")) continue;
    const match = CDK_NAG_LINE_RE.exec(line);
    if (!match) continue;
    const [, severityWord, resourceId, ruleId, message] = match;
    findings.push({
      resourceId,
      ruleId: ruleId.trim(),
      message: message.trim(),
      severity: severityWord === "Error" ? "error" : "warning",
    });
  }
  return findings;
}

/**
 * Build a `sensor.cdkNag` tool bound to the given runner. The exported
 * `cdkNagTool` uses the default runner; tests inject a stub.
 *
 * The sensor invokes `npx cdk synth --strict --no-color` from the module
 * root. cdk-nag is wired into the CDK app via aspects (see
 * `modules/fanout/bin/fanout.ts`); when the app synthesises, cdk-nag
 * emits its findings as CDK Annotations, which `cdk synth` prints to
 * stderr (and sometimes stdout, depending on CDK version). The parser
 * reads both streams for resilience.
 *
 * `--strict` causes `cdk synth` to fail on warnings as well as errors,
 * giving cdk-nag's warning annotations exit-code visibility. The parser
 * doesn't rely on the exit code to decide `passed`; it counts errors
 * directly so the contract stays under our control regardless of CDK
 * CLI version.
 */
export function createCdkNagTool(
  runner: SensorRunner = defaultSensorRunner
): ToolDefinition<CdkNagInput, CdkNagOutput> {
  return {
    name: "sensor.cdkNag",
    description:
      "Run cdk-nag against the module's CDK app via `cdk synth` and " +
      "return parsed findings.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        passed: { type: "boolean" },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              resourceId: { type: "string" },
              ruleId: { type: "string" },
              message: { type: "string" },
              severity: { type: "string", enum: ["error", "warning"] },
            },
            required: ["resourceId", "ruleId", "message", "severity"],
            additionalProperties: false,
          },
        },
      },
      required: ["passed", "findings"],
      additionalProperties: false,
    },
    costCategory: NONE_CATEGORY,
    handler: async (_input, ctx) => {
      const moduleRoot = ctx.resolvedModuleRoot as string;
      const result = await runner.run(
        "npx",
        ["cdk", "synth", "--strict", "--no-color"],
        { cwd: moduleRoot }
      );
      // cdk-nag annotations land on stderr in modern CDK; older versions
      // may put them on stdout. Read both for resilience.
      const combined = `${result.stdout}\n${result.stderr}`;
      const findings = parseCdkNagOutput(combined);
      const passed = findings.every((f) => f.severity !== "error");
      return { output: { passed, findings } };
    },
  };
}

/** Default-runner-bound `sensor.cdkNag` tool. */
export const cdkNagTool = createCdkNagTool();

// ---------------------------------------------------------------------------
// sensor.tsc
// ---------------------------------------------------------------------------

interface TscError {
  readonly file: string;
  readonly line: number;
  readonly col: number;
  readonly message: string;
}

interface TscInput {
  // Empty by design.
}

interface TscOutput {
  readonly passed: boolean;
  readonly errors: TscError[];
}

/**
 * Regex for one `tsc` diagnostic line under `--pretty false`.
 *
 *   <relativePath>(<line>,<col>): error TS<code>: <message>
 *
 * `<relativePath>` may contain spaces, dots, slashes, or backslashes. The
 * parser anchors on the closing `)` followed by a colon and the
 * `error TS<digits>:` marker so a stray colon in a path doesn't confuse
 * it. The `TS<code>` prefix is captured into `errorCode` so it can be
 * folded back into the `message` string the parser surfaces.
 */
const TSC_LINE_RE =
  /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s*(.*)$/;

/** Parse tsc errors from `tsc --noEmit --pretty false` stdout. */
export function parseTscOutput(stdout: string): TscError[] {
  const errors: TscError[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = TSC_LINE_RE.exec(line);
    if (!match) continue;
    const [, file, lineStr, colStr, errorCode, message] = match;
    errors.push({
      file: file.trim(),
      line: Number(lineStr),
      col: Number(colStr),
      // Surface the code with the message so the agent sees which
      // diagnostic fired without us teasing the code out separately.
      message: `${errorCode}: ${message.trim()}`,
    });
  }
  return errors;
}

/**
 * Build a `sensor.tsc` tool bound to the given runner. The exported
 * `tscTool` uses the default runner.
 *
 * Invokes `npx tsc --noEmit --pretty false` in the module root.
 * `--noEmit` keeps the type checker from writing artefacts (the sensor
 * is a check, not a build step); `--pretty false` produces the stable,
 * line-per-diagnostic format the parser expects.
 *
 * `passed = true` iff zero diagnostics parsed. tsc also emits non-error
 * lines (file count summaries, etc.) that the regex skips, so a clean
 * compile parses to an empty error list and a non-clean compile parses
 * to a non-empty list. tsc's exit code mirrors this (zero on clean,
 * non-zero on diagnostics), but the parser drives the contract so we
 * don't depend on a specific tsc version's exit semantics.
 */
export function createTscTool(
  runner: SensorRunner = defaultSensorRunner
): ToolDefinition<TscInput, TscOutput> {
  return {
    name: "sensor.tsc",
    description:
      "Run `tsc --noEmit` against the module and return parsed type errors.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        passed: { type: "boolean" },
        errors: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              line: { type: "number" },
              col: { type: "number" },
              message: { type: "string" },
            },
            required: ["file", "line", "col", "message"],
            additionalProperties: false,
          },
        },
      },
      required: ["passed", "errors"],
      additionalProperties: false,
    },
    costCategory: NONE_CATEGORY,
    handler: async (_input, ctx) => {
      const moduleRoot = ctx.resolvedModuleRoot as string;
      const result = await runner.run(
        "npx",
        ["tsc", "--noEmit", "--pretty", "false"],
        { cwd: moduleRoot }
      );
      // tsc writes diagnostics to stdout. stderr may carry tooling
      // problems (missing config, etc.); fold both into the parser so
      // a config-level failure still surfaces something.
      const combined = `${result.stdout}\n${result.stderr}`;
      const errors = parseTscOutput(combined);
      const passed = errors.length === 0 && result.exitCode === 0;
      return { output: { passed, errors } };
    },
  };
}

/** Default-runner-bound `sensor.tsc` tool. */
export const tscTool = createTscTool();

// ---------------------------------------------------------------------------
// sensor.eslint
// ---------------------------------------------------------------------------

interface EslintFinding {
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
  readonly message: string;
  readonly severity: "error" | "warning";
}

interface EslintInput {
  // Empty by design.
}

interface EslintOutput {
  readonly passed: boolean;
  readonly findings: EslintFinding[];
}

/**
 * Shape of one entry in `eslint --format json` output.
 *
 * Only the fields the parser uses are typed here; the upstream format
 * has more fields (source, fixableErrorCount, etc.) but we don't need
 * them and don't want to over-specify.
 */
interface EslintJsonResult {
  readonly filePath?: string;
  readonly messages?: readonly EslintJsonMessage[];
}

interface EslintJsonMessage {
  readonly ruleId?: string | null;
  readonly severity?: number;
  readonly line?: number;
  readonly message?: string;
}

/** Parse ESLint's `--format json` stdout into structured findings. */
export function parseEslintOutput(stdout: string): EslintFinding[] {
  // ESLint emits a JSON array even when there are zero findings (`[]`).
  // If parsing fails (truncated output, ESLint crash mid-stream, etc.),
  // surface a synthetic error finding so the loop sees a failed sensor
  // rather than a silent pass.
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return [
      {
        file: "<eslint>",
        line: 0,
        ruleId: "<parse-error>",
        message:
          "eslint --format json produced output that did not parse as JSON",
        severity: "error",
      },
    ];
  }
  if (!Array.isArray(parsed)) return [];
  const findings: EslintFinding[] = [];
  for (const entry of parsed as readonly EslintJsonResult[]) {
    if (!entry || typeof entry !== "object") continue;
    const filePath = typeof entry.filePath === "string" ? entry.filePath : "";
    const messages = Array.isArray(entry.messages) ? entry.messages : [];
    for (const m of messages) {
      if (!m || typeof m !== "object") continue;
      const severity = mapEslintSeverity(m.severity);
      // Ignore severity 0 (off / informational).
      if (severity === undefined) continue;
      findings.push({
        file: filePath,
        line: typeof m.line === "number" ? m.line : 0,
        ruleId:
          typeof m.ruleId === "string" && m.ruleId.length > 0
            ? m.ruleId
            : "<parse-error>",
        message: typeof m.message === "string" ? m.message : "",
        severity,
      });
    }
  }
  return findings;
}

/**
 * Map ESLint's numeric `severity` to the design's string vocabulary.
 *   0 -> off (skip)
 *   1 -> "warning"
 *   2 -> "error"
 * Any other value (defensive) is treated as "error" so a malformed
 * report doesn't silently pass.
 */
function mapEslintSeverity(
  severity: number | undefined
): "error" | "warning" | undefined {
  if (severity === 0) return undefined;
  if (severity === 1) return "warning";
  return "error";
}

/**
 * Build a `sensor.eslint` tool bound to the given runner.
 *
 * Invokes `npx eslint . --format json` in the module root. ESLint exits
 * non-zero when there are findings of severity `error`; the parser
 * counts errors directly so the sensor's `passed` field doesn't depend
 * on exit semantics.
 *
 * `passed = true` iff no finding has `severity: "error"`. Warnings do
 * not fail the sensor (matches ESLint's default exit-code policy).
 */
export function createEslintTool(
  runner: SensorRunner = defaultSensorRunner
): ToolDefinition<EslintInput, EslintOutput> {
  return {
    name: "sensor.eslint",
    description:
      "Run `eslint .` against the module and return parsed findings.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        passed: { type: "boolean" },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              line: { type: "number" },
              ruleId: { type: "string" },
              message: { type: "string" },
              severity: { type: "string", enum: ["error", "warning"] },
            },
            required: ["file", "line", "ruleId", "message", "severity"],
            additionalProperties: false,
          },
        },
      },
      required: ["passed", "findings"],
      additionalProperties: false,
    },
    costCategory: NONE_CATEGORY,
    handler: async (_input, ctx) => {
      const moduleRoot = ctx.resolvedModuleRoot as string;
      const result = await runner.run(
        "npx",
        ["eslint", ".", "--format", "json"],
        { cwd: moduleRoot }
      );
      const findings = parseEslintOutput(result.stdout);
      const passed = findings.every((f) => f.severity !== "error");
      return { output: { passed, findings } };
    },
  };
}

/** Default-runner-bound `sensor.eslint` tool. */
export const eslintTool = createEslintTool();

// ---------------------------------------------------------------------------
// sensor.unitTests
// ---------------------------------------------------------------------------

interface UnitTestResult {
  readonly name: string;
  readonly status: "pass" | "fail" | "skip";
  readonly durationMs: number;
  readonly failureMessage?: string;
}

interface UnitTestsInput {
  // Empty by design.
}

interface UnitTestsOutput {
  readonly passed: boolean;
  readonly results: UnitTestResult[];
}

/**
 * Subset of Jest's `--json` output the parser depends on.
 *
 * Jest emits more fields than this (numFailedTests, snapshot, coverageMap,
 * etc.); we only type what we read so the parser doesn't break when Jest
 * adds or renames adjacent fields.
 */
interface JestJsonReport {
  readonly success?: boolean;
  readonly testResults?: readonly JestFileResult[];
}

interface JestFileResult {
  readonly testFilePath?: string;
  readonly assertionResults?: readonly JestAssertionResult[];
}

interface JestAssertionResult {
  readonly title?: string;
  readonly fullName?: string;
  readonly ancestorTitles?: readonly string[];
  readonly status?: string;
  readonly duration?: number | null;
  readonly failureMessages?: readonly string[];
}

/** Parse Jest's `--json` stdout into structured per-test results. */
export function parseJestOutput(stdout: string): UnitTestResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    // Same fallback as ESLint: surface a synthetic failed test so the
    // loop sees the sensor as failing.
    return [
      {
        name: "<jest>",
        status: "fail",
        durationMs: 0,
        failureMessage:
          "jest --json produced output that did not parse as JSON",
      },
    ];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const report = parsed as JestJsonReport;
  const fileResults = Array.isArray(report.testResults)
    ? report.testResults
    : [];
  const results: UnitTestResult[] = [];
  for (const fileResult of fileResults) {
    if (!fileResult || typeof fileResult !== "object") continue;
    const assertions = Array.isArray(fileResult.assertionResults)
      ? fileResult.assertionResults
      : [];
    for (const a of assertions) {
      if (!a || typeof a !== "object") continue;
      const status = mapJestStatus(a.status);
      const name = buildJestTestName(a);
      const failureMessage =
        status === "fail" ? joinFailureMessages(a.failureMessages) : undefined;
      results.push({
        name,
        status,
        durationMs:
          typeof a.duration === "number" && Number.isFinite(a.duration)
            ? a.duration
            : 0,
        ...(failureMessage !== undefined ? { failureMessage } : {}),
      });
    }
  }
  return results;
}

/**
 * Map Jest's status vocabulary onto the design's three-state contract.
 *   passed                                   -> "pass"
 *   failed                                   -> "fail"
 *   pending | skipped | todo | disabled | ?  -> "skip"
 *
 * The default branch (any unrecognised status) maps to `"skip"` because
 * the design treats unknowns as non-failures: a passed sensor isn't the
 * loop's concern, only a failed one. If a Jest version starts reporting
 * an unrecognised failure-equivalent status, we'll pick it up via the
 * agent integration tests.
 */
function mapJestStatus(status: string | undefined): "pass" | "fail" | "skip" {
  switch (status) {
    case "passed":
      return "pass";
    case "failed":
      return "fail";
    default:
      return "skip";
  }
}

/**
 * Build a stable, human-readable test name from a Jest assertion result.
 *
 * Prefer `fullName` (which already includes ancestor describe titles). If
 * absent (older Jest, custom reporter), fall back to joining
 * `ancestorTitles` and `title`.
 */
function buildJestTestName(a: JestAssertionResult): string {
  if (typeof a.fullName === "string" && a.fullName.length > 0) {
    return a.fullName;
  }
  const parts: string[] = [];
  if (Array.isArray(a.ancestorTitles)) {
    for (const t of a.ancestorTitles) {
      if (typeof t === "string" && t.length > 0) parts.push(t);
    }
  }
  if (typeof a.title === "string" && a.title.length > 0) parts.push(a.title);
  return parts.length > 0 ? parts.join(" > ") : "<unnamed>";
}

/** Concatenate Jest's failure-message array into one string for the contract. */
function joinFailureMessages(
  messages: readonly string[] | undefined
): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  return messages.join("\n");
}

/**
 * Build a `sensor.unitTests` tool bound to the given runner.
 *
 * Invokes `npx jest --json` in the module root. Jest exits non-zero when
 * any test fails or when the runner itself fails (config errors, etc.).
 * The parser drives the `passed` field directly off the per-test status
 * triple so a non-zero exit with no parsed results (a runner crash)
 * still produces a failing sensor with a synthetic result.
 */
export function createUnitTestsTool(
  runner: SensorRunner = defaultSensorRunner
): ToolDefinition<UnitTestsInput, UnitTestsOutput> {
  return {
    name: "sensor.unitTests",
    description:
      "Run the module's Jest test suite and return parsed per-test results.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        passed: { type: "boolean" },
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              status: { type: "string", enum: ["pass", "fail", "skip"] },
              durationMs: { type: "number" },
              failureMessage: { type: "string" },
            },
            required: ["name", "status", "durationMs"],
            additionalProperties: false,
          },
        },
      },
      required: ["passed", "results"],
      additionalProperties: false,
    },
    costCategory: NONE_CATEGORY,
    handler: async (_input, ctx) => {
      const moduleRoot = ctx.resolvedModuleRoot as string;
      const result = await runner.run("npx", ["jest", "--json"], {
        cwd: moduleRoot,
      });
      // When stdout is empty (Jest crashed before writing anything),
      // skip the parser's JSON-error fallback (which would surface a
      // generic "did not parse as JSON" message) and use stderr
      // directly. The agent reads the failure message; an actionable
      // stderr beats a generic parser message.
      const trimmedStdout = result.stdout.trim();
      let results: UnitTestResult[] =
        trimmedStdout === "" ? [] : parseJestOutput(result.stdout);
      // Jest exited non-zero but produced no parseable results: surface
      // a synthetic failure so the sensor reports failure rather than
      // a silent pass.
      if (results.length === 0 && result.exitCode !== 0) {
        const stderr = result.stderr.trim();
        results = [
          {
            name: "<jest>",
            status: "fail",
            durationMs: 0,
            failureMessage:
              stderr.length > 0
                ? stderr
                : `jest exited with code ${result.exitCode}`,
          },
        ];
      }
      const passed = results.every((r) => r.status !== "fail");
      return { output: { passed, results } };
    },
  };
}

/** Default-runner-bound `sensor.unitTests` tool. */
export const unitTestsTool = createUnitTestsTool();
