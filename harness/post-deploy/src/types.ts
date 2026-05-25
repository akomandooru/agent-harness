/**
 * Type contract for the synthetic post-deploy harness.
 *
 * `PostDeployOutput` is the wire format the agent reads (`postDeploy.invoke`'s
 * return shape) and the CLI prints to stdout. Pinned by `design.md`'s Data
 * Models section so the editor agent's loop and the tool catalogue agree on
 * one schema.
 *
 * Outcome semantics, as the design uses them:
 *
 *   - `pass`           — `cdk deploy` succeeded AND the synthetic flow
 *                        (HTTP request through API Gateway, message
 *                        through SNS -> SQS, EgressFn receipt) succeeded
 *                        AND the encryption properties the assertions
 *                        expect were observed.
 *   - `fail`           — `cdk deploy` succeeded but the synthetic flow
 *                        did not complete within the timeout (the message
 *                        never reached the queue or the EgressFn).
 *   - `partial`        — `cdk deploy` succeeded and the synthetic flow
 *                        completed, but at least one assertion (e.g.,
 *                        encryption-at-rest, KMS key id) did not match
 *                        the expectation. The agent has signal it can act
 *                        on without a hard fail.
 *   - `deploy-failure` — the upstream `cdk deploy` errored. The harness
 *                        was invoked but did not run the synthetic flow.
 *                        The wrapper passes the deploy logs through so the
 *                        agent's next iteration sees them.
 *
 * The distinction between `deploy-failure` and `fail` is what the design's
 * Component responsibilities table singles out: a failed deploy is not the
 * harness's domain to diagnose, and lumping them together would muddle the
 * agent's signal. The wrapper surfaces deploy logs separately on
 * `deployLogs` so the editor agent can read them as iteration context.
 */

/** Outcome of a post-deploy invocation. See module-level docs for semantics. */
export type PostDeployOutcome = "pass" | "fail" | "partial" | "deploy-failure";

/**
 * Output contract from `design.md` Data Models.
 *
 * `report` is `Record<string, unknown>` rather than a fixed shape because
 * different deploys may surface different details (KMS key ids, queue
 * attributes, log excerpts). The harness commits to a stable set of keys
 * documented in `runner.ts`'s `buildReport`, but the type here stays open
 * so a forker extending the harness doesn't have to widen the contract.
 *
 * `logs` carries CloudWatch log excerpts the harness collected from the
 * EgressFn while waiting for the message to be processed. Optional because
 * the harness may pass without ever reading logs (a fast queue-drain path
 * is enough), and to keep the wire format small in the success case.
 *
 * `deployLogs` carries the upstream `cdk deploy` stdout/stderr when the
 * outcome is `deploy-failure`. Optional on every other outcome. Captured
 * here (rather than in `report`) so the loop runner can promote it
 * directly into the next iteration's context without rummaging through a
 * Record.
 */
export interface PostDeployOutput {
  readonly outcome: PostDeployOutcome;
  readonly report: Record<string, unknown>;
  readonly logs?: Record<string, string>;
  readonly deployLogs?: string;
}

/**
 * Input the runner accepts.
 *
 * `stackOutputs` carries the values printed by the CDK deploy step:
 *   - `ApiEndpointUrl` (the POST endpoint to drive)
 *   - `QueueUrl`       (the SQS queue downstream of SNS)
 *   - other module-defined outputs
 *
 * Output keys here match the keys produced by `cdk deploy --all` parsed
 * by `agents/editor/tools/cdk.ts`'s `parseStackOutputs`. The CDK CLI
 * concatenates the stack name and the output key with a `.` (e.g.,
 * `FanoutPreview.ApiEndpointUrl`), so the runner's resolver accepts
 * either the qualified or the bare key (see `resolveStackOutput`).
 *
 * `sessionId` is part of the synthetic message body so the CloudWatch
 * log search and the queue scan can identify the test message and
 * ignore other traffic that may have hit the preview at the same time.
 *
 * `deployFailureLogs`, when provided, signals that the upstream deploy
 * errored and the harness should return `outcome: "deploy-failure"`
 * without running any of the synthetic flow. The wrapper layer
 * (`agents/editor/tools/post-deploy.ts`) passes this through after a
 * non-`ok` `cdk.deploy` result.
 *
 * `triggerType` distinguishes `"fitness-gap"` triggers (which carry an
 * `originatingFinding`) from `"feature-change"` triggers. When absent,
 * the runner behaves as a `"feature-change"` trigger (backward-compatible).
 *
 * `originatingFinding` is present only when `triggerType === "fitness-gap"`.
 * It carries the finding that prompted this agent run and is used by the
 * gap-closure check to select the correct probe.
 *
 * `gapClosureStackOutputs` carries the resource ARNs / URLs needed by the
 * gap-closure probes (topicArn, queueUrl, lambdaRoleArn). Kept separate
 * from the smoke-test `stackOutputs` so the two concerns stay decoupled.
 */
export interface PostDeployInput {
  readonly sessionId: string;
  readonly stackOutputs?: Record<string, string>;
  readonly deployFailureLogs?: string;
  /** Distinguishes fitness-gap triggers from feature-change triggers. */
  readonly triggerType?: string;
  /** Present only when triggerType === "fitness-gap". */
  readonly originatingFinding?: import("@agent-harness/harness-shared").OriginatingFinding;
  /** Resource ARNs / URLs for the gap-closure probes. */
  readonly gapClosureStackOutputs?: import("../gap-closure/index").StackOutputs;
}
