# Design Document

## Overview

This design covers Task 2 of the agent harness template: the fitness-gap loop. Task 2 extends Task 1 (`feature-change-loop`) with four additions: a scheduled reviewer workflow that runs the inferential reviewer on a cron schedule, an auto-open mechanism that turns findings above a severity threshold into `agent-task`-labelled GitHub issues, a trigger payload extension that distinguishes `fitness-gap` triggers from `feature-change` triggers, and a gap-closure check in the post-deploy harness that verifies the originating finding is no longer exhibited by the deployed preview environment.

**What is reused from Task 1 without change:**

- Editor agent (Strands `Agent`, tool catalogue, system prompt, session contract)
- Reviewer agent (Strands `Agent`, tool catalogue, system prompt)
- Bounded loop runner (`harness/loop/`)
- Engineering harness (computational sensors, inferential reviewer wrapper, post-deploy harness runner)
- Runtime harness boundary (AgentCore sessions, IAM model, tool wrappers)
- Trigger surface (`dispatch-agent-task.yml` GitHub Action — extended but not replaced)
- Operational contract (kill switch, teardown, cost guards, runbook — extended but not replaced)

**What Task 2 adds:**

- `scheduled-reviewer.yml` GitHub Actions workflow (new file)
- Auto-open mechanism (`harness/auto-open/`) — new package
- `triggerType: "fitness-gap"` branch in `dispatch-agent-task.yml`
- `originatingFinding` field in the AgentCore trigger payload
- Gap-closure check (`harness/post-deploy/gap-closure/`) — new sub-module
- Observability additions: `ScheduledReviewerRunRecord`, `GapClosureOutcomeRecord`
- Configuration additions to `agent-harness.config.json`

Task 2 is disable-able via a single flag (`fitnessGapLoop.enabled`). When `false`, the scheduled reviewer workflow exits immediately, the auto-open mechanism is a no-op, and the gap-closure check is skipped. No code changes are required to disable Task 2 in a fork.

## Architecture

### Component overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ GitHub repository                                                            │
│                                                                              │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ scheduled-reviewer.yml (NEW)                                             │ │
│ │ - on: schedule (cron, configurable)                                      │ │
│ │ - reads fitnessGapLoop.enabled; exits 0 if false                        │ │
│ │ - invokes reviewer agent against main                                    │ │
│ │ - calls auto-open mechanism with findings                                │ │
│ │ - emits ScheduledReviewerRunRecord                                       │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ dispatch-agent-task.yml (EXTENDED — Task 1 behaviour unchanged)          │ │
│ │ - detects triage:fitness-gap label on agent-task issues                  │ │
│ │ - sets triggerType = "fitness-gap" and adds originatingFinding           │ │
│ │ - falls back to triggerType = "feature-change" when label absent         │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ Auto-opened issues (NEW)                                                 │ │
│ │ - labels: agent-task + triage:fitness-gap                                │ │
│ │ - body: structured finding + run metadata + auto-open marker             │ │
│ │ - deduplication: content-signature check before open                     │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
            │ HTTPS POST (signed) — same as Task 1
            v
┌──────────────────────────────────────────────────────────────────────────────┐
│ AWS account (template account)                                               │
│                                                                              │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ AgentCore Harness (UNCHANGED)                                            │ │
│ │ ┌────────────────────────────────────────────────────────────────────┐   │ │
│ │ │ Session — extended with originatingFinding and gapClosure fields   │   │ │
│ │ └────────────────────────────────────────────────────────────────────┘   │ │
│ │ ┌────────────────────────────────────────────────────────────────────┐   │ │
│ │ │ Editor agent (UNCHANGED)                                           │   │ │
│ │ └────────────────────────────────────────────────────────────────────┘   │ │
│ │ ┌────────────────────────────────────────────────────────────────────┐   │ │
│ │ │ Reviewer agent (UNCHANGED — reused by scheduled workflow)          │   │ │
│ │ └────────────────────────────────────────────────────────────────────┘   │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ Post-deploy harness (EXTENDED)                                           │ │
│ │ - existing smoke test + fan-out check (UNCHANGED)                        │ │
│ │ - gap-closure check (NEW, runs only on fitness-gap triggers)             │ │
│ │   - SNS HTTPS-only probe (GetTopicAttributes)                            │ │
│ │   - SQS encryption-at-rest probe (GetQueueAttributes)                   │ │
│ │   - IAM scoping probe (GetRolePolicy / SimulatePrincipalPolicy)          │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ Preview environment (UNCHANGED)                                          │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

### New vs. reused components

