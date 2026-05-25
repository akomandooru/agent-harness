# Quickstart

Get from a fresh fork to "first trigger converges" in about 30 minutes, assuming you have the prerequisites.

> **Windows users:** The shell commands in this guide use bash syntax (`export`, heredocs, `$(...)` substitution). Run them in Git Bash or WSL rather than PowerShell or cmd.

---

## Prerequisites

Before you start, confirm you have:

- [ ] AWS account with permission to create IAM roles, CloudFormation stacks, Lambda functions, SNS topics, SQS queues, and API Gateway resources
- [ ] [AgentCore Managed Harness](https://aws.amazon.com/bedrock/agentcore/) access in your AWS account (the preview AgentCore Managed Harness feature used by this template for the editor and reviewer agents, with a custom orchestrator on top — distinct from AgentCore Runtime, the code-based deployment mode)
- [ ] Bedrock model access for Claude Sonnet in `us-east-1` (or your chosen region)
- [ ] GitHub repository with Actions enabled (fork of this template)
- [ ] [AWS CLI](https://aws.amazon.com/cli/) configured with credentials for your account
- [ ] [AWS CDK v2](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html) installed: `npm install -g aws-cdk@2.1124.1`
- [ ] [GitHub CLI](https://cli.github.com/) installed and authenticated
- [ ] Node.js 22.x (use `nvm use` if you have nvm)

---

## Step 1 — Fork and clone (2 minutes)

```bash
# Fork via GitHub UI, then:
git clone https://github.com/<your-org>/agent-harness.git
cd agent-harness
nvm use   # sets Node 20.x from .nvmrc
```

---

## Step 2 — Configure (5 minutes)

Edit `agent-harness.config.json`. The fields you must update for a first run:

```jsonc
{
  "agentcore": {
    "regionalRouting": "us-east-1"   // change if using a different region
  },
  "orchestrator": {
    // Leave this as the placeholder for now — you won't have the real URL
    // until after Step 4b (orchestrator CDK deploy). You'll come back and
    // fill it in at Step 4c.
    "apiGatewayEndpoint": "https://<api-id>.execute-api.<region>.amazonaws.com/prod/orchestrate"
  },
  "models": {
    // Confirm these model IDs are available in your account.
    // The `us.` prefix routes through the US cross-region inference profile,
    // which is required for AgentCore Managed Harness.
    "editor": "us.anthropic.claude-sonnet-4-6-v1:0",
    "reviewer": "us.anthropic.claude-sonnet-4-6-v1:0"
  }
}
```

Everything else (iteration cap, token cap, sensor settings) can stay at defaults for the first run.

---

## Step 3 — Bootstrap CDK (3 minutes)

If you haven't bootstrapped CDK in your account and region:

```bash
cdk bootstrap aws://<account-id>/us-east-1
```

---

## Step 4 — Deploy the IAM stack (5 minutes)

The IAM stack creates the three principals the harness needs: the editor agent role, the reviewer agent role, and the GitHub Action runner role.

After the orchestrator stack is deployed (Step 4b), you'll re-run this with the `orchestratorApiResourceArn` context value. For now, deploy with a placeholder — you'll update it in Step 4d.

```bash
cd infrastructure
npm ci

# Deploy. Replace the placeholder values with your account details.
cdk deploy \
  --app "npx ts-node iam-stack.ts" \
  --context previewAccountId=<your-account-id> \
  --context previewRegion=us-east-1 \
  --context checklistBucketName=agent-harness-checklists-<your-account-id> \
  --context orchestratorApiResourceArn=arn:aws:execute-api:us-east-1:<your-account-id>:placeholder/prod/POST/orchestrate \
  --context githubRepo=<your-org>/<your-repo>
  # e.g. --context githubRepo=acme-corp/agent-harness
  # Use the org/repo slug from your GitHub URL — not the full URL.
  # This scopes the runner role's OIDC trust to your fork only.

cd ..
```

Note the `GitHubActionRunnerRoleArn` output — you'll need it in Step 5.

---

## Step 4b — Deploy the AgentCore Managed Harnesses (5 minutes)

Deploy the editor and reviewer Managed Harnesses using the `agentcore` CLI from `@aws/agentcore@preview`. This step produces two harness ARNs that the orchestrator stack needs.

```bash
# Run from the repo root (not infrastructure/) — agentcore.json uses relative
# paths to app/editor/harness.json and app/reviewer/harness.json.

# Install the AgentCore CLI (preview channel)
npm install -g @aws/agentcore@preview

# Deploy both harnesses declared in agentcore/agentcore.json
agentcore deploy

# The CLI outputs two harness ARNs, for example:
#   editor-agent:   arn:aws:bedrock-agentcore:us-east-1:<account>:harness/editor-agent/<id>
#   reviewer-agent: arn:aws:bedrock-agentcore:us-east-1:<account>:harness/reviewer-agent/<id>
#
# Capture both ARNs — you will pass them as CDK context when deploying the orchestrator stack.
export EDITOR_HARNESS_ARN="arn:aws:bedrock-agentcore:us-east-1:<account>:harness/editor-agent/<id>"
export REVIEWER_HARNESS_ARN="arn:aws:bedrock-agentcore:us-east-1:<account>:harness/reviewer-agent/<id>"
```

Then deploy the orchestrator CDK stack from the `infrastructure/` folder:

```bash
cd infrastructure
cdk deploy \
  --app "npx ts-node orchestrator-stack.ts" \
  --context editorHarnessArn="$EDITOR_HARNESS_ARN" \
  --context reviewerHarnessArn="$REVIEWER_HARNESS_ARN"
cd ..
```

Note the `OrchestratorApiResourceArn` and `OrchestratorApiEndpoint` outputs — you'll need both in the next two steps.

---

## Step 4c — Update config with the API Gateway endpoint (1 minute)

Now that the orchestrator stack is deployed, get the real endpoint URL from the stack output and update `agent-harness.config.json`:

```bash
# Get the endpoint from the CDK stack output
ORCHESTRATOR_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name agent-harness-orchestrator \
  --query 'Stacks[0].Outputs[?OutputKey==`OrchestratorApiEndpoint`].OutputValue' \
  --output text)

echo "Endpoint: $ORCHESTRATOR_ENDPOINT"
```

Edit `agent-harness.config.json` and replace the placeholder:

```jsonc
{
  "orchestrator": {
    "apiGatewayEndpoint": "<paste the URL from above>/orchestrate"
  }
}
```

The URL from the stack output is the base URL (e.g. `https://abc123.execute-api.us-east-1.amazonaws.com/prod`). Append `/orchestrate` to get the full endpoint path.

---

## Step 4d — Update the IAM stack with the real API resource ARN (3 minutes)

Now re-deploy the IAM stack with the real `OrchestratorApiResourceArn` from Step 4b. This scopes the GitHub runner role's `execute-api:Invoke` permission to exactly your API resource rather than the placeholder.

```bash
# Get the resource ARN from the orchestrator stack output
ORCHESTRATOR_API_RESOURCE_ARN=$(aws cloudformation describe-stacks \
  --stack-name agent-harness-orchestrator \
  --query 'Stacks[0].Outputs[?OutputKey==`OrchestratorApiResourceArn`].OutputValue' \
  --output text)

cd infrastructure
cdk deploy \
  --app "npx ts-node iam-stack.ts" \
  --context previewAccountId=<your-account-id> \
  --context previewRegion=us-east-1 \
  --context checklistBucketName=agent-harness-checklists-<your-account-id> \
  --context orchestratorApiResourceArn="$ORCHESTRATOR_API_RESOURCE_ARN" \
  --context githubRepo=<your-org>/<your-repo>
  # e.g. --context githubRepo=acme-corp/agent-harness
cd ..
```

---

## Step 5 — Set GitHub secrets (3 minutes)

The dispatch workflow needs three secrets set in your fork's repository settings.

```bash
# The GitHub Actions runner role ARN — from the IAM stack output (GitHubActionRunnerRoleArn).
# This is the role the dispatch workflow assumes via OIDC to SigV4-sign the
# POST to the orchestrator API Gateway.
gh secret set AWS_RUNNER_ROLE_ARN \
  --body "arn:aws:iam::<account-id>:role/agent-harness-github-runner"

# The editor agent role ARN — from the IAM stack output (EditorAgentRoleArn).
# Used by the trust gates (sensors, cdk deploy, post-deploy) inside the Lambda.
gh secret set AWS_EDITOR_ROLE_ARN \
  --body "arn:aws:iam::<account-id>:role/agent-harness-editor"

# Your AWS region
gh secret set AWS_REGION --body "us-east-1"
```

> The orchestrator endpoint is read from `agent-harness.config.json` at runtime (set in Step 4c) — you do not need to set it as a secret.

---

## Step 6 — Verify the setup (2 minutes)

Run the config validator and version-drift check locally:

```bash
npx ts-node scripts/validate-config.ts
npx ts-node scripts/check-version-drift.ts
```

Both should exit 0. If `check-version-drift.ts` reports drift, update the `versions` section in `agent-harness.config.json` to match the installed packages.

---

## Step 7 — Create the example issue and trigger the loop (5 minutes)

Open an issue from the template. The `agent-task` label is pre-applied by the template, which triggers the dispatch workflow automatically.

```bash
gh issue create \
  --title "[Agent task] Add a dead-letter queue to the SQS subscriber" \
  --label agent-task \
  --body "$(cat <<'EOF'
### Target module path
modules/fanout

### Change description
Add a dead-letter queue to the SQS subscriber so that messages that fail
processing after 3 attempts are moved to the DLQ instead of being lost.
Wire a CloudWatch alarm on the DLQ depth.

### Acceptance criteria
- The DLQ exists and is KMS-encrypted.
- The SQS queue's redrive policy points to the DLQ with maxReceiveCount = 3.
- A CloudWatch alarm named `<stack>-DlqDepth` exists with threshold 1.
- The post-deploy harness confirms a deliberately poisoned message lands
  in the DLQ within 60 seconds.
EOF
)"
```

---

## Step 8 — Watch the loop converge (10 minutes)

```bash
# Watch the dispatch workflow run
gh run list --workflow dispatch-agent-task.yml
gh run watch

# Follow the loop in the AgentCore console
# (open the AWS console → Bedrock → AgentCore → Sessions)

# When the loop opens a PR, review it
gh pr list
gh pr view <pr-number>
```

A typical first run on the DLQ example takes two to four iterations:

1. The agent edits `modules/fanout/lib/fanout-stack.ts` to add the DLQ.
2. The computational sensors run (cdk-nag, tsc, eslint, unit tests).
3. The inferential reviewer checks the diff against the Well-Architected Security and Reliability checklists.
4. The agent deploys to the preview environment.
5. The post-deploy harness exercises the fan-out and verifies the DLQ.
6. On pass, the agent opens a PR.

---

## Step 9 — Review and merge (your call)

The PR includes:

- A summary of the change
- Sensor results (per-sensor pass/fail)
- Post-deploy harness outcome
- Link to the preview environment (already torn down on PR close)
- Link to the session log

Review the diff, confirm the sensor results look right, and merge if satisfied. The preview environment tears down automatically when the PR closes.

---

## Troubleshooting

**The dispatch workflow fails immediately.**
Check that `AWS_RUNNER_ROLE_ARN` and `AWS_EDITOR_ROLE_ARN` are set correctly in repository secrets, and that `orchestrator.apiGatewayEndpoint` in `agent-harness.config.json` is set to the real URL (not the placeholder). The workflow comments on the issue with the error.

**The loop oscillates.**
See [docs/runbook.md — Oscillation](runbook.md#oscillation).

**The post-deploy harness keeps failing.**
See [docs/runbook.md — Post-deploy flakiness](runbook.md#post-deploy-flakiness).

**The preview stack wasn't torn down.**
See [docs/runbook.md — Preview teardown failure](runbook.md#preview-teardown-failure). The scheduled sweep (`preview-sweep.yml`) runs every 6 hours as a backstop.

**I need to stop the loop immediately.**
```bash
gh issue edit <number> --add-label agent-stop
```
See [docs/runbook.md — Kill-switch invocation](runbook.md#kill-switch-invocation).

---

## Cleanup

### After a test run (per-session cleanup)

The preview environment tears down automatically when the PR closes. If it didn't:

```bash
# Check for leftover preview stacks
aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query 'StackSummaries[?starts_with(StackName, `FanoutPreview`)].StackName'

# Tear down manually if needed
aws cloudformation delete-stack --stack-name FanoutPreview-<session-id>

# Or run the sweep script
npx ts-node scripts/sweep-previews.ts
```

Clean up GitHub artifacts:

```bash
# Close the issue if still open
gh issue close <number>

# Delete the agent's branch
gh api -X DELETE /repos/<org>/<repo>/git/refs/heads/<branch-name>

# Close the PR if opened but not merged
gh pr close <number>
```

### Tear down all infrastructure (when done testing)

Delete in reverse dependency order:

```bash
# 1. Orchestrator stack
cd infrastructure
cdk destroy --app "npx ts-node orchestrator-stack.ts"

# 2. IAM stack (pass the same context values used during deploy)
cdk destroy --app "npx ts-node iam-stack.ts" \
  --context previewAccountId=<your-account-id> \
  --context previewRegion=us-east-1 \
  --context checklistBucketName=agent-harness-checklists-<your-account-id> \
  --context orchestratorApiResourceArn=placeholder \
  --context githubRepo=<your-org>/<your-repo>
cd ..

# 3. AgentCore Managed Harnesses
agentcore destroy

# 4. CloudWatch log groups (CDK does not delete these by default)
aws logs delete-log-group --log-group-name /aws/lambda/agent-harness-orchestrator
```

> **Idle cost:** Lambda and API Gateway have no standing cost when idle. Check the AWS console for any AgentCore Managed Harness preview charges. The CDK bootstrap S3 bucket has minimal storage cost.

---

## Next steps

- Read the companion post for the framing: [The two harnesses every agent needs](#) *(link to come)*
- Adapt `modules/fanout/AGENTS.md` to your team's conventions
- Swap the cdk-nag rule pack: change `sensors.cdkNagRulePack` in `agent-harness.config.json` to `NIST80053R5`, `HIPAA`, or `PCIDSS`
- Add a second sensor: extend `agents/editor/tools/sensors.ts`
- Explore the architecture fitness gap loop spec: [`.kiro/specs/fitness-gap-loop/`](../.kiro/specs/fitness-gap-loop/) *(planned)*
