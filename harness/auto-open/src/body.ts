/**
 * Issue body renderer for the auto-open mechanism.
 *
 * Renders the structured issue body template for a fitness-gap finding,
 * embedding the auto-open marker, the content-derived finding signature,
 * and all required finding and run metadata fields.
 *
 * Requirements: 2.2
 */

import type { ReviewerFinding } from "../../shared/src/fitness-gap-types";

/**
 * Input to the `renderIssueBody` function.
 */
export interface RenderBodyInput {
  /** The reviewer finding to render. */
  finding: ReviewerFinding;
  /** Content-derived signature (SHA-256, 16 hex chars). */
  signature: string;
  /** Identifier of the scheduled reviewer run that produced this finding. */
  runId: string;
  /** ISO-8601 timestamp of the run. */
  runDate: string;
  /** Model identifier used for the reviewer run. */
  modelId: string;
}

/**
 * Renders the issue body for an auto-opened fitness-gap issue.
 *
 * The rendered body includes:
 * - An auto-open marker HTML comment
 * - A finding-signature HTML comment (used for deduplication)
 * - The finding's id, description, severity, pillar, and file reference
 * - The suggested fix
 * - Reviewer run metadata (runId, runDate, modelId)
 *
 * When `finding.file` is absent, the file line is omitted entirely.
 * When `finding.line` is absent, only the file path is shown (no line number).
 */
export function renderIssueBody(input: RenderBodyInput): string {
  const { finding, signature, runId, runDate, modelId } = input;

  const fileSection = renderFileLine(finding);

  return [
    `<!-- agent-harness:auto-opened:true -->`,
    `<!-- agent-harness:finding-signature:${signature} -->`,
    ``,
    `## Architecture fitness gap: ${finding.id} — ${finding.description}`,
    ``,
    `**Severity:** ${finding.severity}`,
    `**Pillar:** ${finding.pillar}`,
    ...(fileSection !== null ? [`**File:** ${fileSection}`] : []),
    ``,
    `### Finding`,
    ``,
    finding.description,
    ``,
    `### Suggested fix`,
    ``,
    finding.suggestedFix,
    ``,
    `### Reviewer run`,
    ``,
    `- **Run ID:** ${runId}`,
    `- **Date:** ${runDate}`,
    `- **Model:** ${modelId}`,
    ``,
    `---`,
    `*This issue was opened automatically by the scheduled inferential reviewer.`,
    `Apply the \`agent-task\` label to dispatch the editing agent.*`,
  ].join("\n");
}

/**
 * Builds the file reference string for the issue body.
 *
 * Returns `null` when `finding.file` is absent (caller omits the line).
 * Returns `"<file>"` when only the file is present (no line number).
 * Returns `"<file>:<line>"` when both file and line are present.
 */
function renderFileLine(finding: ReviewerFinding): string | null {
  if (!finding.file) {
    return null;
  }
  if (finding.line === undefined) {
    return finding.file;
  }
  return `${finding.file}:${finding.line}`;
}