| Component | Status | Notes |
|---|---|---|
| `scheduled-reviewer.yml` | **New** | Cron-driven workflow; invokes reviewer, calls auto-open |
| `harness/auto-open/` | **New** | Issue creation, deduplication, label enforcement |
| `dispatch-agent-task.yml` | **Extended** | Adds `triage:fitness-gap` detection; Task 1 path unchanged |
| `harness/post-deploy/gap-closure/` | **New** | Three probe implementations; dispatched by trigger type |
| `agents/editor/` | Unchanged | No new tools; no system prompt changes |
| `agents/reviewer/` | Unchanged | Reused as-is by scheduled workflow |
| `harness/loop/` | Unchanged | Bounded loop runner; reads `triggerType` from session |
| `agent-harness.config.json` | **Extended** | New `fitnessGapLoop` section |
| IAM CDK definitions | **Extended** | Adds read-only SNS/SQS/IAM describe permissions |

### Layering

Task 2 preserves the runtime/engineering split from Task 1:

- *Runtime harness layer:* AgentCore (sessions, orchestration, sandbox) — unchanged. The session schema gains two optional fields (`originatingFinding`, `gapClosure`) that are null for `feature-change` triggers.
- *Engineering harness layer:* the scheduled reviewer workflow, the auto-open mechanism, the gap-closure check, and the observability additions are all engineering-harness work. They encode what this team considers a fitness gap and how to verify closure.

The seam between the two layers is the same as Task 1: IAM policies and tool catalogue declarations. Task 2 adds read-only describe permissions to the IAM policy; it does not add any new tools to the editor's catalogue.

## Components and Interfaces

### Scheduled reviewer workflow (Requirement 1)

**File:** `.github/workflows/scheduled-reviewer.yml`

```yaml
name: Scheduled reviewer

on:
  schedule:
    - cron: ${{ vars.SCHEDULED_REVIEWER_CRON || '0 6 * * *' }}  # default: 06:00 UTC daily
  workflow_dispatch:  # manual trigger for testing

jobs:
  review:
    name: Run inferential reviewer against main
    runs-on: ubuntu-latest
    permissions:
      issues: write      # auto-open issues
      contents: read     # checkout repo

    steps:
      - name: Check enabled flag
        id: enabled
        run: |
          ENABLED=$(jq -r '.fitnessGapLoop.enabled' agent-harness.config.json)
          echo "enabled=${ENABLED}" >> "$GITHUB_OUTPUT"
          if [ "$ENABLED" != "true" ]; then
            echo "fitnessGapLoop.enabled is false — exiting."
            exit 0
          fi

      - name: Invoke reviewer agent
        # Calls the same reviewer agent as Task 1 via a standalone runner
        # (not via AgentCore; the reviewer does not need session state here)
        run: node harness/scheduled-reviewer/run.js

      - name: Run auto-open mechanism
        run: node harness/auto-open/run.js --findings /tmp/reviewer-findings.json

      - name: Emit run record
        run: node harness/scheduled-reviewer/emit-run-record.js
```

**Isolation guarantee:** The scheduled reviewer invokes the reviewer agent as a standalone Strands `Agent` call with the same tool catalogue as Task 1's reviewer (diff-read and reference-lookup only). No edit or deploy tools are registered. The workflow has no AWS deploy permissions; it only needs GitHub issue-write and Bedrock invoke.

**Failure behaviour:** The workflow exits non-zero on any failure (model unavailable, timeout, permissions error). GitHub Actions surfaces this as a failed workflow run visible to maintainers. There is no automatic retry; a human must re-run the workflow manually. This satisfies Requirement 1.5's "no silent indefinite retry" constraint.

**Schedule configuration:** The cron expression is read from `agent-harness.config.json` at `fitnessGapLoop.schedule`. The workflow uses a GitHub Actions variable as a fallback so the schedule can be overridden without a config file change. The single documented location is `agent-harness.config.json`.

### Auto-open mechanism (Requirement 2)

**Package:** `harness/auto-open/`

The auto-open mechanism is a standalone TypeScript module invoked by the scheduled reviewer workflow after the reviewer produces findings. It is not part of the editor agent's loop and adds no tools to the editor's catalogue.

**Deduplication by content signature:**

A content signature is a deterministic hash of the finding's stable fields: `pillar`, `id`, `file` (if present), and `description`. The signature is computed with SHA-256 and truncated to 16 hex characters. It is embedded in the issue body as an HTML comment:

```html
<!-- agent-harness:finding-signature:a3f7c2d1e8b94f20 -->
```

Before opening an issue, the mechanism queries open issues with the `triage:fitness-gap` label and scans their bodies for this marker. If a match is found, no new issue is opened. If `fitnessGapLoop.autoOpen.duplicateAction` is `"comment"` (the default), a comment is added to the existing issue recording the new run's date and finding count. If `"skip"`, no action is taken.

**Label policy:**

