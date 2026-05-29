/**
 * Entry point for the auto-open mechanism.
 *
 * Wires together the threshold filter, deduplication check, issue body
 * renderer, and label enforcement into a single `autoOpenIssues` function.
 *
 * Pipeline for each finding:
 * 1. Filter by severity threshold (from config `fitnessGapLoop.autoOpen.severityThreshold`)
 * 2. Compute content signature via `computeSignature`
 * 3. Check for duplicate via `checkDuplicate`
 * 4. If duplicate and `duplicateAction === "comment"`: post a comment to the existing issue
 * 5. If duplicate and `duplicateAction === "skip"`: skip
 * 6. If not duplicate: render body, create issue, apply labels via `applyFitnessGapLabels`
 *
 * Error handling:
 * - Dedup check error: log to stderr, treat as no duplicate (conservative), continue
 * - Issue creation error: record in `errors[]`, continue with remaining findings
 * - Label application failure: `applyFitnessGapLabels` handles closing the issue;
 *   record in `errors[]`
 *
 * Uses Node.js built-in `fetch` (Node 20+). No external HTTP dependencies.
 *
 * Requirements: 2.1, 2.3, 2.4, 2.5
 */

import { readFileSync } from "fs";
import { join } from "path";

import type {
  AutoOpenInput,
  AutoOpenResult,
  ReviewerFinding,
} from "../../shared/src/fitness-gap-types";

import { filterByThreshold } from "./threshold";
import { computeSignature } from "./signature";
import { checkDuplicate } from "./dedup";
import { renderIssueBody } from "./body";
import { applyFitnessGapLabels } from "./labels";

// ---------------------------------------------------------------------------
// Config reading
// ---------------------------------------------------------------------------

interface AutoOpenConfig {
  severityThreshold: string;
  duplicateAction: "comment" | "skip";
}

/**
 * Reads `fitnessGapLoop.autoOpen` from `agent-harness.config.json`.
 *
 * Resolves the config file relative to the workspace root (two directories
 * above this package's `src/` directory).
 */
function readAutoOpenConfig(): AutoOpenConfig {
  const configPath = join(__dirname, "..", "..", "..", "agent-harness.config.json");
  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as {
    fitnessGapLoop?: {
      autoOpen?: {
        severityThreshold?: string;
        duplicateAction?: string;
      };
    };
  };

  const autoOpen = config.fitnessGapLoop?.autoOpen;
  const severityThreshold = autoOpen?.severityThreshold ?? "HIGH";
  const duplicateActionRaw = autoOpen?.duplicateAction ?? "skip";
  const duplicateAction: "comment" | "skip" =
    duplicateActionRaw === "comment" ? "comment" : "skip";

  return { severityThreshold, duplicateAction };
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

/**
 * Creates a new GitHub issue and returns its number.
 *
 * Throws on non-2xx responses.
 */
async function createIssue(
  title: string,
  body: string,
  githubToken: string,
  repo: string,
): Promise<number> {
  const url = `https://api.github.com/repos/${repo}/issues`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ title, body }),
  });

  if (!response.ok) {
    let message: string;
    try {
      const json = (await response.json()) as { message?: string };
      message = json.message ?? `HTTP ${response.status}`;
    } catch {
      message = `HTTP ${response.status}`;
    }
    throw new Error(`Failed to create issue: ${message}`);
  }

  const created = (await response.json()) as { number: number };
  return created.number;
}

/**
 * Posts a comment to an existing issue noting the new run date and finding
 * count (used when `duplicateAction === "comment"`).
 *
 * Throws on non-2xx responses.
 */
async function postDuplicateComment(
  issueNumber: number,
  runDate: string,
  totalFindings: number,
  githubToken: string,
  repo: string,
): Promise<void> {
  const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`;
  const commentBody =
    `<!-- agent-harness:auto-opened:true -->\n` +
    `The scheduled inferential reviewer re-detected this finding on **${runDate}**.\n` +
    `Total findings in this run: **${totalFindings}**.`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ body: commentBody }),
  });

  if (!response.ok) {
    let message: string;
    try {
      const json = (await response.json()) as { message?: string };
      message = json.message ?? `HTTP ${response.status}`;
    } catch {
      message = `HTTP ${response.status}`;
    }
    throw new Error(`Failed to post comment to issue #${issueNumber}: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Issue title helper
// ---------------------------------------------------------------------------

/**
 * Builds the issue title from a finding.
 */
function buildIssueTitle(finding: ReviewerFinding): string {
  return `Architecture fitness gap: ${finding.id} — ${finding.description}`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Opens GitHub issues for reviewer findings that meet the severity threshold,
 * deduplicating against existing open issues.
 *
 * @param input - The reviewer findings and run metadata.
 * @param githubToken - A GitHub personal access token or Actions token with
 *   `issues: write` permission.
 * @param repo - The repository in `owner/name` format, e.g. `"acme/my-repo"`.
 */
export async function autoOpenIssues(
  input: AutoOpenInput,
  githubToken: string,
  repo: string,
): Promise<AutoOpenResult> {
  const { findings, runId, runDate, modelId } = input;
  const config = readAutoOpenConfig();

  const result: AutoOpenResult = {
    opened: 0,
    skipped: 0,
    commented: 0,
    errors: [],
  };

  // Step 1: Filter findings by severity threshold.
  const candidates = filterByThreshold(findings, config.severityThreshold);

  for (const finding of candidates) {
    // Step 2: Compute content signature.
    const signature = computeSignature(finding);

    // Step 3: Check for duplicate.
    let dedupResult: Awaited<ReturnType<typeof checkDuplicate>>;
    try {
      dedupResult = await checkDuplicate(signature, githubToken, repo);
    } catch (err) {
      // Dedup check error: log to stderr, treat as no duplicate (conservative).
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[auto-open] dedup check failed for finding ${finding.id} (signature ${signature}): ${message}\n`,
      );
      dedupResult = { isDuplicate: false };
    }

    if (dedupResult.isDuplicate) {
      if (config.duplicateAction === "comment") {
        // Step 4a: Post a comment to the existing issue.
        try {
          await postDuplicateComment(
            dedupResult.existingIssueNumber!,
            runDate,
            findings.length,
            githubToken,
            repo,
          );
          result.commented += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result.errors.push({ finding, error: message });
        }
      } else {
        // Step 4b: Skip — duplicate and duplicateAction === "skip".
        result.skipped += 1;
      }
      continue;
    }

    // Step 5: Not a duplicate — render body, create issue, apply labels.
    const body = renderIssueBody({ finding, signature, runId, runDate, modelId });
    const title = buildIssueTitle(finding);

    let issueNumber: number;
    try {
      issueNumber = await createIssue(title, body, githubToken, repo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ finding, error: message });
      continue;
    }

    // Apply labels. On failure, `applyFitnessGapLabels` closes the issue.
    const labelResult = await applyFitnessGapLabels(issueNumber, githubToken, repo);
    if (!labelResult.success) {
      result.errors.push({
        finding,
        error: labelResult.error ?? "Label application failed",
      });
      continue;
    }

    result.opened += 1;
  }

  return result;
}
