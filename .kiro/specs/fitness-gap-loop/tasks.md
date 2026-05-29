# Implementation Plan: Fitness Gap Loop

## Overview

Extend the agent harness template with Task 2: a closed loop driven by architecture-fitness gaps. This plan adds the scheduled reviewer workflow, the auto-open mechanism, the trigger payload extension, the gap-closure check, and the observability additions — all layered on top of the unchanged Task 1 (`feature-change-loop`) components.

Implementation language: **TypeScript** (consistent with the existing codebase).

## Tasks

- [x] 1. Extend configuration and shared types
  - [x] 1.1 Add `fitnessGapLoop` section to `agent-harness.config.json`
    - Add `enabled`, `schedule`, `autoOpen`, `gapClosureChecks`, `costGuardrail`, and `drift` fields with documented defaults
    - _Requirements: 1.3, 2.5, 5.5, 6.4_

  - [x] 1.2 Define shared TypeScript interfaces for Task 2
    - Create `harness/shared/src/fitness-gap-types.ts` with `OriginatingFinding`, `GapClosureResult`, `AutoOpenInput`, `AutoOpenResult`, `ScheduledReviewerRunRecord`, and `GapClosureOutcomeRecord` interfaces
    - Export all types from the shared package index
    - _Requirements: 2.2, 3.2, 4.4, 5.1, 5.3_

- [x] 2. Implement the auto-open mechanism
  - [x] 2.1 Implement content-signature computation
    - Create `harness/auto-open/src/signature.ts`
    - Compute SHA-256 over stable finding fields (`pillar`, `id`, `file`, `description`), truncate to 16 hex chars
    - _Requirements: 2.3_

  - [x] 2.2 Implement severity threshold filter
    - Create `harness/auto-open/src/threshold.ts`
    - Implement ordered severity comparison (`info < low < medium < high < critical`)
    - Filter findings against `fitnessGapLoop.autoOpen.severityThreshold`
    - _Requirements: 2.1_

  - [x] 2.3 Implement deduplication check
    - Create `harness/auto-open/src/dedup.ts`
    - Query open issues with `triage:fitness-gap` label via GitHub API
    - Scan issue bodies for `<!-- agent-harness:finding-signature:<sig> -->` marker
    - Return match result and existing issue number when found
    - _Requirements: 2.3_

  - [x] 2.4 Implement issue body renderer
    - Create `harness/auto-open/src/body.ts`
    - Render the issue body template with all required fields: `id`, `description`, `severity`, `pillar`, `file`, `suggestedFix`, `runId`, `runDate`, auto-open marker comment, and finding-signature comment
    - _Requirements: 2.2_

  - [x] 2.5 Implement label co-occurrence enforcement
    - Create `harness/auto-open/src/labels.ts`
    - Apply `agent-task` and `triage:fitness-gap` in a single GitHub API call
    - On label-application failure after issue creation: attempt to close the issue immediately and record the error
    - _Requirements: 2.4_

  - [x] 2.6 Implement `autoOpenIssues` entry point
    - Create `harness/auto-open/src/index.ts` wiring threshold filter → dedup check → body renderer → label enforcement
    - Return `AutoOpenResult` with `opened`, `skipped`, `commented`, and `errors` counts
    - Handle `duplicateAction: "comment"` by posting a comment to the existing issue
    - _Requirements: 2.1, 2.3, 2.4, 2.5_

- [x] 3. Checkpoint — Ensure auto-open implementation is complete
  - Review implementation, ask the user if questions arise.

- [x] 4. Implement the trigger payload extension
  - [x] 4.1 Add label-detection step to `dispatch-agent-task.yml`
    - Insert label-detection bash step after the existing "Validate required fields" step
    - Detect `triage:fitness-gap` label via `gh api`; set `TRIGGER_TYPE` and `FINDING_SIGNATURE` env vars
    - Fall back to `feature-change` when label is absent (Task 1 path unchanged)
    - _Requirements: 3.1, 3.4, 6.1_

  - [x] 4.2 Extend payload builder to include `originatingFinding`
    - Modify the payload-build step in `dispatch-agent-task.yml` to include `triggerType` field
    - When `triggerType === "fitness-gap"`: extract `originatingFinding` fields from the issue body using the finding-signature marker and structured body sections
    - When `triggerType === "feature-change"`: omit `originatingFinding` entirely (not null, absent)
    - _Requirements: 3.2, 3.3_

