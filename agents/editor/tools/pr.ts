/**
 * PR-creation wrapper for the editor agent.
 *
 * Implements the final tool from `design.md`'s editor catalogue:
 *
 *   - `pr.open` `{title, body, branch, baseRef}` -> `{number, url}`
 *
 * The tool opens a pull request on the originating GitHub repository. It
 * is the *only* path the editor agent has to GitHub: the IAM model and the
 * tool catalogue forbid every other GitHub interaction (no merge, no
 * branch protection bypass, no settings changes; see Requirements 2.3 and
 * 9.3).
 *
 * Token handling (the load-bearing security note)
 * -----------------------------------------------
 * The trigger payload carries a short-lived `auth.githubInstallationToken`
 * (1 hour, scoped to PR creation on the originating repo; see `design.md`
 * "Trigger payload" and "Security Considerations"). The token MUST NOT
 * appear:
 *
 *   1. In the agent's view of the tool's input schema. The agent never
 *      sees the token; it cannot pass it back; it cannot leak it through a
 *      reflective request like "echo my context."
 *   2. In any session record. The shared `redact` layer covers
 *      `*Token`/`*token` field names (see `agents/shared/src/redact.ts`),
 *      so even if the token ever crossed the wrapper boundary as part of
 *      an input or output, it would be replaced with `[REDACTED]` before
 *      reaching the sink.
 *   3. In any log line, error message, or thrown exception body. Errors
 *      from the GitHub REST API are reformatted before they bubble out:
 *      response bodies are discarded and only the HTTP status code is
 *      surfaced, so a misconfigured token never prints itself to the
 *      session record.
 *
 * The wrapper achieves (1) by *not accepting the token in the tool input*.
 * Instead, the orchestrator builds a `GitHubClient` once per session,
 * closing over the session's installation token *and* the originating
 * repository, and injects it via `createPrOpenTool(client)`. The client's
 * `createPullRequest` method takes only the structured PR fields; the
 * token and the owner/repo never leave the closure.
 *
 * This is the same runner-injection pattern used in `cdk.ts` (CDK CLI
 * runner) and `preview.ts` (CloudWatch SDK clients): the public surface
 * is an interface, the production implementation is `defaultGitHubClient`,
 * and tests pass a stub.
 *
 * Public surface
 * --------------
 * Exports:
 *   - `GitHubClient` interface with one method (`createPullRequest`).
 *   - `createPrOpenTool(client?)` factory returning a `ToolDefinition`.
 *   - `prOpenTool` — the default-bound tool definition. The default client
 *     throws on use because the orchestrator must inject a real client
 *     bound to the session's installation token and repository before the
 *     tool can run. This shape lets the catalogue declaration be static
 *     (Requirement 9.4 — declarative tool registration) while keeping the
 *     secret out of the static surface.
 *   - `defaultGitHubClient(args)` — production factory using the
 *     runtime's built-in `fetch` against the GitHub REST API. Accepts
 *     the token and the `<org>/<repo>` string from the trigger payload's
 *     `module.repository`.
 *
 * Cost accounting
 * ---------------
 * `pr.open` declares `costCategory: "none"`. PR creation is one GitHub API
 * call; it does not consume model tokens or AWS infra spend. A forker who
 * wants to track per-trigger PR-creation cost (rare) can subclass and add
 * a cost report in the handler.
 */

import type { CostCategory, ToolDefinition } from "@agent-harness/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Read-only sensor-class category: no tokens, no AWS deploy charge. */
const NONE_CATEGORY: CostCategory = "none";

// ---------------------------------------------------------------------------
// Placeholder client (used by the default-bound tool)
// ---------------------------------------------------------------------------

/**
 * Placeholder client used by the default-bound `prOpenTool`. Every call
 * throws so a misconfigured orchestrator (one that registered the static
 * tool without injecting a session-bound client) fails on the first PR
 * attempt with a message pointing at the configuration error.
 *
 * Declared above `createPrOpenTool` to avoid a temporal-dead-zone error
 * when `prOpenTool` is initialised at module load.
 */
const throwingPlaceholderClient: GitHubClient = {
  async createPullRequest(): Promise<CreatePullRequestResult> {
    throw new Error(
      "pr.open: GitHubClient was not injected. The orchestrator must " +
        "build a session-bound client via defaultGitHubClient({ token, " +
        "repository }) and register the tool via createPrOpenTool(client).",
    );
  },
};

// ---------------------------------------------------------------------------
// Public client interface
// ---------------------------------------------------------------------------

/**
 * Arguments accepted by `GitHubClient.createPullRequest`.
 *
 * Note what is NOT here: no `owner`, no `repo`, no `token`. The client is
 * constructed bound to a single repository and a single installation
 * token; PR creation calls only need the structured PR fields. This is
 * the design's secret-handling guarantee in code — the token never
 * appears in any method signature.
 */