The mechanism always applies both `agent-task` and `triage:fitness-gap` in a single API call. It never applies `agent-task` alone. This is enforced in the wrapper, not by convention.

**Issue body template:**

```markdown
<!-- agent-harness:auto-opened:true -->
<!-- agent-harness:finding-signature:<signature> -->

## Architecture fitness gap: <finding.id> — <finding.description>

**Severity:** <finding.severity>
**Pillar:** <finding.pillar>
**File:** <finding.file>:<finding.line>

### Finding

<finding.description>

### Suggested fix

<finding.suggestedFix>

### Reviewer run

- **Run ID:** <runId>
- **Date:** <runDate>
- **Model:** <modelId>

---
*This issue was opened automatically by the scheduled inferential reviewer.
Apply the `agent-task` label to dispatch the editing agent.*
```

Note: the issue body does not include `agent-task` in the auto-open step. The label is applied separately so maintainers can review auto-opened issues before dispatching the agent. This is consistent with the post's description of the trigger surface as human-controlled.

**Severity threshold:** Findings are filtered against `fitnessGapLoop.autoOpen.severityThreshold` (default: `"HIGH"`). Findings at or above the threshold are candidates for issue creation. The threshold comparison uses the same severity ordering as the reviewer: `info < low < medium < high < critical`.

**Interface:**

```ts
interface AutoOpenInput {
  findings: ReviewerFinding[];
  runId: string;
  runDate: string;
  modelId: string;
}

interface AutoOpenResult {
  opened: number;
  skipped: number;   // duplicates
  commented: number; // comments added to existing issues
  errors: Array<{ finding: ReviewerFinding; error: string }>;
}

function autoOpenIssues(input: AutoOpenInput): Promise<AutoOpenResult>;
```

### Trigger payload extension (Requirement 3)

The `dispatch-agent-task.yml` Action is extended with a label-detection step that runs before the payload-build step. The Task 1 path is unchanged; the extension is additive.

**Label detection step (inserted after step 3 "Validate required fields"):**

```bash
# Detect triage:fitness-gap label
LABELS=$(gh api "/repos/${REPO}/issues/${ISSUE_NUMBER}/labels" --jq '[.[].name]')
HAS_FITNESS_GAP=$(echo "$LABELS" | jq 'any(. == "triage:fitness-gap")')

if [ "$HAS_FITNESS_GAP" = "true" ]; then
  TRIGGER_TYPE="fitness-gap"
  # Extract the finding signature from the issue body
  FINDING_SIGNATURE=$(grep -oP '(?<=agent-harness:finding-signature:)[a-f0-9]+' /tmp/issue_body.txt || echo "")
else
  TRIGGER_TYPE="feature-change"
  FINDING_SIGNATURE=""
fi
```

**Extended payload (fitness-gap trigger):**

```jsonc
{
  "schemaVersion": "1.0",
  "triggerType": "fitness-gap",
  "issue": { /* same as Task 1 */ },
  "module": { /* same as Task 1 */ },
  "session": { /* same as Task 1 */ },
  "limits": { /* same as Task 1 */ },
  "auth": { /* same as Task 1 */ },
  "originatingFinding": {
    "signature": "a3f7c2d1e8b94f20",
    "id": "WA-SEC-02",
    "pillar": "Security",
    "severity": "high",
    "description": "SNS topic does not enforce HTTPS-only",
    "file": "modules/fanout/lib/fanout-stack.ts",
    "line": 42,
    "suggestedFix": "Add an SNS topic policy that denies non-HTTPS subscriptions",
    "runId": "scheduled-reviewer-run-2025-01-15T06:00:00Z",
    "runDate": "2025-01-15T06:00:00Z"
  }
}
```

For `feature-change` triggers, `originatingFinding` is absent from the payload (not null, absent). The session schema treats it as optional; the gap-closure check reads it only when `triggerType === "fitness-gap"`.

**Backward compatibility:** The `schemaVersion` field remains `"1.0"`. The `originatingFinding` field is additive; existing consumers that do not read it are unaffected. If a future schema change is breaking, `schemaVersion` is bumped.

### Gap-closure check (Requirement 4)

**Package:** `harness/post-deploy/gap-closure/`

The gap-closure check is a sub-module of the existing post-deploy harness. It is dispatched by the post-deploy runner when `triggerType === "fitness-gap"`. For `feature-change` triggers, the dispatcher skips it entirely; the existing smoke test and fan-out check run unchanged.

**Dispatch logic in the post-deploy runner:**

