import { createHash } from "crypto";
import type { ReviewerFinding } from "@agent-harness/harness-shared";

/**
 * Computes a content-derived signature for a reviewer finding.
 *
 * The signature is a deterministic SHA-256 hash of the finding's stable
 * fields: `pillar`, `id`, `file` (empty string when absent), and
 * `description`. It is truncated to 16 hex characters.
 *
 * The signature is embedded in auto-opened issue bodies as:
 *   <!-- agent-harness:finding-signature:<signature> -->
 *
 * This allows the deduplication check to identify existing issues for the
 * same finding without relying on mutable fields like severity or
 * suggestedFix.
 *
 * Requirements: 2.3
 */
export function computeSignature(finding: ReviewerFinding): string {
  const stable = JSON.stringify({
    pillar: finding.pillar,
    id: finding.id,
    file: finding.file ?? "",
    description: finding.description,
  });

  return createHash("sha256").update(stable, "utf8").digest("hex").slice(0, 16);
}
