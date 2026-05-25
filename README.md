# agent-harness

A template for two bounded closed loops that let an editing agent, hosted on AgentCore Managed Harness (the preview AWS Bedrock AgentCore feature that provides a config-file-driven managed agent loop for the editor and reviewer agents, with a custom orchestrator on top — distinct from AgentCore Runtime, the code-based deployment mode), maintain a CDK module autonomously while keeping a human in the merge seat.

**Task 1 — Feature-change loop** ([spec](.kiro/specs/feature-change-loop/)): the agent responds to human-opened GitHub issues labelled `agent-task`. It edits the CDK module, runs an engineering harness, deploys to an ephemeral preview environment, and either iterates or opens a pull request. A human always reviews and merges.

**Task 2 — Fitness-gap loop** ([spec](.kiro/specs/fitness-gap-loop/)): a scheduled inferential reviewer runs against the module on `main`, surfaces architecture-fitness gaps, and auto-opens GitHub issues for findings above a configurable severity threshold. Those issues feed directly into the Task 1 trigger surface — the same editing agent picks them up, closes the gap, and opens a PR. The post-deploy harness verifies the gap is actually closed in the deployed preview environment before the PR is opened.

This template is intended to be forked and adapted. The companion post (link below) is the canonical reference for the framing.

---

## Is this useful for you?

A few questions to help you decide whether to fork this template or wait for a different one.

- **Are you on GitHub for source control and issue tracking?** The trigger surface (label-driven Actions, auto-opened issues, PRs linking back to issues) is GitHub-native. GitLab and Bitbucket can host an equivalent shape, but the trigger plumbing has to be rebuilt.
- **Are you maintaining infrastructure-as-code that other people deploy?** If yes, the template is in the right shape. If your work is application code, library code, or content, the bounded loop pattern still applies but the sensor choices and the post-deploy harness will need rebuilding for your domain.
- **Can you stand up an ephemeral preview environment per PR?** The template assumes you can. If preview environments are out of reach in your org, the post-deploy half of the loop won't work and you'll need to scope down to the in-process sensors only.
- **Are you on AWS, with CDK as your IaC tool?** The template is AWS- and CDK-specific. Porting to Terraform or another cloud is straightforward in principle but it's real work, not a config flip.
- **Are you comfortable running a Bedrock-backed agent on AgentCore Managed Harness for a workload that edits IaC?** The template's defaults assume yes.
- **Is your team ready to maintain the engineering harness over time?** The template ships with steering, sensors, and the post-deploy harness wired up. They will need updating as your CDK module evolves.
- **Are you comfortable with scheduled, autonomous issue creation?** Task 2 opens GitHub issues automatically when the reviewer finds architecture-fitness gaps above the configured severity threshold. Teams that need every agent task to start with a human action should leave Task 2 disabled (`fitnessGapLoop.enabled: false`).

If most answers are yes, this is a reasonable fork-and-adapt starting point. If two or more are no, treat the post's framing as the contribution and build the equivalent harness in your own stack.

---

## Prerequisites

