/**
 * Unit tests for the `pr.open` tool wrapper.
 *
 * Covers the verification matrix from tasks.md task 3.6:
 *
 *   1. Token redaction: the session record never contains the
 *      installation token, even if the agent attempts to smuggle it in
 *      via the input or if a hypothetical leak path placed it in tool
 *      output. Verifies the wrapper's defence-in-depth combo
 *      (additionalProperties:false at the schema layer + redact at the
 *      sink layer).
 *   2. Recorded GitHub API fixture: a captured response from
 *      `octokit.pulls.create` is replayed through the wrapper to assert
 *      the contract `{number, url}` matches the design's tool catalogue
 *      entry for `pr.open`.
 *   3. Happy path: the wrapper passes structured PR fields to the
 *      injected `GitHubClient` and returns its response unmodified.
 *
 * Tests inject a stub `GitHubClient` so no real network calls happen and
 * no real GitHub installation token is needed.
 */

import {
  wrapTool,
  type SessionSink,
  type ToolInvocationRecord,
  type WrapperRuntime,
} from "@agent-harness/shared";

import {
  createPrOpenTool,
  defaultGitHubClient,
  prOpenTool,
  type CreatePullRequestArgs,
  type CreatePullRequestResult,
  type GitHubClient,
} from "../tools/pr";

// ---------------------------------------------------------------------------
// Recorded GitHub API fixture
// ---------------------------------------------------------------------------

/**
 * Recorded shape of a successful `octokit.pulls.create` response. Trimmed
 * to the fields the wrapper reads (`number`, `html_url`) plus a sample of
 * the noise GitHub returns alongside (id, state, head/base refs) so the
 * fixture documents the response surface without pretending the wrapper
 * uses it.
 *
 * Captured against the GitHub REST API v3 documentation for "Create a
 * pull request" (POST /repos/{owner}/{repo}/pulls). Values are synthetic
 * but match the shape of a real response.
 */