```ts
async function runPostDeploy(input: PostDeployInput): Promise<PostDeployOutput> {
  // Existing checks (unchanged)
  const smokeResult = await runSmokeTest(input);
  const fanoutResult = await runFanoutCheck(input);

  // Gap-closure check (new, conditional)
  let gapClosureResult: GapClosureResult | null = null;
  if (input.triggerType === "fitness-gap" && input.originatingFinding) {
    gapClosureResult = await runGapClosureCheck(
      input.originatingFinding,
      input.stackOutputs,
    );
  }

  return buildPostDeployOutput(smokeResult, fanoutResult, gapClosureResult);
}
```

**Three probe implementations:**

Each probe calls AWS APIs directly against the deployed preview environment. The probes do not read source code or synthesised CloudFormation; they describe the live resource.

*1. SNS HTTPS-only probe (`gap-closure/probes/sns-https-only.ts`):*

```ts
async function probeSnsHttpsOnly(topicArn: string): Promise<GapClosureResult> {
  const attrs = await sns.getTopicAttributes({ TopicArn: topicArn }).promise();
  const policy = JSON.parse(attrs.Attributes?.Policy ?? "{}");
  const hasDenyHttp = policyDeniesHttp(policy);
  return {
    gapId: "WA-SEC-02",
    closed: hasDenyHttp,
    evidence: { topicArn, policyStatements: policy.Statement ?? [] },
    probeMethod: "sns:GetTopicAttributes",
  };
}
```

*2. SQS encryption-at-rest probe (`gap-closure/probes/sqs-encryption.ts`):*

```ts
async function probeSqsEncryption(queueUrl: string): Promise<GapClosureResult> {
  const attrs = await sqs.getQueueAttributes({
    QueueUrl: queueUrl,
    AttributeNames: ["KmsMasterKeyId", "SqsManagedSseEnabled"],
  }).promise();
  const encrypted =
    !!attrs.Attributes?.KmsMasterKeyId ||
    attrs.Attributes?.SqsManagedSseEnabled === "true";
  return {
    gapId: "WA-REL-04",
    closed: encrypted,
    evidence: { queueUrl, attributes: attrs.Attributes ?? {} },
    probeMethod: "sqs:GetQueueAttributes",
  };
}
```

*3. IAM scoping probe (`gap-closure/probes/iam-scoping.ts`):*

```ts
async function probeIamScoping(roleArn: string): Promise<GapClosureResult> {
  // SimulatePrincipalPolicy checks whether the role can perform
  // actions beyond its intended scope (e.g., s3:* on *)
  const simulation = await iam.simulatePrincipalPolicy({
    PolicySourceArn: roleArn,
    ActionNames: ["s3:DeleteObject", "s3:PutBucketPolicy"],
    ResourceArns: ["*"],
  }).promise();
  const hasOverpermission = simulation.EvaluationResults?.some(
    (r) => r.EvalDecision === "allowed",
  ) ?? false;
  return {
    gapId: "WA-SEC-05",
    closed: !hasOverpermission,
    evidence: { roleArn, evaluationResults: simulation.EvaluationResults ?? [] },
    probeMethod: "iam:SimulatePrincipalPolicy",
  };
}
```

**Probe dispatch by finding ID:**

The gap-closure check reads `originatingFinding.id` and dispatches to the matching probe. Unknown IDs return a `GapClosureResult` with `closed: false` and a `probeMethod: "unknown"` marker, which the post-deploy runner treats as a partial outcome.

**Integration with the session:**

When the gap-closure check fails, the result is written to the session's `postDeploy` field with `outcome: "fail"` and the `GapClosureResult` embedded in `report.gapClosure`. This is the same shape as other post-deploy failures; the editor agent reads it as context for the next iteration.

When the gap-closure check passes and all other post-deploy checks pass, the PR body includes a gap-closure section (see PR body section below).

### PR body extension (Requirement 4.5)

The success PR body template gains a conditional section for `fitness-gap` triggers. The editor's `buildSuccessPRBody` function reads `session.trigger.triggerType` and `session.gapClosure` to populate it.

```markdown
## Gap closure

**Originating finding:** <originatingFinding.id> — <originatingFinding.description>
**Severity:** <originatingFinding.severity>
**Pillar:** <originatingFinding.pillar>

### Verification

The gap-closure check probed the deployed preview environment directly:

| Check | Method | Result |
|---|---|---|
| <gapId> | <probeMethod> | ✅ Closed |

**Evidence:** <summary of probe evidence, e.g. "SNS topic policy contains Deny on aws:SecureTransport=false">

*Verified against preview environment `<stackOutputs.previewEnvId>` at <timestamp>.*
```

This section is omitted entirely for `feature-change` triggers.

### Observability additions (Requirement 5)

**Run record (`ScheduledReviewerRunRecord`):**

Emitted to CloudWatch Logs (log group `/agent-harness/scheduled-reviewer`) after every scheduled reviewer invocation, success or failure.

