/**
 * Gap-closure check dispatcher.
 *
 * Reads `originatingFinding.id` and dispatches to the matching probe
 * function. Unknown finding IDs return a `GapClosureResult` with
 * `closed: false` and `probeMethod: "unknown"`.
 *
 * Transient AWS SDK errors are retried once with a 5-second backoff before
 * the error is recorded in `probeError`.
 *
 * Requirements: 4.1, 4.3
 */

import type { OriginatingFinding } from "@agent-harness/harness-shared";
import type { GapClosureResult } from "./types";
import { probeSnsHttpsOnly } from "./probes/sns-https-only";
import { probeSqsEncryption } from "./probes/sqs-encryption";
import { probeIamScoping } from "./probes/iam-scoping";

// ---------------------------------------------------------------------------
// Stack outputs
// ---------------------------------------------------------------------------

/**
 * Resource ARNs / URLs from the deployed preview stack.
 *
 * All fields are optional because the stack may not have deployed every
 * resource (e.g., a module that has no SNS topic). When a required ARN is
 * missing the probe returns `probeError: "stack-output-missing"`.
 */
export interface StackOutputs {
  /** ARN of the deployed SNS topic (for WA-SEC-02). */
  topicArn?: string;
  /** URL of the deployed SQS queue (for WA-REL-04). */
  queueUrl?: string;
  /** ARN of the Lambda execution role (for WA-SEC-05). */
  lambdaRoleArn?: string;
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

/** Delay for `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRY_DELAY_MS = 5_000;

/**
 * Run `probe` and, if the result has a `probeError`, wait 5 seconds and
 * retry once. Returns the second result regardless of whether it also has
 * a `probeError`.
 */
async function withRetry(
  probe: () => Promise<GapClosureResult>,
): Promise<GapClosureResult> {
  const first = await probe();
  if (first.probeError === undefined) {
    return first;
  }
  await delay(RETRY_DELAY_MS);
  return probe();
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

type ProbeDispatch = (
  stackOutputs: StackOutputs,
) => Promise<GapClosureResult>;

const dispatchTable: Record<string, ProbeDispatch> = {
  "WA-SEC-02": async (stackOutputs) => {
    if (!stackOutputs.topicArn) {
      return {
        gapId: "WA-SEC-02",
        closed: false,
        evidence: {},
        probeMethod: "sns:GetTopicAttributes",
        probeError: "stack-output-missing",
      };
    }
    return withRetry(() => probeSnsHttpsOnly(stackOutputs.topicArn as string));
  },

  "WA-REL-04": async (stackOutputs) => {
    if (!stackOutputs.queueUrl) {
      return {
        gapId: "WA-REL-04",
        closed: false,
        evidence: {},
        probeMethod: "sqs:GetQueueAttributes",
        probeError: "stack-output-missing",
      };
    }
    return withRetry(() => probeSqsEncryption(stackOutputs.queueUrl as string));
  },

  "WA-SEC-05": async (stackOutputs) => {
    if (!stackOutputs.lambdaRoleArn) {
      return {
        gapId: "WA-SEC-05",
        closed: false,
        evidence: {},
        probeMethod: "iam:SimulatePrincipalPolicy",
        probeError: "stack-output-missing",
      };
    }
    return withRetry(() =>
      probeIamScoping(stackOutputs.lambdaRoleArn as string),
    );
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the gap-closure check for the given originating finding.
 *
 * Dispatches to the probe registered for `finding.id`. If no probe is
 * registered, returns a result with `closed: false` and
 * `probeMethod: "unknown"`.
 *
 * Transient probe errors (indicated by a non-undefined `probeError` on the
 * first attempt) are retried once after a 5-second delay.
 *
 * @param finding       The originating finding from the trigger payload.
 * @param stackOutputs  Resource ARNs / URLs from the deployed preview stack.
 */
export async function runGapClosureCheck(
  finding: OriginatingFinding,
  stackOutputs: StackOutputs,
): Promise<GapClosureResult> {
  const probe = dispatchTable[finding.id];

  if (probe === undefined) {
    return {
      gapId: finding.id,
      closed: false,
      evidence: {},
      probeMethod: "unknown",
    };
  }

  return probe(stackOutputs);
}