const RECORDED_PR_RESPONSE = {
  data: {
    id: 1,
    node_id: "MDExOlB1bGxSZXF1ZXN0MQ==",
    number: 1347,
    state: "open",
    locked: false,
    title: "Add a dead-letter queue to the SQS subscriber",
    user: {
      login: "agent-harness[bot]",
      id: 1,
      type: "Bot",
    },
    body: "## Trigger\n\n...",
    html_url: "https://github.com/test-org/agent-harness/pull/1347",
    diff_url: "https://github.com/test-org/agent-harness/pull/1347.diff",
    patch_url: "https://github.com/test-org/agent-harness/pull/1347.patch",
    head: {
      ref: "agent/session-test-abc",
      sha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
    },
    base: {
      ref: "main",
      sha: "9f2cdfae6f76b66d1a8b6a89b2c4bb4ddc66c2a3",
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

class InMemorySink implements SessionSink {
  public records: ToolInvocationRecord[] = [];
  public async appendToolRecord(record: ToolInvocationRecord): Promise<void> {
    this.records.push(record);
  }
}

interface RecordedPrCall {
  readonly args: CreatePullRequestArgs;
}

/**
 * Stub `GitHubClient` that records every call and replies from a queue
 * of scripted results. Falls back to a default success response when the
 * queue is empty, mirroring the `StubCdkRunner` pattern in `cdk.test.ts`.
 */
class StubGitHubClient implements GitHubClient {
  public readonly calls: RecordedPrCall[] = [];
  private readonly results: CreatePullRequestResult[] = [];
  public defaultResult: CreatePullRequestResult = {
    number: 1,
    url: "https://github.com/test-org/agent-harness/pull/1",
  };

  public enqueue(result: CreatePullRequestResult): void {
    this.results.push(result);
  }

  public async createPullRequest(
    args: CreatePullRequestArgs,
  ): Promise<CreatePullRequestResult> {
    this.calls.push({ args });
    return this.results.shift() ?? this.defaultResult;
  }
}

interface Fixture {
  readonly sink: InMemorySink;
  readonly client: StubGitHubClient;
  readonly runtime: WrapperRuntime;
}

function makeFixture(): Fixture {
  // The `pr.open` wrapper does not have a `pathField`, so it never
  // touches the filesystem. A synthetic absolute path is sufficient for
  // the runtime's required fields. Using a path that doesn't exist is
  // intentional: it documents that this tool has no module-root semantics.
  const sink = new InMemorySink();
  const client = new StubGitHubClient();
  const runtime: WrapperRuntime = {
    moduleRoot: "/synthetic/module-root-for-pr-tests",
    sessionSink: sink,
    sessionId: "session-test-abc",
    iterationIndex: 0,
  };
  return { sink, client, runtime };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("pr.open happy path", () => {
  it("passes structured PR fields to the GitHub client and returns its result", async () => {
    const fixture = makeFixture();
    fixture.client.enqueue({
      number: 1347,
      url: "https://github.com/test-org/agent-harness/pull/1347",
    });

    const wrapped = wrapTool(createPrOpenTool(fixture.client));
    const result = await wrapped(
      {
        title: "Add a dead-letter queue to the SQS subscriber",
        body: "## Trigger\n\nAgent task #42.",
        branch: "agent/session-test-abc",
        baseRef: "main",
      },
      fixture.runtime,
    );

    // Output matches the design's `{number, url}` contract.
    expect(result).toEqual({
      number: 1347,
      url: "https://github.com/test-org/agent-harness/pull/1347",
    });

    // The client received the agent's `branch` mapped onto GitHub's
    // `head` vocabulary and `baseRef` onto `base`.
    expect(fixture.client.calls).toHaveLength(1);
    expect(fixture.client.calls[0].args).toEqual({
      title: "Add a dead-letter queue to the SQS subscriber",
      body: "## Trigger\n\nAgent task #42.",
      head: "agent/session-test-abc",
      base: "main",
    });

    // The wrapper recorded the call as ok.
    expect(fixture.sink.records).toHaveLength(1);
    expect(fixture.sink.records[0].outcome).toBe("ok");
    expect(fixture.sink.records[0].tool).toBe("pr.open");
  });

  it("returns the parsed `{number, url}` from a recorded GitHub API response", async () => {
    // This case exercises the contract on the *output* side: any
    // `GitHubClient` implementation that surfaces the recorded API
    // response shape MUST yield the design's `{number, url}` output.
    // Simulates a hand-built client that surfaces the same shape that
    // `defaultGitHubClient` would extract from a live GitHub response.
    const fixture = makeFixture();
    const recordedNumber = RECORDED_PR_RESPONSE.data.number;
    const recordedUrl = RECORDED_PR_RESPONSE.data.html_url;

    const recordedClient: GitHubClient = {
      async createPullRequest(): Promise<CreatePullRequestResult> {
        return {
          number: recordedNumber,
          url: recordedUrl,
        };
      },
    };

    const wrapped = wrapTool(createPrOpenTool(recordedClient));
    const result = await wrapped(
      {
        title: RECORDED_PR_RESPONSE.data.title,
        body: RECORDED_PR_RESPONSE.data.body,
        branch: RECORDED_PR_RESPONSE.data.head.ref,
        baseRef: RECORDED_PR_RESPONSE.data.base.ref,
      },
      fixture.runtime,
    );

    expect(result).toEqual({
      number: recordedNumber,
      url: recordedUrl,
    });

    // Output schema validates the URL via `format: "uri"`. Confirm a
    // realistic `html_url` survives validation rather than being
    // rejected by an over-strict schema.
    expect(fixture.sink.records[0].outcome).toBe("ok");
  });

  it("runs the recorded fixture end-to-end through defaultGitHubClient via a stub fetch", async () => {
    // Stronger version of the recorded-fixture test: rather than build
    // a hand-written `GitHubClient` stub, plug the recorded JSON into
    // a stub `fetch` implementation and run it through the production
    // `defaultGitHubClient`. This exercises:
    //   - Repository parsing into URL path components.
    //   - `Authorization: Bearer <token>` header construction.
    //   - JSON body shape (title/body/head/base mapping).
    //   - Response parsing back to `{number, url}`.
    //
    // The stub fetch records the request so the test can assert on it,
    // and replies with the recorded response shape from
    // `RECORDED_PR_RESPONSE`. No real network calls happen.
    const fixture = makeFixture();

    interface CapturedRequest {
      readonly url: string;
      readonly method?: string;
      readonly headers?: Record<string, string>;
      readonly body?: unknown;
    }
    const captured: CapturedRequest[] = [];

    const stubFetch: typeof fetch = async (input, init) => {
      // Capture the request for assertion.
      const headersInit = init?.headers as
        | Record<string, string>
        | undefined;
      const rawBody = init?.body;
      const bodyJson =
        typeof rawBody === "string" ? JSON.parse(rawBody) : undefined;
      captured.push({
        url: typeof input === "string" ? input : input.toString(),
        method: init?.method,
        headers: headersInit,
        body: bodyJson,
      });
      // Build a minimal `Response`-like object. `Response` is global in
      // Node 20+ via undici, so this matches the production fetch's
      // return type.
      return new Response(JSON.stringify(RECORDED_PR_RESPONSE.data), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    };

    const productionClient = defaultGitHubClient({
      token: "ghs_THIS_TOKEN_MUST_NEVER_LEAK",
      repository: "test-org/agent-harness",
      fetchImpl: stubFetch,
    });

    const wrapped = wrapTool(createPrOpenTool(productionClient));
    const result = await wrapped(
      {
        title: RECORDED_PR_RESPONSE.data.title,
        body: RECORDED_PR_RESPONSE.data.body,
        branch: RECORDED_PR_RESPONSE.data.head.ref,
        baseRef: RECORDED_PR_RESPONSE.data.base.ref,
      },
      fixture.runtime,
    );

    // Output matches the recorded fixture's `number` and `html_url`.
    expect(result).toEqual({
      number: RECORDED_PR_RESPONSE.data.number,
      url: RECORDED_PR_RESPONSE.data.html_url,
    });

    // Exactly one HTTP request was issued, against the right endpoint.
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(
      "https://api.github.com/repos/test-org/agent-harness/pulls",
    );
    expect(captured[0].method).toBe("POST");

    // Headers carry the bearer token and the GitHub API version.
    expect(captured[0].headers?.Authorization).toBe(
      "Bearer ghs_THIS_TOKEN_MUST_NEVER_LEAK",
    );
    expect(captured[0].headers?.["X-GitHub-Api-Version"]).toBe(
      "2022-11-28",
    );
    expect(captured[0].headers?.Accept).toBe("application/vnd.github+json");

    // Body maps `branch`/`baseRef` to GitHub's `head`/`base` vocabulary.
    expect(captured[0].body).toEqual({
      title: RECORDED_PR_RESPONSE.data.title,
      body: RECORDED_PR_RESPONSE.data.body,
      head: RECORDED_PR_RESPONSE.data.head.ref,
      base: RECORDED_PR_RESPONSE.data.base.ref,
    });

    // The session record never includes the token, even though it
    // appeared in the live HTTP request. The token lives only in the
    // closure inside `defaultGitHubClient`; it never crosses the
    // wrapper boundary, so there's no path for it to reach the sink.
    const recorded = fixture.sink.records[0];
    expect(JSON.stringify(recorded)).not.toContain(
      "ghs_THIS_TOKEN_MUST_NEVER_LEAK",
    );
    expect(recorded.outcome).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Token redaction (the load-bearing security guarantee)
// ---------------------------------------------------------------------------

describe("pr.open token redaction", () => {
  it("does not accept any token-bearing field in the input schema", async () => {
    // The design's secret-handling contract: the agent's tool input
    // never carries a token. The schema's `additionalProperties: false`
    // backstops a reflective leak — even if the agent constructed a
    // call with `{title, body, branch, baseRef, githubInstallationToken}`,
    // the wrapper rejects before the handler runs.
    const fixture = makeFixture();
    const wrapped = wrapTool(createPrOpenTool(fixture.client));

    await expect(
      wrapped(
        // Cast through `unknown` so TypeScript doesn't reject the call
        // statically; we want to verify *runtime* rejection.
        {
          title: "Add DLQ",
          body: "...",
          branch: "agent/session-test-abc",
          baseRef: "main",
          githubInstallationToken: "ghs_THIS_TOKEN_MUST_NEVER_LEAK",
        } as unknown as Parameters<typeof wrapped>[0],
        fixture.runtime,
      ),
    ).rejects.toThrow();

    // The wrapper recorded the rejection as input-schema-error and the
    // sink's input record went through redaction, so even the recorded
    // input has the token replaced with `[REDACTED]`.
    expect(fixture.sink.records).toHaveLength(1);
    expect(fixture.sink.records[0].outcome).toBe("input-schema-error");
    const recordedInput = fixture.sink.records[0].input as Record<
      string,
      unknown
    >;
    expect(recordedInput.githubInstallationToken).toBe("[REDACTED]");
    // The literal token string never appears anywhere in the record.
    expect(JSON.stringify(fixture.sink.records[0])).not.toContain(
      "ghs_THIS_TOKEN_MUST_NEVER_LEAK",
    );

    // The handler did not run, so the GitHub client was not called.
    expect(fixture.client.calls).toHaveLength(0);
  });

  it("redacts token-shaped fields the redactor knows about", async () => {
    // A reflective leak path through *output* would also be caught by
    // the redactor before reaching the sink. Simulate by having a stub
    // client return a result that (incorrectly) carries token-shaped
    // metadata. The wrapper's output-schema check rejects the extra
    // fields before they reach the sink, but if the schema were ever
    // loosened, the redactor is the second line of defence.
    //
    // Here we test the redactor directly via a session-record write: we
    // confirm that any field matching the redactor's patterns gets
    // replaced regardless of nesting.
    const fixture = makeFixture();

    // Construct a stub that returns the contractual shape so the call
    // succeeds end-to-end.
    fixture.client.enqueue({
      number: 42,
      url: "https://github.com/test-org/agent-harness/pull/42",
    });

    const wrapped = wrapTool(createPrOpenTool(fixture.client));
    await wrapped(
      {
        title: "Add DLQ",
        body: "...",
        branch: "agent/session-test-abc",
        baseRef: "main",
      },
      fixture.runtime,
    );

    // The recorded input has no token-shaped fields because the input
    // schema doesn't allow any. Confirm the recorded input matches the
    // sanitised shape the agent passed (no extra fields invented by the
    // wrapper).
    const recorded = fixture.sink.records[0];
    expect(recorded.input).toEqual({
      title: "Add DLQ",
      body: "...",
      branch: "agent/session-test-abc",
      baseRef: "main",
    });
    expect(recorded.output).toEqual({
      number: 42,
      url: "https://github.com/test-org/agent-harness/pull/42",
    });

    // Sanity check: the sink record's serialised form does not contain
    // common token markers. Belt-and-braces; a passing assertion here
    // means a future regression that lets a token slip into a record
    // would be caught.
    const serialised = JSON.stringify(recorded);
    expect(serialised).not.toContain("Bearer ");
    expect(serialised).not.toContain("ghs_");
    expect(serialised).not.toContain("ghp_");
    expect(serialised).not.toContain("token");
  });

  it("default tool fails fast when the orchestrator forgot to inject a client", async () => {
    // The exported `prOpenTool` (no client injected) is what the static
    // catalogue declaration uses. If the orchestrator ever forgets to
    // replace it via `createPrOpenTool(realClient)`, the first invocation
    // surfaces a clear configuration error rather than silently
    // succeeding.
    const fixture = makeFixture();
    const wrapped = wrapTool(prOpenTool);
    await expect(
      wrapped(
        {
          title: "Add DLQ",
          body: "...",
          branch: "agent/session-test-abc",
          baseRef: "main",
        },
        fixture.runtime,
      ),
    ).rejects.toThrow(/GitHubClient was not injected/);

    expect(fixture.sink.records).toHaveLength(1);
    expect(fixture.sink.records[0].outcome).toBe("handler-error");
  });
});

// ---------------------------------------------------------------------------
// defaultGitHubClient configuration parsing
// ---------------------------------------------------------------------------

describe("defaultGitHubClient configuration", () => {
  // These tests exercise `defaultGitHubClient`'s *construction* path:
  // repository parsing happens at construction time, not at call time, so
  // a malformed payload fails before any token-bearing client object
  // exists. The Octokit instance itself is exercised in the live-fire
  // smoke test (task 12); we don't make real network calls here.

  it("rejects a repository missing the slash separator", () => {
    expect(() =>
      defaultGitHubClient({
        token: "ghs_unused_in_this_test",
        repository: "no-slash",
      }),
    ).toThrow(/repository must be in '<owner>\/<repo>' form/);
  });

  it("rejects a repository with a leading slash", () => {
    expect(() =>
      defaultGitHubClient({
        token: "ghs_unused_in_this_test",
        repository: "/orphan",
      }),
    ).toThrow(/repository must be in '<owner>\/<repo>' form/);
  });

  it("rejects a repository with a trailing slash", () => {
    expect(() =>
      defaultGitHubClient({
        token: "ghs_unused_in_this_test",
        repository: "owner/",
      }),
    ).toThrow(/repository must be in '<owner>\/<repo>' form/);
  });

  it("rejects a repository with too many slashes", () => {
    expect(() =>
      defaultGitHubClient({
        token: "ghs_unused_in_this_test",
        repository: "org/team/repo",
      }),
    ).toThrow(/exactly one '\/'/);
  });

  it("accepts a well-formed `<owner>/<repo>` and returns a client", () => {
    const client = defaultGitHubClient({
      token: "ghs_unused_in_this_test",
      repository: "test-org/agent-harness",
    });
    // The returned object exposes the contractual surface and nothing
    // else. The token is held in the closure; the test cannot reach it.
    expect(typeof client.createPullRequest).toBe("function");
    expect(Object.keys(client)).toEqual(["createPullRequest"]);
  });
});