```ts
interface ScheduledReviewerRunRecord {
  schemaVersion: "1.0";
  runId: string;           // "scheduled-reviewer-run-<iso-timestamp>"
  timestamp: string;       // ISO-8601
  modelId: string;
  modelVersion: string;
  outcome: "success" | "failure";
  failureReason?: string;
  findingsBySeverity: Record<string, number>;  // { high: 2, critical: 1 }
  issuesOpened: number;
  duplicatesSkipped: number;
  tokenCostUSD: number;
}
```

**Outcome record (`GapClosureOutcomeRecord`):**

Emitted when an auto-opened issue closes (merged, closed without merge, or expired past `fitnessGapLoop.autoOpen.expiryDays`). The GitHub Actions `issues.closed` event triggers a lightweight workflow that reads the issue's session log and emits the record.

```ts
interface GapClosureOutcomeRecord {
  schemaVersion: "1.0";
  issueNumber: number;
  findingSignature: string;
  findingId: string;
  openedAt: string;
  closedAt: string;
  closeReason: "merged" | "closed-without-merge" | "expired";
  timeToFirstPrOpenMs: number | null;
  agentIterations: number | null;
  postDeployOutcome: "pass" | "fail" | "partial" | "deploy-failure" | null;
  gapClosureOutcome: "closed" | "not-closed" | "not-checked" | null;
}
```

**Cost guardrail:**

The scheduled reviewer workflow checks token cost after the reviewer invocation. If `tokenCostUSD > fitnessGapLoop.costGuardrail.reviewerTokenSpendCapUSD`, the workflow exits non-zero before the auto-open step, emitting a run record with `outcome: "failure"` and `failureReason: "cost-cap-exceeded"`. This is a hard stop, not a warning.

**Summary query:**

`docs/queries/scheduled-reviewer-summary.sh` — a CloudWatch Insights query that returns the last N run records with finding counts and cost totals. Documented in the runbook.

## Data Models

### `agent-harness.config.json` additions

The `fitnessGapLoop` section is added to the existing config file. All other sections are unchanged.

```jsonc
{
  // ... existing Task 1 fields unchanged ...

  "fitnessGapLoop": {
    "enabled": true,
    "schedule": "0 6 * * *",                    // cron; default 06:00 UTC daily
    "autoOpen": {
      "severityThreshold": "HIGH",              // HIGH | CRITICAL | MEDIUM | LOW
      "labels": ["agent-task", "triage:fitness-gap"],
      "duplicateAction": "comment",             // "comment" | "skip"
      "expiryDays": 30                          // days before an open issue is considered expired
    },
    "gapClosureChecks": {
      "enabled": true,
      "probes": ["sns-https-only", "sqs-encryption", "iam-scoping"]
    },
    "costGuardrail": {
      "reviewerTokenSpendCapUSD": 2.0           // per scheduled run
    }
  }
}
```

The `fitnessGapLoop.enabled` flag is the single disable switch for all Task 2 behaviour. Setting it to `false` causes:

1. `scheduled-reviewer.yml` to exit 0 immediately after the enabled check.
2. `dispatch-agent-task.yml` to treat all issues as `feature-change` regardless of labels.
3. The post-deploy harness to skip the gap-closure check.

No code changes are required.

### `OriginatingFinding`

The shape of the `originatingFinding` field in the trigger payload and in the session.

```ts
interface OriginatingFinding {
  /** Content-derived signature (SHA-256, 16 hex chars). */
  signature: string;
  /** Checklist item id, e.g. "WA-SEC-02". */
  id: string;
  /** Well-Architected pillar, e.g. "Security". */
  pillar: string;
  /** Severity at the time the finding was produced. */
  severity: "info" | "low" | "medium" | "high" | "critical";
  /** One or two sentences naming the gap. */
  description: string;
  /** Path inside the module, when locatable. */
  file?: string;
  /** 1-indexed line in file, when locatable. */
  line?: number;
  /** One-line note describing the suggested fix. */
  suggestedFix: string;
  /** Identifier of the scheduled reviewer run that produced this finding. */
  runId: string;
  /** ISO-8601 timestamp of the run. */
  runDate: string;
}
```

### `GapClosureResult`

The output of a single gap-closure probe.

```ts
interface GapClosureResult {
  /** Finding id this probe checked, e.g. "WA-SEC-02". */
  gapId: string;
  /** Whether the gap is no longer exhibited in the deployed environment. */
  closed: boolean;
  /** Raw evidence from the AWS API call (for PR body and session log). */
  evidence: Record<string, unknown>;
  /** AWS API method used to probe, e.g. "sns:GetTopicAttributes". */
  probeMethod: string;
  /** Error message if the probe itself failed (distinct from gap not closed). */
  probeError?: string;
}
```

### `ScheduledReviewerRunRecord`

