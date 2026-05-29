/**
 * IAM scoping probe for the gap-closure check.
 *
 * Verifies that a given IAM role does not have overly-broad S3 permissions
 * by calling `iam:SimulatePrincipalPolicy` with the two most dangerous
 * S3 actions (`s3:DeleteObject` and `s3:PutBucketPolicy`) against `*`.
 *
 * If either action is `allowed`, the role is considered over-permissioned
 * and the gap is not closed (`closed: false`).
 *
 * Maps to finding id `WA-SEC-05` (IAM least-privilege / scoping gap).
 *
 * Requirements: 4.2, 4.3
 */

import {
  IAMClient,
  SimulatePrincipalPolicyCommand,
} from "@aws-sdk/client-iam";

import type { GapClosureResult } from "@agent-harness/harness-shared";

// ---------------------------------------------------------------------------
// Client injection
// ---------------------------------------------------------------------------

export type IamClientLike = Pick<IAMClient, "send">;

/**
 * Lazily-constructed default IAM client.
 *
 * Deferred to avoid credential/region resolution at module load time,
 * which would break unit tests that inject a stub client.
 */
let cachedIamClient: IamClientLike | undefined;
function getDefaultIamClient(): IamClientLike {
  if (cachedIamClient === undefined) {
    cachedIamClient = new IAMClient({});
  }
  return cachedIamClient;
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Probe whether a role has overly-broad S3 permissions.
 *
 * Calls `iam:SimulatePrincipalPolicy` with `s3:DeleteObject` and
 * `s3:PutBucketPolicy` on resource `*`. If either action evaluates to
 * `"allowed"`, the role is over-permissioned and the gap is not closed.
 *
 * On AWS SDK errors the probe sets `probeError` and returns `closed: false`
 * so the post-deploy runner can record a `"partial"` outcome rather than
 * crashing.
 *
 * @param roleArn - ARN of the IAM role to simulate (typically the preview
 *   Lambda's execution role from `stackOutputs`).
 * @param clientOverride - Optional IAM client stub for unit tests.
 */
export async function probeIamScoping(
  roleArn: string,
  clientOverride?: IamClientLike,
): Promise<GapClosureResult> {
  const iam = clientOverride ?? getDefaultIamClient();

  try {
    const response = await iam.send(
      new SimulatePrincipalPolicyCommand({
        PolicySourceArn: roleArn,
        ActionNames: ["s3:DeleteObject", "s3:PutBucketPolicy"],
        ResourceArns: ["*"],
      }),
    );

    const evaluationResults = response.EvaluationResults ?? [];
    const hasOverpermission = evaluationResults.some(
      (r) => r.EvalDecision === "allowed",
    );

    return {
      gapId: "WA-SEC-05",
      closed: !hasOverpermission,
      evidence: {
        roleArn,
        evaluationResults: evaluationResults.map((r) => ({
          evalActionName: r.EvalActionName,
          evalDecision: r.EvalDecision,
          evalResourceName: r.EvalResourceName,
        })),
      },
      probeMethod: "iam:SimulatePrincipalPolicy",
    };
  } catch (err) {
    return {
      gapId: "WA-SEC-05",
      closed: false,
      evidence: { roleArn },
      probeMethod: "iam:SimulatePrincipalPolicy",
      probeError:
        err instanceof Error
          ? `SimulatePrincipalPolicy failed: ${err.message}`
          : `SimulatePrincipalPolicy failed: ${String(err)}`,
    };
  }
}
