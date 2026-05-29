import { parseCdkOutputs, runDeploy } from "../gates/deploy";
import { execWithTimeout } from "../exec";
import { readFile } from "node:fs/promises";

jest.mock("../exec");
jest.mock("node:fs/promises");

const mockExecWithTimeout = execWithTimeout as jest.MockedFunction<typeof execWithTimeout>;
const mockReadFile = readFile as jest.MockedFunction<typeof readFile>;

describe("parseCdkOutputs", () => {
  it("flattens single stack outputs", () => {
    const json = JSON.stringify({
      MyStack: { ApiUrl: "https://example.com", BucketName: "my-bucket" },
    });
    expect(parseCdkOutputs(json)).toEqual({
      ApiUrl: "https://example.com",
      BucketName: "my-bucket",
    });
  });

  it("flattens multiple stack outputs", () => {
    const json = JSON.stringify({
      StackA: { KeyA: "valueA" },
      StackB: { KeyB: "valueB", KeyC: "valueC" },
    });
    expect(parseCdkOutputs(json)).toEqual({
      KeyA: "valueA",
      KeyB: "valueB",
      KeyC: "valueC",
    });
  });

  it("returns empty record for empty stacks object", () => {
    expect(parseCdkOutputs("{}")).toEqual({});
  });

  it("handles stack with no outputs", () => {
    const json = JSON.stringify({ EmptyStack: {} });
    expect(parseCdkOutputs(json)).toEqual({});
  });
});

describe("runDeploy", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("returns success with stack outputs on exit code 0", async () => {
    mockExecWithTimeout.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    mockReadFile.mockResolvedValue(
      JSON.stringify({ MyStack: { Endpoint: "https://api.example.com" } })
    );

    const result = await runDeploy({ moduleRoot: "/project/modules/fanout" });

    expect(result).toEqual({
      success: true,
      stackOutputs: { Endpoint: "https://api.example.com" },
    });
    expect(mockExecWithTimeout).toHaveBeenCalledWith(
      "npx",
      ["cdk", "deploy", "--require-approval", "never", "--outputs-file", "cdk-outputs.json"],
      { cwd: "/project/modules/fanout", timeout: 300_000 }
    );
  });

  it("returns failure with error on non-zero exit code", async () => {
    mockExecWithTimeout.mockResolvedValue({
      stdout: "",
      stderr: "Stack failed: CREATE_FAILED",
      exitCode: 1,
    });

    const result = await runDeploy({ moduleRoot: "/project" });

    expect(result).toEqual({
      success: false,
      stackOutputs: {},
      error: "Stack failed: CREATE_FAILED",
    });
  });

  it("falls back to stdout when stderr is empty on failure", async () => {
    mockExecWithTimeout.mockResolvedValue({
      stdout: "Some error in stdout",
      stderr: "",
      exitCode: 1,
    });

    const result = await runDeploy({ moduleRoot: "/project" });

    expect(result.error).toBe("Some error in stdout");
  });

  it("uses custom timeout when provided", async () => {
    mockExecWithTimeout.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    mockReadFile.mockResolvedValue("{}");

    await runDeploy({ moduleRoot: "/project", timeout: 600_000 });

    expect(mockExecWithTimeout).toHaveBeenCalledWith(
      "npx",
      expect.any(Array),
      expect.objectContaining({ timeout: 600_000 })
    );
  });

  it("returns success with empty outputs if outputs file cannot be read", async () => {
    mockExecWithTimeout.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    const result = await runDeploy({ moduleRoot: "/project" });

    expect(result).toEqual({ success: true, stackOutputs: {} });
  });
});
