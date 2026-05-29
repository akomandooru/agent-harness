const mockSend = jest.fn();

jest.mock("@aws-sdk/client-api-gateway", () => ({
  APIGatewayClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  GetApiKeyCommand: jest.fn((input: unknown) => input),
}));

import { runPostDeploy } from "../gates/post-deploy";

describe("runPostDeploy", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({ value: "test-api-key-value" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("passes when no endpoint key is found in stack outputs", async () => {
    const result = await runPostDeploy({
      stackOutputs: { SomeOtherKey: "value" },
    });
    expect(result).toEqual({ passed: true, failures: [] });
  });

  it("passes when stack outputs are empty", async () => {
    const result = await runPostDeploy({ stackOutputs: {} });
    expect(result).toEqual({ passed: true, failures: [] });
  });

  it("passes when endpoint returns 202", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 202,
      statusText: "Accepted",
    });

    const result = await runPostDeploy({
      stackOutputs: { ServiceEndpoint: "https://example.com/api/" },
    });

    expect(result).toEqual({ passed: true, failures: [] });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://example.com/api/messages",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("includes x-api-key header when ApiKeyId is in stack outputs", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 202,
      statusText: "Accepted",
    });

    await runPostDeploy({
      stackOutputs: {
        ServiceEndpoint: "https://example.com/api/",
        ApiKeyId: "key-id-123",
      },
    });

    const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0];
    const headers = fetchCall[1].headers;
    expect(headers["x-api-key"]).toBe("test-api-key-value");
  });

  it("proceeds without api key if retrieval fails", async () => {
    mockSend.mockRejectedValue(new Error("AccessDenied"));
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 403,
      statusText: "Forbidden",
      text: jest.fn().mockResolvedValue("Forbidden"),
    });

    const result = await runPostDeploy({
      stackOutputs: {
        ServiceEndpoint: "https://example.com/api/",
        ApiKeyId: "bad-key-id",
      },
    });

    // Should fail with 403 (no key passed), not throw
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("403");
  });

  it("fails when endpoint returns 500", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 500,
      statusText: "Internal Server Error",
      text: jest.fn().mockResolvedValue("error"),
    });

    const result = await runPostDeploy({
      stackOutputs: { ApiUrl: "https://example.com/health" },
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("500");
  });

  it("fails when endpoint returns 403 (missing api key)", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 403,
      statusText: "Forbidden",
      text: jest.fn().mockResolvedValue("Forbidden"),
    });

    const result = await runPostDeploy({
      stackOutputs: { BaseUrl: "https://example.com/prod" },
    });

    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("403");
  });

  it("captures network errors as failures without throwing", async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await runPostDeploy({
      stackOutputs: { Endpoint: "https://unreachable.local" },
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("Network error");
    expect(result.failures[0]).toContain("ECONNREFUSED");
  });

  it("matches endpoint keys case-insensitively", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      statusText: "OK",
    });

    const result = await runPostDeploy({
      stackOutputs: { serviceendpoint: "https://example.com/" },
    });

    expect(result.passed).toBe(true);
  });

  it("appends /messages to the endpoint URL", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 202,
      statusText: "Accepted",
    });

    await runPostDeploy({
      stackOutputs: { ApiEndpoint: "https://example.com/prod" },
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://example.com/prod/messages",
      expect.anything()
    );
  });

  it("sends a JSON body with a test message", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 202,
      statusText: "Accepted",
    });

    await runPostDeploy({
      stackOutputs: { ApiEndpoint: "https://example.com/prod/" },
    });

    const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.message).toBe("post-deploy-smoke-test");
  });
});
