/**
 * Label co-occurrence enforcement for the auto-open mechanism.
 *
 * The mechanism always applies both `agent-task` and `triage:fitness-gap`
 * in a single GitHub API call. It never applies `agent-task` alone.
 * This is enforced here in the wrapper, not by convention.
 *
 * Error handling:
 * - Label application fails after issue creation → attempt to close the
 *   issue immediately; record error; do not leave an unlabelled issue open.
 *
 * Uses Node.js built-in `fetch` (Node 20+). No external HTTP dependencies.
 *
 * Requirements: 2.4
 */

/** Result of a label-application attempt. */
export interface LabelResult {
  success: boolean;
  error?: string;
}

/**
 * Applies both `agent-task` and `triage:fitness-gap` to an existing issue
 * in a single `POST /repos/{repo}/issues/{issueNumber}/labels` call.
 *
 * On success, returns `{ success: true }`.
 *
 * On failure, attempts to close the issue via
 * `PATCH /repos/{repo}/issues/{issueNumber}` with `{ state: "closed" }`
 * to avoid leaving an unlabelled issue open, then returns
 * `{ success: false, error: <message> }`.
 *
 * @param issueNumber - The GitHub issue number to label.
 * @param githubToken - A GitHub personal access token or Actions token with
 *   `issues: write` permission.
 * @param repo - The repository in `owner/name` format, e.g. `"acme/my-repo"`.
 */
export async function applyFitnessGapLabels(
  issueNumber: number,
  githubToken: string,
  repo: string,
): Promise<LabelResult> {
  const labelsUrl = `https://api.github.com/repos/${repo}/issues/${issueNumber}/labels`;

  const labelsResponse = await fetch(labelsUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ labels: ["agent-task", "triage:fitness-gap"] }),
  });

  if (labelsResponse.ok) {
    return { success: true };
  }

  // Label application failed — capture the error message.
  let errorMessage: string;
  try {
    const body = (await labelsResponse.json()) as { message?: string };
    errorMessage =
      body.message ??
      `GitHub API returned HTTP ${labelsResponse.status} for label application`;
  } catch {
    errorMessage = `GitHub API returned HTTP ${labelsResponse.status} for label application`;
  }

  // Attempt to close the issue to avoid leaving an unlabelled issue open.
  const closeUrl = `https://api.github.com/repos/${repo}/issues/${issueNumber}`;
  try {
    await fetch(closeUrl, {
      method: "PATCH",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${githubToken}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ state: "closed" }),
    });
  } catch {
    // Close attempt failed — we still return the original label error.
    // The caller is responsible for surfacing both failures if needed.
  }

  return { success: false, error: errorMessage };
}
