import { openPr, OpenPrOptions } from "../gates/pr";

const defaultOptions: OpenPrOptions = {
  repo: "org/my-repo",
  featureBranch: "agent-harness/abc123",
  baseBranch: "main",
  title: "Agent edits for session abc123",
  body: "## Summary\nAutomated changes",
  token: "ghs_test_token_123",
};

describe("openPr", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns prNumber and url on 201 response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 201,
      json: async () => ({ number: 42, html_url: "https://github.com/org/my-repo/pull/42" }),
    });

    const result = await openPr(defaultOptions);

    expect(result).toEqual({
      prNumber: 42,
      url: "https://github.com/org/my-repo/pull/42",
    });
  });

  it("calls GitHub API with correct URL and headers", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      status: 201,
      json: async () => ({ number: 1, html_url: "https://github.com/org/my-repo/pull/1" }),
    });
    global.fetch = mockFetch;

    await openPr(defaultOptions);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/org/my-repo/pulls",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "token ghs_test_token_123",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        }),
      })
    );
  });

  it("sends correct body with head and base branches", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      status: 201,
      json: async () => ({ number: 1, html_url: "https://github.com/org/my-repo/pull/1" }),
    });
    global.fetch = mockFetch;

    await openPr(defaultOptions);

    const callArgs = mockFetch.mock.calls[0][1] as { body: string };
    const body = JSON.parse(callArgs.body);
    expect(body).toEqual({
      title: "Agent edits for session abc123",
      body: "## Summary\nAutomated changes",
      head: "agent-harness/abc123",
      base: "main",
    });
  });

  it("throws with GitHub error message on non-201 JSON response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 422,
      text: async () => JSON.stringify({ message: "Validation Failed" }),
    });

    await expect(openPr(defaultOptions)).rejects.toThrow(
      "GitHub API error (422): Validation Failed"
    );
  });

  it("throws with raw text on non-201 non-JSON response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 500,
      text: async () => "Internal Server Error",
    });

    await expect(openPr(defaultOptions)).rejects.toThrow(
      "GitHub API error (500): Internal Server Error"
    );
  });

  it("throws on 403 forbidden", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 403,
      text: async () => JSON.stringify({ message: "Resource not accessible by integration" }),
    });

    await expect(openPr(defaultOptions)).rejects.toThrow(
      "GitHub API error (403): Resource not accessible by integration"
    );
  });
});
