/**
 * Gap-closure probe: SQS encryption-at-rest (WA-REL-04).
 *
 * Calls `sqs:GetQueueAttributes` against the deployed preview queue and
 * checks whether encryption-at-rest is enabled via either a
 * customer-managed KMS key (`KmsMasterKeyId` non-empty) or SQS-managed
 * SSE (`SqsManagedSseEnabled === "true"`).
 *
 * Returns a `GapClosureResult` with:
 *   - `gapId: "WA-REL-04"`
 *   - `closed: true`  when either encryption indicator is present
 *   - `closed: false` when neither indicator is present, or on probe error
 *   - `probeMethod: "sqs:GetQueueAttributes"`
 *   - `probeError`    set (and `closed: false`) when the AWS call fails
 *
 * Requirements: 4.2, 4.3
 */

import {
  SQSClient,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";

import type { GapClosureResult } from "../types";

// ---------------------------------------------------------------------------
// Client injection
// ---------------------------------------------------------------------------

/** Minimal SQS client surface the probe needs. */
export type SqsClientLike = Pick<SQSClient, "send">;

/** Lazily-constructed default client (deferred to avoid credential resolution at import time). */
let cachedSqsClient: SqsClientLike | undefined;
function getDefaultSqsClient(): SqsClientLike {
  if (cachedSqsClient === undefined) {
    cachedSqsClient = new SQSClient({});
  }
  return cachedSqsClient;
}

// ---------------------------------------------------------------------------
// Probe implementation
// ---------------------------------------------------------------------------

/**
 * Probe whether the SQS queue at `queueUrl` has encryption-at-rest enabled.
 *
 * Encryption is considered enabled when either:
 *   - `KmsMasterKeyId` is a non-empty string (customer-managed KMS key), or
 *   - `SqsManagedSseEnabled` equals `"true"` (SQS-managed SSE).
 *
 * @param queueUrl  The SQS queue URL from the deployed stack outputs.
 * @param sqsClient Optional SQS client override (for testing).
 */
export async function probeSqsEncryption(
  queueUrl: string,
  sqsClient?: SqsClientLike,
): Promise<GapClosureResult> {
  const sqs = sqsClient ?? getDefaultSqsClient();

  try {
    const response = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["KmsMasterKeyId", "SqsManagedSseEnabled"],
      }) as never,
    );

    const typed = response as {
      Attributes?: Record<string, string>;
    };

    const attributes = typed.Attributes ?? {};
    const kmsMasterKeyId = attributes["KmsMasterKeyId"];
    const sqsManagedSseEnabled = attributes["SqsManagedSseEnabled"];

    const encrypted =
      (typeof kmsMasterKeyId === "string" && kmsMasterKeyId.length > 0) ||
      sqsManagedSseEnabled === "true";

    return {
      gapId: "WA-REL-04",
      closed: encrypted,
      evidence: { queueUrl, attributes },
      probeMethod: "sqs:GetQueueAttributes",
    };
  } catch (err) {
    const probeError =
      err instanceof Error
        ? `GetQueueAttributes failed: ${err.message}`
        : `GetQueueAttributes failed: ${String(err)}`;

    return {
      gapId: "WA-REL-04",
      closed: false,
      evidence: { queueUrl },
      probeMethod: "sqs:GetQueueAttributes",
      probeError,
    };
  }
}
