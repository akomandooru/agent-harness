/**
 * Gap-closure probe: SNS HTTPS-only enforcement (WA-SEC-02).
 *
 * Calls `sns:GetTopicAttributes` against the deployed preview topic,
 * parses the resource-based policy, and checks for a Deny statement
 * that blocks non-HTTPS access (`aws:SecureTransport: "false"`).
 *
 * Returns a `GapClosureResult` with:
 *   - `gapId: "WA-SEC-02"`
 *   - `closed: true`  when the policy contains the required Deny
 *   - `closed: false` when the Deny is absent or the probe errors
 *   - `probeMethod: "sns:GetTopicAttributes"`
 *
 * Error handling: any AWS SDK exception is caught; `probeError` is set
 * and `closed` is `false`. The caller (`runGapClosureCheck`) treats a
 * `probeError` as a `"partial"` post-deploy outcome rather than a hard
 * `"fail"`, consistent with the design's error-handling table.
 */

import { SNSClient, GetTopicAttributesCommand } from "@aws-sdk/client-sns";
import type { GapClosureResult } from "@agent-harness/harness-shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal shape of an IAM policy document. */
interface PolicyDocument {
  Statement?: PolicyStatement[];
}

/** Minimal shape of a single IAM policy statement. */
interface PolicyStatement {
  Effect?: string;
  Condition?: {
    Bool?: Record<string, string | boolean>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Client injection
// ---------------------------------------------------------------------------

/** Minimal SNS client interface used by the probe (for testability). */
export type SnsClientLike = Pick<SNSClient, "send">;

// ---------------------------------------------------------------------------
// policyDeniesHttp
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the policy document contains at least one statement
 * that:
 *   - has `Effect: "Deny"`, AND
 *   - has a `Condition.Bool` entry where the key is
 *     `"aws:SecureTransport"` (case-insensitive) and the value is
 *     `"false"` or the boolean `false`.
 *
 * This matches the canonical SNS HTTPS-only policy pattern:
 *
 * ```json
 * {
 *   "Effect": "Deny",
 *   "Condition": { "Bool": { "aws:SecureTransport": "false" } }
 * }
 * ```
 *
 * Exported for unit testing.
 */
export function policyDeniesHttp(policy: PolicyDocument): boolean {
  const statements = policy.Statement ?? [];
  return statements.some((stmt) => {
    if (stmt.Effect !== "Deny") return false;
    const boolCondition = stmt.Condition?.Bool;
    if (boolCondition === undefined) return false;
    // Check all keys case-insensitively to handle both
    // "aws:SecureTransport" and "AWS:SecureTransport" variants.
    for (const [key, value] of Object.entries(boolCondition)) {
      if (key.toLowerCase() === "aws:securetransport") {
        // Accept both the string "false" and the boolean false.
        if (value === "false" || value === false) return true;
      }
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// probeSnsHttpsOnly
// ---------------------------------------------------------------------------

/**
 * Probe the deployed SNS topic for HTTPS-only enforcement.
 *
 * @param topicArn  ARN of the SNS topic in the preview environment.
 * @param client    Optional SNS client override (defaults to a new
 *                  `SNSClient({})` for standalone use; tests inject a stub).
 */
export async function probeSnsHttpsOnly(
  topicArn: string,
  client?: SnsClientLike,
): Promise<GapClosureResult> {
  const sns: SnsClientLike = client ?? new SNSClient({});

  try {
    const response = await sns.send(
      new GetTopicAttributesCommand({ TopicArn: topicArn }),
    );

    const rawPolicy = response.Attributes?.Policy ?? "{}";
    let policy: PolicyDocument;
    try {
      policy = JSON.parse(rawPolicy) as PolicyDocument;
    } catch {
      return {
        gapId: "WA-SEC-02",
        closed: false,
        evidence: { topicArn, rawPolicy },
        probeMethod: "sns:GetTopicAttributes",
        probeError: `failed to parse topic policy JSON: ${rawPolicy}`,
      };
    }

    const hasDenyHttp = policyDeniesHttp(policy);

    return {
      gapId: "WA-SEC-02",
      closed: hasDenyHttp,
      evidence: {
        topicArn,
        policyStatements: policy.Statement ?? [],
      },
      probeMethod: "sns:GetTopicAttributes",
    };
  } catch (err) {
    return {
      gapId: "WA-SEC-02",
      closed: false,
      evidence: { topicArn },
      probeMethod: "sns:GetTopicAttributes",
      probeError:
        err instanceof Error
          ? `GetTopicAttributes failed: ${err.message}`
          : `GetTopicAttributes failed: ${String(err)}`,
    };
  }
}
