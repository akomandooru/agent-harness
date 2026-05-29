# Quickstart

Get the bounded loop running against your AWS account in ~30 minutes.

---

## Prerequisites

- [ ] AWS account with permission to create IAM roles, CloudFormation stacks, CodeBuild projects, Lambda functions, SNS topics, SQS queues, and API Gateway resources
- [ ] [AgentCore Managed Harness](https://aws.amazon.com/bedrock/agentcore/) access (preview)
- [ ] Bedrock model access for Claude Sonnet (us-east-1)
- [ ] Node.js 22.x (run `nvm use 22` or see `.nvmrc`)
- [ ] AWS CDK v2 installed: `npm install -g aws-cdk@2`
- [ ] AWS CLI configured with credentials for your account

---

## Step 1 — Clone and install

```bash
git clone <repo-url>
cd agent-harness
nvm use 22
npm ci
```

---

## Step 2 — Edit configuration

Open `agent-harness.config.json` and verify:

```jsonc
{
  "module": {
    "path": "modules/fanout",
    "stackName": "FanoutPreview"
  },
  "models": {
    "editor": "us.anthropic.claude-sonnet-4-6",
    "reviewer": "us.anthropic.claude-sonnet-4-6"
  },
  "limits": {
    "iterationCap": 8,
    "wallClockCapMinutes": 12,
    "tokenSpendCapUSD": 10.0
  }
}
```

Adjust the model identifiers if you're using a different region or model version.

---

## Step 3 — Deploy everything (automated)

The setup script handles CDK bootstrap, IAM roles, AgentCore harness deployment, and the CodeBuild orchestrator stack:

**PowerShell (Windows):**
```powershell
.\scripts\setup.ps1 -AccountId "<your-aws-account-id>"
```

**Bash (Mac/Linux):**
```bash
./scripts/setup.sh --account-id <your-aws-account-id>
```

This runs steps 3 through 5b:
1. CDK bootstrap (if not already done)
2. IAM stack deployment (roles for AgentCore harnesses)
3. AgentCore harness deployment (editor + reviewer) via `CreateHarness` API
4. CodeBuild orchestrator stack deployment
5. Config validation and version-drift check
6. A test run of the bounded loop (Task 1: feature change)

The test run verifies the full gate chain: sensors, reviewer, deploy, post-deploy. If it succeeds, everything is working.

---

## Step 4 — Run Task 1 (feature change)

Trigger the loop with a human-initiated task:

```powershell
.\scripts\setup.ps1 -AccountId "<your-account>" -FromStep 5b -TaskType feature
```

The default task: "Increase DLQ retention to 30 days and reduce maxReceiveCount to 3."

Watch the logs:
```bash
aws logs tail /aws/codebuild/agent-harness-orchestrator --since 30m --format short
```

---

## Step 5 — Run Task 2 (autonomous discovery)

The reviewer scans the module, finds architecture gaps, and the loop fixes the top finding:

```powershell
.\scripts\setup.ps1 -AccountId "<your-account>" -FromStep 5b -TaskType discover
```

This demonstrates the full autonomous cycle: system finds work, system does work, all gates pass.

---

## What to expect

A successful run looks like:

```
[loop] === Iteration 1 ===
[sensors] tsc: PASSED
[sensors] eslint: FAILED (exit 1)
[sensors] Overall: SOME FAILED

[loop] === Iteration 2 ===
[sensors] Overall: ALL PASSED
[reviewer] ...
[deploy] Result: ok
[post-deploy] Result: pass

[main] Loop terminated: success
```

The agent gets structured feedback from sensors, iterates, and converges. Typical: 2-4 iterations, ~5-10 minutes.

---

## Teardown

To remove all deployed resources:

```bash
aws cloudformation delete-stack --stack-name FanoutPreview
aws cloudformation delete-stack --stack-name AgentHarnessCodeBuildStack
aws cloudformation delete-stack --stack-name AgentHarnessIam
```

---

## Next steps

- Replace `modules/fanout/` with your own CDK module
- Edit `modules/<your-module>/AGENTS.md` with your conventions
- Add sensors specific to your module
- Wire the trigger into your team's workflow (CI/CD webhook, labeled issues, Slack, cron)