Defined in the Observability section above. Stored in CloudWatch Logs at `/agent-harness/scheduled-reviewer`.

### `GapClosureOutcomeRecord`

Defined in the Observability section above. Stored in CloudWatch Logs at `/agent-harness/gap-closure-outcomes`.

### Session contract extension

The session schema gains two optional top-level fields. Both are `null` for `feature-change` triggers.

```jsonc
{
  "schemaVersion": "1.0",
  "trigger": {
    // ... existing fields ...
    "originatingFinding": { /* OriginatingFinding | null */ }
  },
  "iterations": [
    {
      // ... existing fields ...
      "postDeploy": {
        "outcome": "pass" | "fail" | "partial" | "deploy-failure",
        "report": {
          // ... existing report fields ...
          "gapClosure": { /* GapClosureResult | null */ }
        }
      }
    }
  ],
  "termination": { /* unchanged */ },
  "costs": { /* unchanged */ }
}
```

### IAM additions

The editor agent's IAM role gains three read-only permissions, scoped to the preview environment by tag:

```jsonc
{
  "Effect": "Allow",
  "Action": [
    "sns:GetTopicAttributes",
    "sqs:GetQueueAttributes",
    "iam:SimulatePrincipalPolicy",
    "iam:GetRolePolicy",
    "iam:ListRolePolicies",
    "iam:ListAttachedRolePolicies"
  ],
  "Resource": "*",
  "Condition": {
    "StringEquals": {
      "aws:ResourceTag/agent-harness/env": "preview"
    }
  }
}
```

