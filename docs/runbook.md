# Runbook

Operational reference for the agent harness. Covers the failure modes observed during template development, diagnosis steps, and first-move responses.

Requirements: 10.4

---

## Contents

1. [Kill-switch invocation](#kill-switch-invocation)
2. [Restarting a halted session](#restarting-a-halted-session)
3. [Failure modes](#failure-modes)
   - [Oscillation](#oscillation)
   - [Post-deploy flakiness](#post-deploy-flakiness)
   - [Reviewer-vs-computational disagreement](#reviewer-vs-computational-disagreement)
   - [Preview teardown failure](#preview-teardown-failure)
   - [AgentCore session-storage unavailability](#agentcore-session-storage-unavailability)
   - [Scheduled reviewer drift](#scheduled-reviewer-drift)
   - [Auto-open duplication](#auto-open-duplication)
   - [Gap-closure flakiness](#gap-closure-flakiness)
4. [Cost guardrails](#cost-guardrails)

---

## Kill-switch invocation

The kill switch halts the in-flight loop immediately. The loop polls for the `agent-stop` label at the start of each stop-condition check; when the label is present, the loop terminates with reason `kill-switch` and opens a PR with the session log embedded.

### Via GitHub UI

1. Open the originating issue or the in-flight PR.
2. In the Labels panel, add the `agent-stop` label.
3. The `agent-stop.yml` workflow fires and comments on the issue/PR to confirm the signal was received.
4. The loop halts at its next stop-condition check (within the current iteration's tool calls).

### Via GitHub CLI (one-liner)

```bash
# Apply to an issue:
gh issue edit <number> --add-label agent-stop

# Apply to a pull request:
gh pr edit <number> --add-label agent-stop
```

### Via the helper script

```bash
npx ts-node scripts/agent-stop.ts --issue <number>
npx ts-node scripts/agent-stop.ts --pr <number>
```

The script requires the GitHub CLI (`gh`) to be installed and authenticated. If `gh` is not available, it prints the one-liner equivalent and exits non-zero.

---

## Restarting a halted session

A halted session (kill-switch, oscillation, iteration cap, wall-clock cap, or token cap) leaves a PR open with the termination reason in the banner. To restart:

1. Review the PR and the embedded session log to understand why the loop stopped.
2. If the issue is resolved (e.g., the oscillation was caused by a conflicting sensor rule that you've since updated), remove the `agent-stop` label from the originating issue (if present).
3. Re-apply the `agent-task` label to the originating issue.
4. The dispatch Action starts a new session. The new session references the previous PR in its payload metadata for context but does not inherit the previous session's iteration history.

Note: re-applying `agent-task` on a closed issue starts a new session only if no in-flight session exists for that issue. If a session is already in flight, the Action refuses to start a second one.

---

## Failure modes

### Oscillation

**Symptoms**

- The loop terminates with reason `oscillation` in the PR banner.
- The session log shows the same diff appearing twice in the last three iterations, or sensor results alternating between two states across the last four iterations.
- The PR body includes the oscillation detector trigger: `sameDiff` or `alternation`.

**Diagnosis**

1. Open the session log in the PR body.
2. Look at the last three to four iterations' edits and sensor outputs.
3. For `sameDiff`: the agent is producing the same change repeatedly. The sensor that's failing is likely giving feedback the agent cannot act on (e.g., a cdk-nag rule the agent doesn't know how to satisfy, or a reviewer finding that conflicts with the steering file).
4. For `alternation`: two sensors are disagreeing. Fixing one breaks the other. Common cause: a cdk-nag rule and a reviewer finding that require contradictory changes.

**First-move response**

1. Read the conflicting sensor outputs in the session log.
2. If the conflict is between cdk-nag and the reviewer: check whether the cdk-nag rule pack needs a suppression (with documented rationale) or whether the reviewer's checklist item needs refinement.
3. If the agent is stuck on a single sensor: check `modules/fanout/AGENTS.md` — the steering file may be missing guidance for the pattern the agent is trying to implement.
4. Update the steering file or add a cdk-nag suppression, then restart the session (remove and re-apply `agent-task`).

**Configuration**

Oscillation windows are in `agent-harness.config.json`:

```json
"oscillation": {
  "sameDiffWindow": 3,
  "alternationWindow": 4
}
```

Increase the windows to give the agent more room before declaring oscillation. Decrease them to halt faster on stuck loops.

---

### Post-deploy flakiness

**Symptoms**

- The loop terminates with reason `iteration-cap` or `wall-clock-cap` after repeatedly failing the post-deploy harness.
- The session log shows `postDeploy.outcome = "fail"` or `"partial"` across multiple iterations despite the computational sensors passing.
- CloudWatch logs from the preview environment show transient errors (throttling, cold-start timeouts, eventual-consistency delays).

**Diagnosis**

1. Open the session log and find the post-deploy harness reports.
2. Check the `report` field for the specific assertion that failed.
3. Check the CloudWatch logs linked in the report for the preview Lambda functions.
4. Distinguish between:
   - **Transient infrastructure flakiness**: the deployed system is correct but the harness caught a timing window (e.g., SQS message not yet visible, Lambda cold start exceeded the harness timeout).
   - **Genuine post-deploy failure**: the deployed system has a real defect the harness caught.

**First-move response**

For transient flakiness:
1. Check the post-deploy harness timeout and retry settings in `harness/post-deploy/`.
2. Increase the SQS visibility timeout or the harness's polling interval if the fan-out is taking longer than expected.
3. Restart the session. If the flakiness is intermittent, the next run may pass.

For genuine failure:
1. The session log contains the diff and the harness report. Read both.
2. The agent should have iterated on the failure; if it didn't converge, the issue is likely outside the agent's tool catalogue (e.g., an IAM misconfiguration the agent cannot observe).
3. Fix the issue manually, update the steering file with the pattern, and restart.

---

### Reviewer-vs-computational disagreement

**Symptoms**

- The loop terminates with reason `oscillation` (alternation variant).
- The session log shows the computational sensors passing but the reviewer finding a severity-above-threshold issue, or vice versa.
- The agent's edits oscillate between satisfying the reviewer and satisfying cdk-nag.

**Diagnosis**

1. Identify the specific cdk-nag rule and the specific reviewer finding that are in conflict.
2. Common patterns:
   - cdk-nag requires a specific resource property; the reviewer flags the same property as insufficient.
   - The reviewer's checklist item references a Well-Architected best practice that cdk-nag's rule pack doesn't cover (or covers differently).
   - The steering file (`AGENTS.md`) gives guidance that conflicts with one of the sensors.

**First-move response**

1. If the reviewer is correct and cdk-nag is too permissive: add a custom cdk-nag rule or tighten the existing rule pack configuration.
2. If cdk-nag is correct and the reviewer is over-flagging: refine the reviewer's checklist item in `agents/reviewer/checklists/` to be more specific about what it's looking for.
3. If the steering file is the source of conflict: update `modules/fanout/AGENTS.md` to resolve the ambiguity.
4. After updating, restart the session.

**Changing the reviewer severity threshold**

The threshold is in `agent-harness.config.json`:

```json
"sensors": {
  "reviewerSeverityThreshold": "MEDIUM"
}
```

Raising the threshold to `HIGH` means only HIGH and CRITICAL findings block the loop. Lowering it to `LOW` means any finding above INFO blocks. Adjust based on your team's risk tolerance.

---

### Preview teardown failure

**Symptoms**

- The `preview-teardown.yml` workflow fails on PR close.
- The PR has a comment: "Preview teardown failed."
- The CloudFormation stack `FanoutPreview-<session-id>` is still present in the AWS console.

**Diagnosis**

1. Check the `preview-teardown.yml` workflow run logs in GitHub Actions.
2. Common causes:
   - The IAM role used by the runner (`AWS_EDITOR_ROLE_ARN`) has expired credentials or insufficient permissions.
   - The CloudFormation stack has a resource in `DELETE_FAILED` state (usually a non-empty S3 bucket or a Lambda with a pending invocation).
   - The session id could not be extracted from the PR body (the PR body was edited or the format changed).

**First-move response**

1. Check the workflow logs for the specific error.
2. For `DELETE_FAILED` resources: open the AWS CloudFormation console, find the stack, and manually delete the stuck resource before retrying the stack deletion.
3. For IAM errors: verify `AWS_EDITOR_ROLE_ARN` is set correctly in the repository secrets and that the role has `cloudformation:DeleteStack` on the preview stack ARN pattern.
4. For session-id extraction failure: manually run the sweep script:

```bash
npx ts-node scripts/sweep-previews.ts --dry-run   # verify the stack appears
npx ts-node scripts/sweep-previews.ts              # destroy it
```

**Scheduled sweep as backstop**

The `preview-sweep.yml` workflow runs every 6 hours and destroys any preview stack older than `preview.sweepMaxAgeHours` (default 24 hours). A teardown failure on PR close will be caught by the next sweep run. Check the sweep workflow logs if stacks persist beyond 24 hours.

**Manual teardown**

```bash
# List preview stacks
aws cloudformation describe-stacks \
  --query "Stacks[?Tags[?Key=='agent-harness/env' && Value=='preview']].[StackName,StackStatus,CreationTime]" \
  --output table

# Destroy a specific stack
aws cloudformation delete-stack --stack-name FanoutPreview-<session-id>
aws cloudformation wait stack-delete-complete --stack-name FanoutPreview-<session-id>
```

---

### AgentCore session-storage unavailability

**Symptoms**

- The dispatch Action (`dispatch-agent-task.yml`) comments on the issue with an error like "AgentCore session storage unavailable" or "Failed to create session."
- The loop does not start.
- Subsequent re-triggers also fail.

**Diagnosis**

1. Check the GitHub Actions workflow run logs for the HTTP error code from the AgentCore endpoint.
2. Check the [AWS Service Health Dashboard](https://health.aws.amazon.com/) for the configured region (`agentcore.regionalRouting` in `agent-harness.config.json`).
3. Common causes:
   - Transient AgentCore service disruption.
   - The AgentCore endpoint URL in `agent-harness.config.json` is stale or misconfigured.
   - The GitHub Action runner role (`AWS_EDITOR_ROLE_ARN`) lacks `bedrock:InvokeAgent` permission on the configured agent ARN.

**First-move response**

1. For transient disruptions: wait for the service to recover, then re-apply the `agent-task` label to restart.
2. For endpoint misconfiguration: update `agentcore.endpoint` in `agent-harness.config.json` with the correct endpoint URL from the AgentCore console.
3. For IAM errors: verify the GitHub Action runner role has `bedrock:InvokeAgent` on the agent ARN. The IAM policy is in `infrastructure/iam-stack.ts` (`GitHubActionRunnerRole`).
4. If the session was partially created before the failure: check the AgentCore console for orphaned sessions. Orphaned sessions do not block new sessions for the same issue (the Action checks for in-flight sessions by status, not by existence).

**Fail-closed behaviour**

The design biases toward "fail closed and halt" rather than "soldier on with degraded checks." A session-storage failure halts the loop and surfaces the error on the issue. The human operator picks up from there. This is intentional: a loop that continues without durable session state cannot be audited or restarted coherently.

---

### Scheduled reviewer drift

Requirements: 5.4, 7.3

**Symptoms**

- A sudden jump in finding count across consecutive scheduled reviewer runs (e.g., 2 findings one day, 12 the next) with no corresponding large refactor on `main`.
- Repeated identical findings that never close: the same finding appears in every run summary but the auto-opened issue remains open and the agent has not converged on a fix.

**Detection**

Use the CloudWatch Insights summary script to inspect recent runs:

```bash
# Last 10 runs (default)
./docs/queries/scheduled-reviewer-summary.sh

# Last 20 runs
./docs/queries/scheduled-reviewer-summary.sh 20
```

See [Scheduled reviewer observability](#scheduled-reviewer-observability) for full query usage and the complete pattern table.

**Drift thresholds**

Two thresholds in `agent-harness.config.json` govern when drift is flagged:

```json
"fitnessGapLoop": {
  "drift": {
    "findingCountDeltaThreshold": 5,
    "consecutiveRunsThreshold": 3
  }
}
```

- `findingCountDeltaThreshold` (default `5`): a run-over-run increase in finding count that meets or exceeds this value is treated as a potential drift event and logged at `WARN` level.
- `consecutiveRunsThreshold` (default `3`): if the same finding signature appears in this many consecutive runs without a corresponding closed issue, the run record is flagged as `driftSuspected: true`.

**First-move responses**

| Pattern | First-move response |
|---|---|
| Sudden jump in finding count | Compare the finding list between the last two runs using the summary script. Check whether a model update changed reviewer sensitivity (`models.reviewer` in `agent-harness.config.json`) or whether a large refactor landed on `main` since the previous run. |
| Repeated identical findings that never close | Open the auto-opened issue and read the session log. Check for oscillation (the agent may be stuck). Update the steering file or checklist item if the agent lacks guidance for the pattern. See [Oscillation](#oscillation) for the full diagnosis flow. |
| `driftSuspected: true` in run records | Treat as one of the two patterns above. The flag is informational; it does not halt the loop. |

---

### Auto-open duplication

Requirements: 7.3

**Symptoms**

- Multiple open GitHub issues exist for the same fitness-gap finding (same file path, same severity, same suggested fix).
- The duplicate issues carry both `agent-task` and `triage:fitness-gap` labels, indicating they were auto-opened rather than human-opened.

**Cause**

The deduplication check queries the GitHub Issues API for open issues whose body contains the finding's content-derived signature. If the API call fails (rate limit, transient network error, or permissions error), the auto-open mechanism falls back conservatively and opens the issue rather than silently dropping it. This means a GitHub API error during the dedup check produces a duplicate.

**First-move response**

1. Identify the duplicate: the older issue is the canonical one; the newer issue is the duplicate. Check the `<!-- auto-opened: <run-id> -->` marker in each issue body to confirm which run produced which issue.
2. Close the duplicate issue manually with a comment referencing the canonical issue number (e.g., "Duplicate of #42, closed manually after dedup check failure").
3. Check the GitHub Actions workflow run logs for the scheduled reviewer run that produced the duplicate. Look for a log line containing `dedupCheckError` or an HTTP error code from the GitHub Issues API.
4. If the error was transient (rate limit, 5xx), no further action is needed — the next run will dedup correctly.
5. If the error recurs, verify that the GitHub Actions runner has `issues: write` permission in the workflow's `permissions` block and that the `GITHUB_TOKEN` has not been scoped down in the repository settings.

**Configuration reference**

```json
"fitnessGapLoop": {
  "autoOpen": {
    "duplicateAction": "comment"
  }
}
```

`duplicateAction: "comment"` (default) means a duplicate finding adds a comment to the existing issue rather than opening a new one. A duplicate issue appearing in the wild means this check was bypassed due to an API error.

---

### Gap-closure flakiness

Requirements: 7.3

**Symptoms**

- The post-deploy harness reports `probeError` for a gap-closure check on consecutive runs, even though the code change looks correct and the preview stack deployed successfully.
- The agent iterates without converging: each iteration's session log shows `gapClosure.outcome = "probeError"` rather than `"pass"` or `"fail"`.

**Causes**

| Cause | How to identify |
|---|---|
| Transient AWS API throttling | `probeError` message contains `ThrottlingException` or `RequestLimitExceeded`; the error is intermittent across runs |
| Eventual consistency after deploy | `probeError` appears on the first 1–2 iterations after a fresh deploy but clears on retry; CloudFormation shows `CREATE_COMPLETE` but the resource's attributes are not yet fully propagated |
| Missing or incomplete stack outputs | `probeError` message contains `OutputKey not found` or `undefined`; the CDK stack does not export the ARN or attribute the probe needs |

**First-move response**

1. Open the session log in the PR body and find the `gapClosure` section. Read the `probeError` field for the specific error message — this is the fastest way to distinguish the three causes above.
2. **For throttling**: wait for the current iteration to complete, then restart the session (remove and re-apply `agent-task`). If throttling is persistent, check whether other processes in the same AWS account are consuming the same API quota.
3. **For eventual consistency**: the harness has a built-in retry with backoff for gap-closure probes. If `probeError` persists beyond 3 retries, check the CloudFormation stack events in the AWS console to confirm the resource reached a stable state. Increase the probe retry delay in `harness/gap-closure/` if the resource consistently takes longer to stabilise.
4. **For missing stack outputs**: the CDK stack must export the ARN or attribute the probe expects. Check the probe definition in `harness/gap-closure/` to see which output key it reads, then verify the CDK stack exports that key. Add the missing `CfnOutput` to the stack and redeploy.

**Verifying stack outputs manually**

```bash
aws cloudformation describe-stacks \
  --stack-name FanoutPreview-<session-id> \
  --query "Stacks[0].Outputs" \
  --output table
```

Confirm the expected ARNs (SNS topic ARN, SQS queue URL, Lambda execution role ARN) appear in the output. If any are missing, the gap-closure probe cannot run and will return `probeError`.

---

## Scheduled reviewer observability

### Summarising recent reviewer runs

Use the CloudWatch Insights summary script to get a table of the last N scheduled reviewer runs with finding counts and cost totals:

```bash
# Last 10 runs (default)
./docs/queries/scheduled-reviewer-summary.sh

# Last 20 runs
./docs/queries/scheduled-reviewer-summary.sh 20

# Different region
./docs/queries/scheduled-reviewer-summary.sh 10 --region eu-west-1
```

The script queries the `/agent-harness/scheduled-reviewer` log group and prints a table with columns: Run ID, Timestamp, Outcome, Issues opened, Duplicates skipped, Cost (USD), and Findings by severity.

**Prerequisites:** AWS CLI v2 configured with `logs:StartQuery` and `logs:GetQueryResults` permissions. Python 3 must be available on the PATH.

### Signs of reviewer drift

Watch for these patterns in the summary output:

| Pattern | Likely cause | First-move response |
|---|---|---|
| Sudden jump in finding count across runs | Model update changed reviewer sensitivity, or a large refactor landed on `main` | Compare the finding list between runs; check if the same findings repeat |
| Repeated identical findings that never close | Agent cannot satisfy the finding (tool gap, conflicting sensor, or IAM scope issue) | Read the session log on the auto-opened issue; check for oscillation; update the steering file or checklist |
| `outcome: failure` on consecutive runs | Bedrock unavailability, cost cap exceeded, or permissions error | Check the GitHub Actions workflow run logs; verify `reviewerTokenSpendCapUSD` in `agent-harness.config.json` |
| `issuesOpened: 0` with many findings | Severity threshold too high, or all findings are duplicates | Check `fitnessGapLoop.autoOpen.severityThreshold`; check for stale open issues blocking deduplication |
| Rising `tokenCostUSD` per run | Model version change or growing codebase | Review `fitnessGapLoop.costGuardrail.reviewerTokenSpendCapUSD`; consider scoping the reviewer to changed files only |

---

## Cost guardrails

See `docs/cost-envelope.md` for measured cost ranges per trigger.

Quick reference for setting guardrails:

**Token spend cap** (per trigger, in USD):

```json
"limits": {
  "tokenSpendCapUSD": 10.0
}
```

The loop halts with reason `token-cap` when `editorTokensUSD + reviewerTokensUSD >= tokenSpendCapUSD`. Adjust based on your measured costs from `docs/cost-envelope.md`.

**CloudWatch billing alarm** (recommended):

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name "AgentHarness-MonthlyBudget" \
  --metric-name EstimatedCharges \
  --namespace AWS/Billing \
  --statistic Maximum \
  --period 86400 \
  --threshold 50 \
  --comparison-operator GreaterThanThreshold \
  --dimensions Name=ServiceName,Value=AmazonBedrock \
  --evaluation-periods 1 \
  --alarm-actions <your-sns-topic-arn>
```

Replace `50` with your monthly budget threshold in USD.