export interface CreatePullRequestArgs {
  /** PR title. */
  readonly title: string;
  /** PR body. May contain markdown. */
  readonly body: string;
  /**
   * Source branch for the PR (the branch the agent pushed its changes
   * to). GitHub calls this `head` in its API; the parameter name here
   * follows GitHub's vocabulary so a reader of the GitHub REST API docs
   * sees the same names.
   */
  readonly head: string;
  /** Base ref the PR targets (typically `main`). */
  readonly base: string;
}

/** Response from `GitHubClient.createPullRequest`. Matches the tool's output. */
export interface CreatePullRequestResult {
  /** PR number assigned by GitHub. */
  readonly number: number;
  /** PR URL. The `html_url` from the GitHub API, suitable for humans. */
  readonly url: string;
}

/**
 * The minimal GitHub surface the wrapper needs.
 *
 * Defined as an interface (not a class) so:
 *   - The wrapper does not leak any HTTP-client type into the public
 *     surface. A forker who wants to swap in a different GitHub client
 *     (a fetch-based one — which `defaultGitHubClient` already is — or
 *     an SDK-based one, or a recorded fixture) only needs to implement
 *     `createPullRequest`.
 *   - Tests can pass a stub object literal without depending on any
 *     HTTP client implementation.
 *   - The token is held inside the implementation's closure rather than
 *     being part of any method signature, so it cannot accidentally leak
 *     through error messages, argument logging, or reflective inspection
 *     of the call.
 */
export interface GitHubClient {
  createPullRequest(
    args: CreatePullRequestArgs,
  ): Promise<CreatePullRequestResult>;
}

// ---------------------------------------------------------------------------
// Default client (production)
// ---------------------------------------------------------------------------

/** Configuration for `defaultGitHubClient`. */
export interface DefaultGitHubClientArgs {
  /**
   * Short-lived GitHub installation token from the trigger payload's
   * `auth.githubInstallationToken`. Held inside the returned client's
   * closure and never exposed via any method.
   */
  readonly token: string;
  /**
   * `<org>/<repo>` from the trigger payload's `module.repository`. Parsed
   * once at construction time; the resulting `owner` and `repo` are held
   * in the closure for every PR-creation call this client services.
   */
  readonly repository: string;
  /**
   * Optional `fetch` implementation override. Defaults to `globalThis.fetch`
   * (available natively in Node 20+). Tests rarely need to set this
   * because they pass a stub `GitHubClient` to `createPrOpenTool`
   * directly; the override exists for forkers running on older runtimes
   * or behind a custom HTTP layer.
   */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Build a production `GitHubClient` backed by the GitHub REST API via
 * the runtime's built-in `fetch`.
 *
 * Why `fetch` and not `@octokit/rest`: PR creation is one POST request
 * to a stable REST endpoint. Adding the Octokit dependency tree (and the
 * ESM/CJS interop friction it brings to a CJS Jest harness) buys nothing
 * for this single call. Node 20+ has `fetch` built in; the implementation
 * stays on the standard library.
 *
 * The orchestrator calls this once per session, after extracting the
 * installation token from the trigger payload. The returned client is
 * then passed to `createPrOpenTool(client)`. The token never leaves the
 * closure created here; nor does the parsed `owner`/`repo`.
 *
 * Error handling: HTTP errors are reformatted into a generic message
 * before they bubble out, on the assumption that the GitHub response
 * body or the request URL might echo something token-shaped. Status code
 * is enough for the agent and the human reviewer to triage.
 *
 * Network injection: the `fetch` implementation can be overridden via
 * `args.fetchImpl`. The default is `globalThis.fetch`. Tests that need
 * to exercise the production code path (rare) inject their own; in
 * normal use, tests pass a `GitHubClient` stub directly to
 * `createPrOpenTool` and never construct a real `defaultGitHubClient`.
 */
export function defaultGitHubClient(
  args: DefaultGitHubClientArgs,
): GitHubClient {
  const { owner, repo } = parseRepository(args.repository);
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "pr.open: no fetch implementation available. Node 20+ provides one " +
        "globally; older runtimes must pass `fetchImpl` explicitly.",
    );
  }
  // Capture the token in the closure. Do not re-read it from `args` later;
  // the closure is the single point of secret holding.
  const authHeader = `Bearer ${args.token}`;
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;

  return {
    async createPullRequest(
      callArgs: CreatePullRequestArgs,
    ): Promise<CreatePullRequestResult> {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            Authorization: authHeader,
            "Content-Type": "application/json",
            "User-Agent": "agent-harness/pr.open",
          },
          body: JSON.stringify({
            title: callArgs.title,
            body: callArgs.body,
            head: callArgs.head,
            base: callArgs.base,
          }),
        });
      } catch (err) {
        // Network-level failure (DNS, TLS, connection reset). The
        // request never reached GitHub. Reformat without echoing the
        // underlying error message because some fetch implementations
        // include the URL in the message and we don't want to surface
        // the URL repeatedly across the session log.
        throw redactGitHubError(err);
      }
      if (!response.ok) {
        throw redactHttpError(response.status);
      }
      // Read and parse the JSON body. Use `unknown` and then narrow so
      // a malformed response surfaces as a typed mismatch rather than a
      // silent NaN.
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new Error(
          `pr.open: GitHub API returned status ${response.status} ` +
            `but the body was not valid JSON`,
        );
      }
      const number = readNumber(parsed, "number");
      const htmlUrl = readString(parsed, "html_url");
      if (number === undefined || htmlUrl === undefined) {
        throw new Error(
          `pr.open: GitHub API response missing required fields ` +
            `('number' and/or 'html_url')`,
        );
      }
      return { number, url: htmlUrl };
    },
  };
}