- [x] 5. Implement the gap-closure check
  - [x] 5.1 Implement SNS HTTPS-only probe
    - Create `harness/post-deploy/gap-closure/probes/sns-https-only.ts`
    - Call `sns.getTopicAttributes`, parse the topic policy, check for a Deny statement on `aws:SecureTransport=false`
    - Return `GapClosureResult` with `gapId: "WA-SEC-02"`, `closed`, `evidence`, and `probeMethod: "sns:GetTopicAttributes"`
    - _Requirements: 4.2, 4.3_

  - [x] 5.2 Implement SQS encryption-at-rest probe
    - Create `harness/post-deploy/gap-closure/probes/sqs-encryption.ts`
    - Call `sqs.getQueueAttributes` for `KmsMasterKeyId` and `SqsManagedSseEnabled`
    - Return `GapClosureResult` with `gapId: "WA-REL-04"`, `closed`, `evidence`, and `probeMethod: "sqs:GetQueueAttributes"`
    - _Requirements: 4.2, 4.3_

  - [x] 5.3 Implement IAM scoping probe
    - Create `harness/post-deploy/gap-closure/probes/iam-scoping.ts`
    - Call `iam.simulatePrincipalPolicy` with `s3:DeleteObject` and `s3:PutBucketPolicy` on `*`
    - Return `GapClosureResult` with `gapId: "WA-SEC-05"`, `closed: !hasOverpermission`, `evidence`, and `probeMethod: "iam:SimulatePrincipalPolicy"`
    - _Requirements: 4.2, 4.3_

  - [x] 5.4 Implement probe dispatch table and `runGapClosureCheck`
    - Create `harness/post-deploy/gap-closure/index.ts`
    - Build dispatch table mapping finding IDs to probe functions (`WA-SEC-02` → SNS probe, `WA-REL-04` → SQS probe, `WA-SEC-05` → IAM probe)
    - Unknown IDs return `GapClosureResult` with `closed: false` and `probeMethod: "unknown"`
    - Retry once with 5-second backoff on transient AWS SDK errors before recording `probeError`
    - _Requirements: 4.1, 4.3_

  - [x] 5.5 Extend post-deploy runner to dispatch gap-closure check
    - Modify `harness/post-deploy/src/run.ts` to call `runGapClosureCheck` when `triggerType === "fitness-gap"` and `originatingFinding` is present
    - Write `GapClosureResult` to session `postDeploy.report.gapClosure` on failure
    - Set overall `postDeploy.outcome` to `"partial"` when probe error occurs, `"fail"` when gap is not closed
    - _Requirements: 4.1, 4.4, 6.5_

- [x] 6. Checkpoint — Ensure gap-closure implementation is complete
  - Review implementation, ask the user if questions arise.

- [x] 7. Extend the PR body for gap-closure success
  - [x] 7.1 Add gap-closure section to the PR body template
    - Modify `agents/editor/pr-body.template.md` to include the conditional gap-closure section
    - Section includes: originating finding ID and description, severity, pillar, verification table (gapId, probeMethod, result), evidence summary, and preview env ID with timestamp
    - Section is omitted entirely for `feature-change` triggers
    - _Requirements: 4.5_

  - [x] 7.2 Extend `buildSuccessPRBody` to populate the gap-closure section
    - Modify `agents/editor/pr-body.ts` to read `session.trigger.triggerType` and `session.gapClosure`
    - Populate the gap-closure section when `triggerType === "fitness-gap"` and gap-closure check passed
    - _Requirements: 4.5_

- [x] 8. Implement observability additions
  - [x] 8.1 Implement `ScheduledReviewerRunRecord` emitter
    - Create `harness/scheduled-reviewer/src/emit-run-record.ts`
    - Emit record to CloudWatch Logs at `/agent-harness/scheduled-reviewer` with all required fields: `runId`, `timestamp`, `modelId`, `modelVersion`, `outcome`, `failureReason`, `findingsBySeverity`, `issuesOpened`, `duplicatesSkipped`, `tokenCostUSD`
    - Emit on both success and failure paths
    - _Requirements: 5.1_

  - [x] 8.2 Implement cost guardrail check
    - Add token cost check in `harness/scheduled-reviewer/src/run.ts` after reviewer invocation
    - If `tokenCostUSD > fitnessGapLoop.costGuardrail.reviewerTokenSpendCapUSD`: exit non-zero before auto-open step, emit run record with `outcome: "failure"` and `failureReason: "cost-cap-exceeded"`
    - _Requirements: 5.5_

  - [x] 8.3 Implement `GapClosureOutcomeRecord` emitter
    - Create `harness/gap-closure-outcomes/src/emit-outcome-record.ts`
    - Triggered by GitHub Actions `issues.closed` event
    - Read session log to extract `timeToFirstPrOpenMs`, `agentIterations`, `postDeployOutcome`, and `gapClosureOutcome`
    - Emit record to CloudWatch Logs at `/agent-harness/gap-closure-outcomes`
    - Handle `closeReason` values: `"merged"`, `"closed-without-merge"`, `"expired"` (past `expiryDays`)
    - _Requirements: 5.3_

  - [x] 8.4 Add CloudWatch Insights summary query
    - Create `docs/queries/scheduled-reviewer-summary.sh`
    - Query returns last N run records with finding counts and cost totals
    - _Requirements: 5.2_

