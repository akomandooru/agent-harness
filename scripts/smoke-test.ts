#!/usr/bin/env ts-node
/**
 * smoke-test.ts — End-to-end smoke test for the agent-harness template.
 *
 * Exercises the full flow:
 *   1. Creates a GitHub issue titled "[smoke-test] <ISO timestamp>" with the
 *      `agent-task` label on the fanout module path.
 *   2. Polls for the `dispatch-agent-task.yml` workflow run to start.
 *   3. Polls for a PR referencing the issue to be opened.
 *   4. Prints a structured summary and exits 0 on pass, non-zero on fail.
 *   5. Closes the smoke-test issue on both pass and fail.
 *      The PR (if opened) is left open for manual review.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
 *
 * Usage
 * -----
 *   npx ts-node scripts/smoke-test.ts
 *
 * Options
 *   --workflow-poll-interval <seconds>   How often to poll for the workflow run (default: 30)
 *   --workflow-timeout       <seconds>   Max wait for workflow run to start (default: 600)
 *   --pr-poll-interval       <seconds>   How often to poll for a PR (default: 60)
 *   --pr-timeout             <seconds>   Max wait for a PR to open (default: 5400)
 *   --token                  <token>     GitHub token (default: GITHUB_TOKEN env var)
 *   --dry-run                            Create the issue but skip polling (for testing)
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

interface HarnessConfig {
  module: {
    path: string;
  };
  orchestrator: {
    apiGatewayEndpoint: string;
  };
}

// ---------------------------------------------------------------------------
// GitHub API types
// ---------------------------------------------------------------------------

interface GitHubIssue {
  number: number;
  html_url: string;
  node_id: string;
}

interface GitHubWorkflowRun {
  id: number;
  html_url: string;
  status: string;
  conclusion: string | null;
  name: string;
  created_at: string;
}

interface GitHubWorkflowRunsResponse {
  total_count: number;
  workflow_runs: GitHubWorkflowRun[];
}

interface GitHubPullRequest {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: string;
}

interface GitHubPullRequestsResponse {
  items: GitHubPullRequest[];
  total_count: number;
}

// ---------------------------------------------------------------------------
// Structured summary
// ---------------------------------------------------------------------------

interface SmokeSummary {
  issueNumber: number;
  issueUrl: string;
  workflowRunUrl: string | null;
  prNumber: number | null;
  prUrl: string | null;
  elapsedMs: number;
  verdict: "pass" | "fail";
  failureReason?: string;
  lastPolledStatus?: string;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export function loadConfig(): HarnessConfig {
  const configPath = path.resolve(__dirname, "..", "agent-harness.config.json");
  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw) as HarnessConfig;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export interface SmokeTestOptions {
  workflowPollIntervalMs: number;
  workflowTimeoutMs: number;
  prPollIntervalMs: number;
  prTimeoutMs: number;
  token: string;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): SmokeTestOptions {
  const args = argv.slice(2);

  let workflowPollInterval = 30;
  let workflowTimeout = 600;
  let prPollInterval = 60;
  let prTimeout = 5400;
  let token = process.env["GITHUB_TOKEN"] ?? "";
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];

    switch (arg) {
      case "--workflow-poll-interval":
        if (next !== undefined) {
          workflowPollInterval = parseInt(next, 10);
          i++;
        }
        break;
      case "--workflow-timeout":
        if (next !== undefined) {
          workflowTimeout = parseInt(next, 10);
          i++;
        }
        break;
      case "--pr-poll-interval":
        if (next !== undefined) {
          prPollInterval = parseInt(next, 10);
          i++;
        }
        break;
      case "--pr-timeout":
        if (next !== undefined) {
          prTimeout = parseInt(next, 10);
          i++;
        }
        break;
      case "--token":
        if (next !== undefined) {
          token = next;
          i++;
        }
        break;
      case "--dry-run":
        dryRun = true;
        break;
    }
  }

  return {
    workflowPollIntervalMs: workflowPollInterval * 1000,
    workflowTimeoutMs: workflowTimeout * 1000,
    prPollIntervalMs: prPollInterval * 1000,
    prTimeoutMs: prTimeout * 1000,
    token,
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// Structured summary formatting
// ---------------------------------------------------------------------------

export function formatSummary(summary: SmokeSummary): string {
  const elapsed = (summary.elapsedMs / 1000).toFixed(1);
  const lines: string[] = [
    "=== Smoke Test Summary ===",
    `Verdict:          ${summary.verdict.toUpperCase()}`,
    `Issue:            #${summary.issueNumber} (${summary.issueUrl})`,
    `Workflow run URL: ${summary.workflowRunUrl ?? "(not started)"}`,
    `PR number:        ${summary.prNumber !== null ? `#${summary.prNumber}` : "null"}`,
    `PR URL:           ${summary.prUrl ?? "null"}`,
    `Elapsed:          ${elapsed}s`,
  ];

  if (summary.failureReason !== undefined) {
    lines.push(`Failure reason:   ${summary.failureReason}`);
  }

  if (summary.lastPolledStatus !== undefined) {
    lines.push(`Last status:      ${summary.lastPolledStatus}`);
  }

  lines.push("==========================");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// GitHub REST API helpers
// ---------------------------------------------------------------------------

async function githubFetch(
  url: string,
  token: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agent-harness-smoke-test",
    ...(options.headers as Record<string, string> | undefined),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  return response;
}

export async function createIssue(
  owner: string,
  repo: string,
  token: string,
  modulePath: string
): Promise<GitHubIssue> {
  const timestamp = new Date().toISOString();
  const title = `[smoke-test] ${timestamp}`;

  // Build an issue body that matches the dispatch workflow's expected format
  // (the workflow parses "### Target module path" and "### Change description")
  const body = [
    "### Target module path",
    "",
    modulePath,
    "",
    "### Change description",
    "",
    "Automated smoke test — verify end-to-end wiring of the agent-harness template.",
    "",
    "### Acceptance criteria",
    "",
    "The agent opens a pull request with at least one file change in the target module.",
  ].join("\n");

  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/issues`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        body,
        labels: ["agent-task"],
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to create issue: HTTP ${response.status} — ${text}`
    );
  }

  return (await response.json()) as GitHubIssue;
}

export async function closeIssue(
  owner: string,
  repo: string,
  token: string,
  issueNumber: number
): Promise<void> {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
    token,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "closed", state_reason: "completed" }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    // Log but don't throw — closing the issue is best-effort
    console.error(
      `Warning: failed to close issue #${issueNumber}: HTTP ${response.status} — ${text}`
    );
  }
}

export async function findWorkflowRun(
  owner: string,
  repo: string,
  token: string,
  workflowFileName: string,
  createdAfter: Date
): Promise<GitHubWorkflowRun | null> {
  // List recent runs for the specific workflow file, filtering by creation time
  const since = createdAfter.toISOString();
  const url =
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFileName}/runs` +
    `?created=>=${since}&per_page=10`;

  const response = await githubFetch(url, token);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to list workflow runs: HTTP ${response.status} — ${text}`
    );
  }

  const data = (await response.json()) as GitHubWorkflowRunsResponse;

  if (data.workflow_runs.length === 0) {
    return null;
  }

  // Return the most recently created run
  const sorted = [...data.workflow_runs].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return sorted[0] ?? null;
}

export async function findPRForIssue(
  owner: string,
  repo: string,
  token: string,
  issueNumber: number
): Promise<GitHubPullRequest | null> {
  // Search for open PRs that reference the issue number in their body or title
  const query = encodeURIComponent(
    `repo:${owner}/${repo} is:pr is:open #${issueNumber}`
  );
  const url = `https://api.github.com/search/issues?q=${query}&per_page=10`;

  const response = await githubFetch(url, token, {
    headers: { Accept: "application/vnd.github+json" },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to search for PRs: HTTP ${response.status} — ${text}`
    );
  }

  const data = (await response.json()) as GitHubPullRequestsResponse;

  if (data.total_count === 0 || data.items.length === 0) {
    return null;
  }

  // Return the first matching PR
  const pr = data.items[0]!;
  return pr;
}

// ---------------------------------------------------------------------------
// Polling helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollForWorkflowRun(
  owner: string,
  repo: string,
  token: string,
  workflowFileName: string,
  createdAfter: Date,
  pollIntervalMs: number,
  timeoutMs: number
): Promise<{ run: GitHubWorkflowRun | null; timedOut: boolean; lastStatus: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "not started";

  console.log(
    `Polling for workflow run '${workflowFileName}' ` +
      `(interval: ${pollIntervalMs / 1000}s, timeout: ${timeoutMs / 1000}s)...`
  );

  while (Date.now() < deadline) {
    const run = await findWorkflowRun(
      owner,
      repo,
      token,
      workflowFileName,
      createdAfter
    );

    if (run !== null) {
      lastStatus = `${run.status}${run.conclusion ? `/${run.conclusion}` : ""}`;
      console.log(
        `  Workflow run found: ${run.html_url} (status: ${lastStatus})`
      );
      return { run, timedOut: false, lastStatus };
    }

    lastStatus = "not started";
    const remaining = Math.max(0, deadline - Date.now());
    console.log(
      `  No workflow run yet. Waiting ${pollIntervalMs / 1000}s ` +
        `(${Math.ceil(remaining / 1000)}s remaining)...`
    );
    await sleep(Math.min(pollIntervalMs, remaining + 100));
  }

  return { run: null, timedOut: true, lastStatus };
}

async function pollForPR(
  owner: string,
  repo: string,
  token: string,
  issueNumber: number,
  pollIntervalMs: number,
  timeoutMs: number
): Promise<{ pr: GitHubPullRequest | null; timedOut: boolean; lastStatus: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "no PR";

  console.log(
    `Polling for PR referencing issue #${issueNumber} ` +
      `(interval: ${pollIntervalMs / 1000}s, timeout: ${timeoutMs / 1000}s)...`
  );

  while (Date.now() < deadline) {
    const pr = await findPRForIssue(owner, repo, token, issueNumber);

    if (pr !== null) {
      lastStatus = `PR #${pr.number} opened`;
      console.log(`  PR found: #${pr.number} — ${pr.html_url}`);
      return { pr, timedOut: false, lastStatus };
    }

    lastStatus = "no PR yet";
    const remaining = Math.max(0, deadline - Date.now());
    console.log(
      `  No PR yet. Waiting ${pollIntervalMs / 1000}s ` +
        `(${Math.ceil(remaining / 1000)}s remaining)...`
    );
    await sleep(Math.min(pollIntervalMs, remaining + 100));
  }

  return { pr: null, timedOut: true, lastStatus };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const startTime = Date.now();

  // ── Load config ────────────────────────────────────────────────────────────
  let config: HarnessConfig;
  try {
    config = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`smoke-test: failed to load agent-harness.config.json: ${message}`);
    process.exit(1);
  }

  // ── Parse CLI args ─────────────────────────────────────────────────────────
  const opts = parseArgs(process.argv);

  if (!opts.token) {
    console.error(
      "smoke-test: no GitHub token found. Set GITHUB_TOKEN or pass --token <token>."
    );
    process.exit(1);
  }

  // ── Derive owner/repo from the git remote or config ───────────────────────
  // The config doesn't store the repo slug directly, so we read it from the
  // git remote. Fall back to a GITHUB_REPOSITORY env var (set in Actions).
  let owner: string;
  let repoName: string;

  const repoEnv = process.env["GITHUB_REPOSITORY"];
  if (repoEnv) {
    const parts = repoEnv.split("/");
    owner = parts[0] ?? "";
    repoName = parts[1] ?? "";
  } else {
    // Try to read from git remote
    try {
      const { execSync } = await import("child_process");
      const remoteUrl = execSync("git remote get-url origin", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();

      // Handle both HTTPS and SSH remote URLs:
      //   https://github.com/owner/repo.git
      //   git@github.com:owner/repo.git
      const httpsMatch = remoteUrl.match(
        /https:\/\/github\.com\/([^/]+)\/([^/.]+)/
      );
      const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/([^/.]+)/);
      const match = httpsMatch ?? sshMatch;

      if (!match) {
        throw new Error(`Could not parse GitHub owner/repo from remote URL: ${remoteUrl}`);
      }

      owner = match[1]!;
      repoName = match[2]!;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `smoke-test: could not determine GitHub repository. ` +
          `Set GITHUB_REPOSITORY=owner/repo or ensure 'git remote get-url origin' returns a GitHub URL.\n` +
          `Error: ${message}`
      );
      process.exit(1);
    }
  }

  const modulePath = config.module.path;

  console.log(`smoke-test: repository = ${owner}/${repoName}`);
  console.log(`smoke-test: module path = ${modulePath}`);
  console.log(`smoke-test: orchestrator endpoint = ${config.orchestrator.apiGatewayEndpoint}`);

  // ── Create the smoke-test issue ────────────────────────────────────────────
  console.log("\nCreating smoke-test issue...");
  const issueCreatedAt = new Date();

  let issue: GitHubIssue;
  try {
    issue = await createIssue(owner, repoName, opts.token, modulePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`smoke-test: failed to create issue: ${message}`);
    process.exit(1);
  }

  console.log(`Issue created: #${issue.number} — ${issue.html_url}`);

  // ── Dry-run: skip polling ──────────────────────────────────────────────────
  if (opts.dryRun) {
    console.log("\n--dry-run: skipping polling. Closing issue and exiting.");
    await closeIssue(owner, repoName, opts.token, issue.number);

    const summary: SmokeSummary = {
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      workflowRunUrl: null,
      prNumber: null,
      prUrl: null,
      elapsedMs: Date.now() - startTime,
      verdict: "pass",
    };
    console.log("\n" + formatSummary(summary));
    process.exit(0);
  }

  // ── Poll for the dispatch workflow run ─────────────────────────────────────
  console.log("\nWaiting for dispatch-agent-task.yml workflow run to start...");

  let workflowRunUrl: string | null = null;
  let lastWorkflowStatus = "not started";

  const workflowResult = await pollForWorkflowRun(
    owner,
    repoName,
    opts.token,
    "dispatch-agent-task.yml",
    issueCreatedAt,
    opts.workflowPollIntervalMs,
    opts.workflowTimeoutMs
  );

  if (workflowResult.run !== null) {
    workflowRunUrl = workflowResult.run.html_url;
    lastWorkflowStatus = workflowResult.lastStatus;
  } else {
    lastWorkflowStatus = workflowResult.lastStatus;
  }

  if (workflowResult.timedOut) {
    console.error(
      `\nTimeout: dispatch-agent-task.yml workflow did not start within ` +
        `${opts.workflowTimeoutMs / 1000}s.`
    );

    await closeIssue(owner, repoName, opts.token, issue.number);

    const summary: SmokeSummary = {
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      workflowRunUrl,
      prNumber: null,
      prUrl: null,
      elapsedMs: Date.now() - startTime,
      verdict: "fail",
      failureReason: "Workflow run did not start within timeout",
      lastPolledStatus: lastWorkflowStatus,
    };

    console.log("\n" + formatSummary(summary));
    process.exit(1);
  }

  // ── Poll for a PR referencing the issue ────────────────────────────────────
  console.log("\nWaiting for a PR referencing the issue to be opened...");

  const prResult = await pollForPR(
    owner,
    repoName,
    opts.token,
    issue.number,
    opts.prPollIntervalMs,
    opts.prTimeoutMs
  );

  // ── Close the issue (always) ───────────────────────────────────────────────
  console.log("\nClosing smoke-test issue...");
  await closeIssue(owner, repoName, opts.token, issue.number);

  // ── Build and print summary ────────────────────────────────────────────────
  const elapsedMs = Date.now() - startTime;

  if (prResult.timedOut || prResult.pr === null) {
    const summary: SmokeSummary = {
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      workflowRunUrl,
      prNumber: null,
      prUrl: null,
      elapsedMs,
      verdict: "fail",
      failureReason: "PR was not opened within timeout",
      lastPolledStatus: prResult.lastStatus,
    };

    console.log("\n" + formatSummary(summary));
    process.exit(1);
  }

  const summary: SmokeSummary = {
    issueNumber: issue.number,
    issueUrl: issue.html_url,
    workflowRunUrl,
    prNumber: prResult.pr.number,
    prUrl: prResult.pr.html_url,
    elapsedMs,
    verdict: "pass",
  };

  console.log("\n" + formatSummary(summary));
  process.exit(0);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`smoke-test: unexpected error: ${message}`);
  process.exit(1);
});
