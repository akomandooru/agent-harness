import { createHash } from "node:crypto";

/**
 * Derives a deterministic, unique session ID from the CodeBuild build ID.
 *
 * CodeBuild build IDs have the form: project-name:build-uuid
 * We hash the full build ID to produce a fixed-length, URL-safe identifier.
 */
export function deriveSessionId(codeBuildBuildId: string): string {
  return createHash("sha256")
    .update(codeBuildBuildId)
    .digest("hex")
    .slice(0, 40); // 40 hex chars — satisfies AgentCore's ≥33 char minimum
}