- AWS account with permission to create the preview environment infrastructure
- [AgentCore Managed Harness](https://aws.amazon.com/bedrock/agentcore/) access (the preview AgentCore Managed Harness feature used by this template for the editor and reviewer agents)
- Bedrock model access (default: Claude Sonnet via Bedrock, configurable)
- GitHub repository with Actions enabled
- [GitHub CLI](https://cli.github.com/) (`gh`) for the kill-switch script
- Node.js 20.x (see `.nvmrc`)
- AWS CDK v2 (`npm install -g aws-cdk@2.1124.1`)

---

## Quickstart

See [`docs/quickstart.md`](docs/quickstart.md) for the full setup guide.

---

## Repository structure

```
.github/
  ISSUE_TEMPLATE/agent-task.yml   # Structured issue template
  workflows/
    dispatch-agent-task.yml       # Trigger: label → AgentCore
    agent-stop.yml                # Kill switch: agent-stop label
    preview-teardown.yml          # Teardown on PR close
    preview-sweep.yml             # Scheduled sweep of abandoned previews
    scheduled-reviewer.yml        # Scheduled reviewer workflow (Task 2)

agents/
  editor/                         # Strands editor agent
  reviewer/                       # Strands reviewer agent
  shared/                         # Shared wrapper plumbing

harness/
  loop/                           # Bounded loop runner
  post-deploy/                    # Synthetic post-deploy harness
    gap-closure/                  # Gap-closure probes (Task 2)
  auto-open/                      # Auto-open mechanism (Task 2)
  scheduled-reviewer/             # Scheduled reviewer runner (Task 2)
  gap-closure-outcomes/           # Gap-closure outcome emitter (Task 2)
  shared/                         # Shared types (Task 2)

infrastructure/
  iam-stack.ts                    # CDK IAM stack (editor, reviewer, runner roles)

modules/
  fanout/                         # Reference CDK module (API GW → Lambda → SNS → SQS → Lambda)
    AGENTS.md                     # Steering file for the editor agent

scripts/
  agent-stop.ts                   # CLI kill-switch equivalent
  sweep-previews.ts               # Manual preview sweep
  check-version-drift.ts          # CI version-pin check
  validate-config.ts              # CI config validation

docs/
  quickstart.md                   # 30-minute happy path
  runbook.md                      # Failure modes and first-move responses
  cost-envelope.md                # Measured cost ranges per trigger
  queries/                        # CloudWatch Insights queries (Task 2)

agent-harness.config.json         # Single source of truth for all config and version pins
```

---

## Configuration

All configurable values live in `agent-harness.config.json`. Key fields:

| Field | Default | Description |
|---|---|---|
| `module.path` | `modules/fanout` | CDK module the agent maintains |
| `agentcore.regionalRouting` | `us-east-1` | AWS region for AgentCore Managed Harness |
| `orchestrator.apiGatewayEndpoint` | (placeholder) | Orchestrator API Gateway endpoint URL |
| `models.editor` | Claude Sonnet | Bedrock model for the editor |
| `models.reviewer` | Claude Sonnet | Bedrock model for the reviewer |
| `limits.iterationCap` | 5 | Max iterations per trigger |
| `limits.wallClockCapMinutes` | 12 | Max wall-clock time per trigger (Lambda timeout is 15 min; this leaves 3 min buffer) |
| `limits.tokenSpendCapUSD` | 10.0 | Max token spend per trigger |
| `sensors.cdkNagRulePack` | `AwsSolutions` | cdk-nag rule pack |
| `sensors.reviewerSeverityThreshold` | `MEDIUM` | Minimum severity that blocks the loop |
| `preview.sweepMaxAgeHours` | 24 | Max age before a preview stack is swept |

Version pins are in the `versions` section. Run `npm run check-version-drift` to verify they match the installed packages.

### Task 2 configuration (`fitnessGapLoop`)

All Task 2 knobs live under the `fitnessGapLoop` key in `agent-harness.config.json`. Setting `fitnessGapLoop.enabled` to `false` is the single switch to disable all Task 2 behaviour — no code changes required.

| Field | Default | Description |
|---|---|---|
| `fitnessGapLoop.enabled` | `true` | Single disable switch for all Task 2 behaviour |
| `fitnessGapLoop.schedule` | `0 6 * * *` | Cron schedule for the reviewer (06:00 UTC daily) |
| `fitnessGapLoop.autoOpen.severityThreshold` | `HIGH` | Minimum severity to auto-open an issue (`INFO \| LOW \| MEDIUM \| HIGH \| CRITICAL`) |
| `fitnessGapLoop.autoOpen.labels` | `["agent-task", "triage:fitness-gap"]` | Labels applied to auto-opened issues |
| `fitnessGapLoop.autoOpen.duplicateAction` | `comment` | What to do when a duplicate exists: `comment` adds a note to the existing issue; `skip` takes no action |
| `fitnessGapLoop.autoOpen.expiryDays` | `30` | Days before an open issue is considered expired for outcome tracking |
| `fitnessGapLoop.gapClosureChecks.probes` | `["sns-https-only", "sqs-encryption", "iam-scoping"]` | Gap-closure probes to run after deploy on fitness-gap triggers |
| `fitnessGapLoop.costGuardrail.reviewerTokenSpendCapUSD` | `2.0` | Max token spend per scheduled reviewer run; workflow exits non-zero if exceeded |

---

## Kill switch

Apply the `agent-stop` label to the originating issue or in-flight PR to halt the loop immediately.

```bash
gh issue edit <number> --add-label agent-stop
gh pr edit <number> --add-label agent-stop
```

Or use the helper script:

```bash
npx ts-node scripts/agent-stop.ts --issue <number>
```

See [`docs/runbook.md`](docs/runbook.md) for restart instructions.

---

## What this template does not do

- **Autonomous merge.** A human always merges the PR.
- **Production deploy.** The agent has no path to any environment outside the PR's preview.
- **Multi-agent coordination.** One agent, one PR, one preview.
- **Harness self-evolution.** The agent does not edit its own steering files, sensors, or hooks.
- **Behavioural correctness beyond what tests catch.** The post-deploy harness checks the cases in the harness, not all possible cases.

---

## Specs

- **Task 1 — Feature-change loop:** [`.kiro/specs/feature-change-loop/`](.kiro/specs/feature-change-loop/) — the agent responds to human-opened `agent-task` issues, edits the CDK module, and opens a PR after the post-deploy harness passes.
- **Task 2 — Fitness-gap loop:** [`.kiro/specs/fitness-gap-loop/`](.kiro/specs/fitness-gap-loop/) — a scheduled reviewer surfaces architecture-fitness gaps, auto-opens issues above the configured severity threshold, and the same editing agent closes them. The post-deploy harness verifies gap closure against the deployed preview environment.

---

## Published post

[The two harnesses every agent needs, and a template that closes the loop](#) — link to come once published.

The post is the canonical reference for the framing: why the runtime/engineering harness split matters, why the bounded closed loop is the responsible next step toward self-correction, and what the template demonstrates.

---

## License

Apache 2.0. See [LICENSE](LICENSE).