The `iam:SimulatePrincipalPolicy` action does not support resource-level conditions; it is scoped by the `PolicySourceArn` parameter in the probe implementation (always the preview Lambda's execution role ARN from `stackOutputs`). This is documented in the IAM CDK definition alongside the policy.

## Error Handling

### Scheduled reviewer failures

| Failure | Detection | Response |
|---|---|---|
| Bedrock model unavailable | Reviewer invocation throws | Workflow exits non-zero; run record emitted with `outcome: "failure"`; no retry |
| Reviewer timeout (> 10 min) | Workflow step timeout | Same as above |
| Reviewer returns malformed output | Output schema validator | Same as above; `failureReason: "malformed-output"` |
| Cost cap exceeded | Token cost check after invocation | Workflow exits non-zero before auto-open; `failureReason: "cost-cap-exceeded"` |
| GitHub API unavailable (auto-open) | HTTP error from `gh api` | Auto-open step exits non-zero; run record records `issuesOpened: 0`; workflow fails |
| `fitnessGapLoop.enabled` is false | Enabled check at workflow start | Workflow exits 0 immediately; no run record emitted |

### Auto-open failures

| Failure | Detection | Response |
|---|---|---|
| Duplicate detection query fails | GitHub API error | Log error; treat as "no duplicate found" (conservative: may open a duplicate); record in run record `errors[]` |
| Issue creation fails | GitHub API error | Record in `AutoOpenResult.errors[]`; continue with remaining findings; run record reflects partial open count |
| Label application fails after issue creation | GitHub API error | Attempt to close the issue immediately; record error; do not leave an unlabelled issue open |

The label-application failure case is the most sensitive: an issue with `agent-task` but without `triage:fitness-gap` would be indistinguishable from a human-opened issue. The recovery is to close the issue and record the error rather than leave it in an ambiguous state.

### Gap-closure check failures

| Failure | Detection | Response |
|---|---|---|
| AWS API call fails (probe error) | SDK exception | `GapClosureResult.probeError` set; `closed: false`; post-deploy outcome is `"partial"` |
| Stack output missing (resource ARN not found) | `stackOutputs` lookup returns undefined | `GapClosureResult.probeError: "stack-output-missing"`; `closed: false`; post-deploy outcome is `"partial"` |
| Unknown finding ID (no probe registered) | Probe dispatch returns null | `GapClosureResult.probeMethod: "unknown"`; `closed: false`; post-deploy outcome is `"partial"` |
| Gap-closure check passes but smoke test fails | Existing post-deploy logic | Overall outcome is `"fail"`; gap-closure result is recorded but does not override the overall outcome |

**Flakiness handling:** The gap-closure check is a live AWS API call against a preview environment. Transient failures (throttling, eventual consistency after deploy) are retried once with a 5-second backoff before being recorded as `probeError`. A second failure is recorded as-is. The editor agent reads the `probeError` field and can choose to retry the deploy on the next iteration.

### Reviewer drift

Reviewer drift is defined as a sudden increase in finding count (> `fitnessGapLoop.drift.findingCountDeltaThreshold`, default 5) or repeated identical findings across consecutive runs that the agent fails to close (same `signature` appearing in run records for > `fitnessGapLoop.drift.consecutiveRunsThreshold`, default 3 consecutive runs).

Drift detection is a post-hoc query against the run records, not an in-loop check. The runbook documents the query and the first-move responses. The system does not automatically halt on drift; it surfaces the signal for a human to act on.

### Disable-flag interactions

When `fitnessGapLoop.enabled` is `false`:

- `dispatch-agent-task.yml` ignores the `triage:fitness-gap` label and always sets `triggerType: "feature-change"`. This means auto-opened issues from a previous enabled period will be dispatched as `feature-change` triggers, which is safe (the gap-closure check is skipped for `feature-change` triggers).
- The post-deploy harness skips the gap-closure check regardless of the trigger payload's `originatingFinding` field.
- The scheduled reviewer workflow exits 0 without emitting a run record.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Task 2 adds properties for the auto-open mechanism, the trigger payload extension, the gap-closure check, and the observability additions. The five properties from Task 1 (`feature-change-loop` design) continue to hold unchanged; they are not repeated here.

**Property reflection:** Before writing the properties below, redundancy was assessed across the prework analysis. Properties 3.1 (fitness-gap payload) and 3.2 (originatingFinding presence) were combined into a single payload completeness property (Property 3 below) because one implies the other. Properties 4.1 (gap-closure check inclusion) and 6.5 (gap-closure skipped for feature-change) were combined into a single conditional property (Property 4 below) because they are the two sides of the same conditional. Properties 5.1 (run record emission) and 5.3 (outcome record emission) are kept separate because they cover different lifecycle events.

### Property 1: Reviewer output schema invariant

*For any* diff input to the scheduled reviewer invocation, the output always matches the `ReviewerOutput` schema: a boolean `passed` field, a `findings` array where each entry has `id`, `pillar`, `severity`, `description`, and `suggestedFix`, and a `severityCounts` record.

**Validates: Requirements 1.2**

### Property 2: Auto-open threshold filter

*For any* set of reviewer findings and any configured severity threshold, the auto-open mechanism opens issues if and only if the finding's severity is at or above the threshold. No finding below the threshold produces an issue; no finding at or above the threshold is silently skipped (absent a duplicate).

**Validates: Requirements 2.1**

### Property 3: Issue body completeness

*For any* `ReviewerFinding` that triggers issue creation, the rendered issue body always contains: the finding's `id`, `description`, `severity`, `pillar`, `file` (when present), `suggestedFix`, the run's `runId`, the run's `runDate`, and the auto-open marker comment.

**Validates: Requirements 2.2**

### Property 4: Deduplication invariant

*For any* finding and any set of existing open issues, if an issue with the same content signature already exists in the open issue set, the auto-open mechanism does not create a new issue. The open issue count after the mechanism runs is the same as before.

**Validates: Requirements 2.3**

### Property 5: Label co-occurrence invariant

*For any* issue opened by the auto-open mechanism, the issue's label set always contains both `agent-task` and `triage:fitness-gap`. The mechanism never applies one without the other.

**Validates: Requirements 2.4**

### Property 6: Trigger type payload completeness

*For any* `agent-task`-labelled issue, the built AgentCore payload satisfies: if the issue has the `triage:fitness-gap` label then `triggerType === "fitness-gap"` and `originatingFinding` is a non-null object with all required fields; if the issue does not have the label then `triggerType === "feature-change"` and `originatingFinding` is absent.

**Validates: Requirements 3.1, 3.2, 3.4**

### Property 7: Gap-closure check conditionality

*For any* trigger payload, the post-deploy harness includes the gap-closure check step if and only if `triggerType === "fitness-gap"`. For `feature-change` triggers, the gap-closure check is never invoked regardless of what other fields are present in the payload.

**Validates: Requirements 4.1, 6.5**

### Property 8: Gap-closure failure session shape

*For any* gap-closure check failure, the session's `postDeploy` entry has `outcome` set to `"fail"` or `"partial"` and `report.gapClosure` contains a `GapClosureResult` with `closed: false` and a non-empty `probeMethod` field.

**Validates: Requirements 4.4**

### Property 9: Run record completeness

*For any* scheduled reviewer invocation (success or failure), a `ScheduledReviewerRunRecord` is emitted with all required fields: `runId`, `timestamp`, `modelId`, `outcome`, `findingsBySeverity`, `issuesOpened`, `duplicatesSkipped`, and `tokenCostUSD`.

**Validates: Requirements 5.1**

### Property 10: Feature-change trigger isolation

*For any* `feature-change`-typed trigger, the loop executes identically to Task 1: the session contains no `originatingFinding`, the post-deploy harness does not invoke the gap-closure check, and the PR body contains no gap-closure section.

**Validates: Requirements 6.1**

### Property 11: Cost guardrail enforcement

*For any* scheduled reviewer run where the token cost exceeds `fitnessGapLoop.costGuardrail.reviewerTokenSpendCapUSD`, the auto-open step is not reached and the run record records `outcome: "failure"` with `failureReason: "cost-cap-exceeded"`.

**Validates: Requirements 5.5**

## Testing Strategy

### Test layers, mapped to requirements

| Layer | What it covers | Examples |
|---|---|---|
| Unit tests (Jest) | Auto-open mechanism (signature computation, deduplication logic, label enforcement, issue body rendering), trigger payload builder (label detection, originatingFinding extraction), gap-closure probe dispatch, run record emitter, cost guardrail check | "signature is deterministic for same finding fields"; "auto-open skips duplicate when signature matches"; "label enforcement closes issue if triage:fitness-gap application fails"; "payload sets triggerType=fitness-gap when label present" |
| Property-based tests (fast-check) | Properties 1–11 above | "for any ReviewerFinding above threshold, issue body contains all required fields"; "for any feature-change trigger, gap-closure check is never invoked" |
| Probe unit tests | Each gap-closure probe against mocked AWS SDK responses | "SNS probe returns closed=true when policy contains Deny on aws:SecureTransport=false"; "SQS probe returns closed=false when KmsMasterKeyId is absent" |
| Integration tests | Scheduled reviewer workflow end-to-end against a mock reviewer; auto-open against a mock GitHub API; gap-closure check against a mock AWS SDK | "scheduled reviewer workflow emits run record with correct finding counts"; "gap-closure check writes GapClosureResult to session" |
| Agent integration tests | Editor agent processes fitness-gap trigger through the full loop with mock gap-closure check | "fitness-gap trigger converges in ≤ 3 iterations on the reference module with SNS HTTPS-only gap" |
| Live-fire smoke tests | Real AgentCore, real preview environment, scripted fitness-gap trigger | One per release; documented in runbook |

### Property-based testing

The property-based tests use [fast-check](https://github.com/dubzzz/fast-check) (same library as Task 1). Each property test runs a minimum of 100 iterations.

Tag format: `Feature: fitness-gap-loop, Property <N>: <property_text>`

Key generators needed:

- `fc.record({ id: fc.string(), pillar: fc.constantFrom("Security", "Reliability"), severity: fc.constantFrom("info","low","medium","high","critical"), description: fc.string(), suggestedFix: fc.string() })` — arbitrary `ReviewerFinding`
- `fc.array(reviewerFindingArb)` — arbitrary finding set
- `fc.constantFrom("feature-change", "fitness-gap")` — trigger type
- `fc.record({ labels: fc.array(fc.string()) })` — arbitrary GitHub issue

### Unit testing balance

Unit tests focus on:

- The auto-open mechanism's deduplication logic (the most complex new logic in Task 2)
- The label co-occurrence enforcement (the most sensitive correctness requirement)
- The trigger payload builder's label-detection branch
- The gap-closure probe dispatch table (ensuring all three probes are registered)
- The cost guardrail threshold comparison

Property tests handle the universal cases (all findings, all trigger types, all issue shapes). Unit tests handle the specific edge cases (empty findings list, threshold boundary, malformed issue body, missing stack outputs).

### Coverage targets

- 100 percent of new tool wrappers and mechanism entry points under unit tests.
- 100 percent of gap-closure probe implementations under unit tests with mocked AWS SDK.
- ≥ 80 percent line coverage on new harness code (`harness/auto-open/`, `harness/post-deploy/gap-closure/`, `harness/scheduled-reviewer/`).
- All 11 correctness properties above covered by property-based tests.

### Acceptance gating

Before a release tag, all of the following must be green (in addition to Task 1's acceptance gates):

1. Unit and property-based tests pass for all new modules.
2. Probe unit tests pass against mocked AWS SDK responses for all three gap types.
3. Agent integration test: fitness-gap trigger converges on the reference module with the SNS HTTPS-only gap.
4. Live-fire smoke test: scheduled reviewer workflow runs end-to-end, opens one issue, and the editor agent closes the gap and opens a PR with a gap-closure section.

### Decisions deliberately deferred

- **CloudWatch Logs vs. S3 for run records.** CloudWatch Logs is the default (consistent with Task 1's session log approach); S3 is an option for teams that want longer retention or cheaper storage. Implementation choice.
- **Outcome record trigger mechanism.** GitHub Actions `issues.closed` event vs. a polling script. The event-driven approach is cleaner; the polling approach is more reliable if the event is missed. Implementation choice.
- **Drift detection automation.** The runbook documents the query; whether to automate the alert (CloudWatch alarm on finding count delta) is left to the operator. The threshold values in `fitnessGapLoop.drift` are placeholders until measured against the reference module.
