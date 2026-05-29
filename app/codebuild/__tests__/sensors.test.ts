import { runSensors, SensorsGateResult } from "../gates/sensors";
import * as exec from "../exec";

jest.mock("../exec");
const mockExecWithTimeout = exec.execWithTimeout as jest.MockedFunction<
  typeof exec.execWithTimeout
>;

describe("runSensors", () => {
  const moduleRoot = "/tmp/test-module";

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("returns passed: true when all sensors exit 0", async () => {
    mockExecWithTimeout.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const result = await runSensors({ moduleRoot });

    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(4);
    expect(result.results.every((r) => r.passed)).toBe(true);
    expect(result.results.every((r) => r.findings.length === 0)).toBe(true);
  });

  it("returns passed: false when any sensor exits non-zero", async () => {
    mockExecWithTimeout
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: "src/index.ts:1:1 error\n",
        stderr: "",
        exitCode: 1,
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

    const result = await runSensors({ moduleRoot });

    expect(result.passed).toBe(false);
    expect(result.results[1].passed).toBe(false);
    expect(result.results[1].findings).toContain("src/index.ts:1:1 error");
  });

  it("parses non-zero exit output into findings array", async () => {
    mockExecWithTimeout.mockResolvedValue({
      stdout: "error TS2304: Cannot find name 'foo'\nerror TS2304: Cannot find name 'bar'\n",
      stderr: "",
      exitCode: 2,
    });

    const result = await runSensors({ moduleRoot });

    const tscResult = result.results[0];
    expect(tscResult.findings).toContain("error TS2304: Cannot find name 'foo'");
    expect(tscResult.findings).toContain("error TS2304: Cannot find name 'bar'");
  });

  it("reports timeout finding when exitCode is -1", async () => {
    mockExecWithTimeout.mockResolvedValue({
      stdout: "",
      stderr: "\n[Process timed out]",
      exitCode: -1,
    });

    const result = await runSensors({ moduleRoot, timeout: 120_000 });

    const tscResult = result.results[0];
    expect(tscResult.passed).toBe(false);
    expect(tscResult.exitCode).toBe(-1);
    expect(tscResult.findings).toContain("Sensor timed out after 120000ms");
  });

  it("uses default timeout of 120000ms", async () => {
    mockExecWithTimeout.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    await runSensors({ moduleRoot });

    expect(mockExecWithTimeout).toHaveBeenCalledWith(
      "npx",
      ["tsc", "--noEmit"],
      { cwd: moduleRoot, timeout: 120_000 }
    );
  });

  it("uses custom timeout when provided", async () => {
    mockExecWithTimeout.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    await runSensors({ moduleRoot, timeout: 60_000 });

    expect(mockExecWithTimeout).toHaveBeenCalledWith(
      "npx",
      ["tsc", "--noEmit"],
      { cwd: moduleRoot, timeout: 60_000 }
    );
  });

  it("runs all four sensors: tsc, eslint, jest, cdk-nag", async () => {
    mockExecWithTimeout.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const result = await runSensors({ moduleRoot });

    expect(result.results.map((r) => r.name)).toEqual([
      "tsc",
      "eslint",
      "jest",
      "cdk-nag",
    ]);
  });

  it("invokes sensors with npx prefix", async () => {
    mockExecWithTimeout.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    await runSensors({ moduleRoot });

    const calls = mockExecWithTimeout.mock.calls;
    expect(calls[0]).toEqual(["npx", ["tsc", "--noEmit"], { cwd: moduleRoot, timeout: 120_000 }]);
    expect(calls[1]).toEqual(["npx", ["eslint", "."], { cwd: moduleRoot, timeout: 120_000 }]);
    expect(calls[2]).toEqual(["npx", ["jest", "--ci"], { cwd: moduleRoot, timeout: 120_000 }]);
    expect(calls[3]).toEqual(["npx", ["cdk-nag"], { cwd: moduleRoot, timeout: 120_000 }]);
  });

  it("captures stdout and stderr in result", async () => {
    mockExecWithTimeout.mockResolvedValue({
      stdout: "All tests passed",
      stderr: "Debugger attached",
      exitCode: 0,
    });

    const result = await runSensors({ moduleRoot });

    expect(result.results[0].stdout).toBe("All tests passed");
    expect(result.results[0].stderr).toBe("Debugger attached");
  });
});
