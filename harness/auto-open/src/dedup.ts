/**
 * Deduplication check for the auto-open mechanism.
 *
 * Before opening a new issue, the auto-open mechanism queries open issues
 * with the `triage:fitness-gap` label and scans their bodies for a
 * content-signature marker. If a match is found, no new issue is opened.
 *
 * The signature marker format is:
 *   <!-- agent-harness:finding-signature:<16-hex-chars> -->
 *
 * Requirements: 2.3
 */

/**
 * Result of a deduplication check.
 *
 * When `isDuplicate` is `true`, `existingIssueNumber` and
 * `existingIssueUrl` are populated with the matching issue's details.
 */
export interface DedupResult {
  isDuplicate: boolean;
  existingIssueNumber?: number;
  existingIssueUrl?: string;
}

/**
 * Shape of a GitHub issue as returned by the list-issues REST endpoint.
 * Only the fields we need are declared here.
 */
interface GitHubIssue {
  number: number;
  html_url: string;
  body: string | null;
}

/**
 * Builds the URL for the first page of open issues with the
 * `triage:fitness-gap` label in the given repo.
 */
function buildIssuesUrl(repo: string, page: number): string {
  const base = `https://api.github.com/repos/${repo}/issues`;
  const params = new URLSearchParams({
    labels: "triage:fitness-gap",
    state: "open",
    per_page: "100",
    page: String(page),
  });
  return `${base}?${params.toString()}`;
}

/**
 * Fetches one page of open issues with the `triage:fitness-gap` label.
 *
 * Throws on non-2xx responses so the caller can decide how to handle
 * GitHub API errors (per the error table: treat as no duplicate found).
 */
async function fetchIssuePage(
  url: string,
  githubToken: string,
): Promise<GitHubIssue[]> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(
      `GitHub API error: ${response.status} ${response.statusText} — GET ${url}`,
    );
  }

  return response.json() as Promise<GitHubIssue[]>;
}

/**
 * Returns true when the issue body contains the signature marker for the
 * given signature string.
 *
 * The marker format is:
 *   <!-- agent-harness:finding-signature:<signature> -->
 */
function bodyContainsSignature(
  body: string | null,
  signature: string,
): boolean {
  if (!body) {
    return false;
  }
  const marker = `<!-- agent-harness:finding-signature:${signature} -->`;
  return body.includes(marker);
}

/**
 * Checks whether an open issue already exists for the given finding
 * signature.
 *
 * Queries all open issues with the `triage:fitness-gap` label (paginated,
 * 100 per page) and scans each issue body for the signature marker. Returns
 * on the first match found.
 *
 * On GitHub API error, throws the error. The caller is responsible for
 * handling it (per the error table: treat as no duplicate found).
 *
 * @param signature - 16-hex-character content signature produced by
 *   `computeSignature` in `signature.ts`.
 * @param githubToken - GitHub personal access token or Actions token with
 *   `issues: read` permission.
 * @param repo - Repository in `owner/name` format, e.g. `"acme/my-repo"`.
 */
export async function checkDuplicate(
  signature: string,
  githubToken: string,
  repo: string,
): Promise<DedupResult> {
  let page = 1;

  while (true) {
    const url = buildIssuesUrl(repo, page);
    const issues = await fetchIssuePage(url, githubToken);

    // No more pages — no duplicate found.
    if (issues.length === 0) {
      return { isDuplicate: false };
    }

    for (const issue of issues) {
      if (bodyContainsSignature(issue.body, signature)) {
        return {
          isDuplicate: true,
          existingIssueNumber: issue.number,
          existingIssueUrl: issue.html_url,
        };
      }
    }

    // If the page was not full, there are no more pages.
    if (issues.length < 100) {
      return { isDuplicate: false };
    }

    page += 1;
  }
}