/**
 * Build a `pr.open` tool definition bound to the given GitHub client.
 *
 * Pass a real `defaultGitHubClient(...)` for production; pass a stub for
 * tests. If `client` is omitted, the returned tool throws on every call
 * with a clear message, so a misconfigured orchestrator surfaces the
 * problem at the first PR-creation attempt rather than at the GitHub API.
 */
export function createPrOpenTool(
  client?: GitHubClient,
): ToolDefinition<PrOpenInput, PrOpenOutput> {
  const resolvedClient = client ?? throwingPlaceholderClient;
  return {
    name: "pr.open",
    description:
      "Open a pull request on the originating repository. Uses the " +
      "session's short-lived GitHub installation token (held in the " +
      "client closure, never in tool input).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1 },
        body: { type: "string" },
        branch: { type: "string", minLength: 1 },
        baseRef: { type: "string", minLength: 1 },
      },
      required: ["title", "body", "branch", "baseRef"],
      // Critical: `additionalProperties: false` prevents the agent from
      // smuggling extra fields (a `token`, a `repository`, etc.) into the
      // wrapper's session-recorded input. Combined with the redaction
      // layer in the shared wrapper, this is the second line of defence
      // against secret leakage through the input channel.
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        number: { type: "integer", minimum: 1 },
        url: { type: "string", format: "uri" },
      },
      required: ["number", "url"],
      additionalProperties: false,
    },
    costCategory: NONE_CATEGORY,
    handler: async (input) => {
      // Owner/repo and token live inside the injected client's closure.
      // The handler maps the tool's input schema (`branch`, `baseRef`)
      // onto the GitHub API's vocabulary (`head`, `base`) and otherwise
      // does nothing.
      const result = await resolvedClient.createPullRequest({
        title: input.title,
        body: input.body,
        head: input.branch,
        base: input.baseRef,
      });
      return { output: { number: result.number, url: result.url } };
    },
  };
}

/**
 * Default-bound `pr.open` tool. The orchestrator MUST replace the client
 * before the tool can run by calling `createPrOpenTool(realClient)` and
 * registering the returned definition.
 *
 * The exported `prOpenTool` exists so the catalogue declaration is static
 * (Requirement 9.4: tool registration is declarative). Calling the
 * default tool fails fast with a clear message rather than silently
 * succeeding without a real GitHub call.
 */
export const prOpenTool = createPrOpenTool();

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PrOpenInput {
  readonly title: string;
  readonly body: string;
  readonly branch: string;
  readonly baseRef: string;
}

interface PrOpenOutput {
  readonly number: number;
  readonly url: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split `<org>/<repo>` into its components. Rejects malformed inputs
 * loudly so a misconfigured trigger payload doesn't lead to a confusing
 * GitHub API error later.
 */
function parseRepository(repository: string): {
  readonly owner: string;
  readonly repo: string;
} {
  const slash = repository.indexOf("/");
  if (slash <= 0 || slash === repository.length - 1) {
    throw new Error(
      `pr.open: repository must be in '<owner>/<repo>' form, got: ${JSON.stringify(repository)}`,
    );
  }
  // Reject repository strings with extra slashes (e.g. `org/team/repo`)
  // — GitHub repos are flat under their owner, so anything else is a
  // malformed payload.
  if (repository.indexOf("/", slash + 1) !== -1) {
    throw new Error(
      `pr.open: repository must contain exactly one '/', got: ${JSON.stringify(repository)}`,
    );
  }
  return {
    owner: repository.slice(0, slash),
    repo: repository.slice(slash + 1),
  };
}

/**
 * Reformat an error from `fetch` (network-level failure) into a generic
 * shape that does not include the original message. Some fetch
 * implementations include the URL in the error message; we don't want
 * to surface the URL (which is constructed from owner/repo) repeatedly
 * across the session log, and we definitely don't want to risk echoing
 * any header value that an exotic fetch implementation might attach.
 */
function redactGitHubError(_err: unknown): Error {
  return new Error("pr.open: GitHub API request failed (network-level)");
}

/**
 * Reformat a non-2xx HTTP response into a generic error. The status
 * code is enough for triage; the response body is discarded because
 * GitHub's error responses can echo request fields and we want a stable
 * shape for the session log.
 */
function redactHttpError(status: number): Error {
  return new Error(`pr.open: GitHub API error (status ${status})`);
}

/** Safely read a string field from a JSON-shaped object. */
function readString(obj: unknown, key: string): string | undefined {
  if (obj === null || typeof obj !== "object") return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** Safely read a number field from a JSON-shaped object. */
function readNumber(obj: unknown, key: string): number | undefined {
  if (obj === null || typeof obj !== "object") return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