- [x] 9. Implement the scheduled reviewer workflow
  - [x] 9.1 Create `harness/scheduled-reviewer/src/run.ts`
    - Invoke the reviewer agent as a standalone Strands `Agent` call (same tool catalogue as Task 1's reviewer: diff-read and reference-lookup only)
    - Write findings to `/tmp/reviewer-findings.json`
    - Check cost cap after invocation; exit non-zero if exceeded
    - _Requirements: 1.1, 1.2, 1.4, 5.5_

  - [x] 9.2 Create `scheduled-reviewer.yml` GitHub Actions workflow
    - Add `.github/workflows/scheduled-reviewer.yml`
    - Steps: check `fitnessGapLoop.enabled` flag (exit 0 if false), invoke reviewer via `node harness/scheduled-reviewer/run.js`, run auto-open via `node harness/auto-open/run.js --findings /tmp/reviewer-findings.json`, emit run record via `node harness/scheduled-reviewer/emit-run-record.js`
    - Cron schedule read from `agent-harness.config.json` at `fitnessGapLoop.schedule`; GitHub Actions variable as fallback
    - Permissions: `issues: write`, `contents: read`
    - No AWS deploy permissions; Bedrock invoke only
    - Workflow exits non-zero on any failure; no automatic retry
    - _Requirements: 1.1, 1.3, 1.4, 1.5_

- [x] 10. Extend IAM CDK definitions
  - [x] 10.1 Add read-only SNS/SQS/IAM describe permissions to the editor agent's IAM role
    - Modify the CDK IAM policy to add `sns:GetTopicAttributes`, `sqs:GetQueueAttributes`, `iam:SimulatePrincipalPolicy`, `iam:GetRolePolicy`, `iam:ListRolePolicies`, `iam:ListAttachedRolePolicies`
    - Scope to preview environment by tag (`aws:ResourceTag/agent-harness/env: preview`) except `iam:SimulatePrincipalPolicy` (scoped by `PolicySourceArn` in probe implementation)
    - Document the `iam:SimulatePrincipalPolicy` exception inline in the CDK definition
    - _Requirements: 4.3, 6.3_

- [x] 11. Update documentation
  - [x] 11.1 Extend the runbook with Task 2 failure modes
    - Add sections for: scheduled reviewer drift (detection query, first-move responses), auto-open duplication, gap-closure flakiness
    - Document drift thresholds (`findingCountDeltaThreshold`, `consecutiveRunsThreshold`)
    - _Requirements: 5.4, 7.3_

  - [x] 11.2 Update the README for Task 2
    - Describe both tasks and link to both specs
    - Document all Task 2 configuration knobs: schedule, severity threshold, auto-open labels, deduplication behaviour, gap-closure check selection
    - Add note that Task 2 requires tolerance for scheduled, autonomous issue creation
    - _Requirements: 7.1, 7.2, 7.4_

- [x] 12. Final checkpoint — Ensure all implementation is complete
  - Review all implementation, ask the user if questions arise.

## Notes

- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- The `fitnessGapLoop.enabled` flag is the single disable switch for all Task 2 behaviour; no code changes are required to disable it
- Task 1 (`feature-change-loop`) components are unchanged; all extensions are additive

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "2.2", "4.1", "5.1", "5.2", "5.3", "8.4", "10.1"] },
    { "id": 2, "tasks": ["2.3", "2.4", "2.5", "4.2", "5.4", "8.1", "8.2", "9.1"] },
    { "id": 3, "tasks": ["2.6", "5.5", "8.3", "9.2"] },
    { "id": 4, "tasks": ["7.1", "8.3"] },
    { "id": 5, "tasks": ["7.2"] },
    { "id": 6, "tasks": ["11.1", "11.2"] }
  ]
}
```
