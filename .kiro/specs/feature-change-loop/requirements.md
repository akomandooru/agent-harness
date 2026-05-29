# Requirements Document

## Introduction

This spec covers the first deliverable of the agent harness template: a bounded closed loop that lets a Strands editing agent, hosted on AgentCore Harness, maintain a CDK module in response to GitHub issues labelled `agent-task`. The agent edits the module, runs an engineering harness against the change, deploys to an ephemeral preview environment, runs a synthetic post-deploy harness, and either iterates on failure or opens a pull request on success. A human always reviews and merges; the agent never merges, never deploys outside the preview, and never extends its own iteration cap.

This spec covers Task 1 (feature change) only. Task 2 (architecture-fitness gap loop) is a separate spec at `../fitness-gap-loop/` and depends on this one.

The template is intended to be forked and adapted, not used as-is. Production-leaning means version pins, IAM scoping, teardown discipline, a kill switch, cost guards, and a runbook ride along with the working code. It does not mean the template is itself a production system.

The companion post (`../../post-draft.md` in this workspace, eventually published on AWS Builder Community) describes the framing the template demonstrates. The spec and the post must stay consistent.

## Glossary

- **AgentCore Harness:** AWS-managed agent runtime that hosts the editor and reviewer agents, orchestrates their tool calls, sandboxes their execution, and persists session state. Treated here as the runtime harness layer.
- **Strands:** the agent framework used to define the editor and the reviewer. Each is a Strands `Agent` with a model, system prompt, and tool catalogue.
- **Editor agent:** the Strands agent that reads triggers, edits the CDK module, runs sensors and the post-deploy harness via tool calls, and iterates.
- **Reviewer agent:** a separate Strands agent invocation that runs the inferential Well-Architected review on a diff. Has no edit or deploy tools.
- **Engineering harness:** the bundle of guides (steering files), computational sensors (cdk-nag, `tsc`, `eslint`, unit tests), the inferential reviewer, the post-deploy harness, and the wiring that turns their outputs into agent context. Built and owned by the team.
- **Bounded loop:** the closed iteration cycle scoped to a PR branch and an ephemeral preview environment. Closed in that sensor output feeds the next iteration without human intervention; bounded in that nothing reaches `main` or production without a human merge.
- **Preview environment:** an ephemeral AWS environment created per PR, used for `cdk deploy` and the synthetic post-deploy harness. Torn down on PR close.
- **Post-deploy harness:** a synthetic test runner invoked after the preview deploy succeeds. Exercises the deployed system and reports pass, fail, or partial.
- **Trigger:** the input that starts the loop. In this spec, an `agent-task`-labelled GitHub issue.
- **Trust gate:** a step in the loop the agent cannot bypass: each computational sensor, the inferential reviewer, the post-deploy harness, and the human merge.

## Requirements

### Requirement 1: Trigger surface

**User Story:** As a developer maintaining the CDK module, I want to dispatch work to the editing agent by opening a labelled GitHub issue, so the trigger surface is explicit, human-controlled, and uses tooling my team already has.

#### Acceptance Criteria

1. WHEN a GitHub issue is opened or edited AND the issue receives the `agent-task` label THEN a GitHub Action SHALL invoke the AgentCore endpoint with a structured payload derived from the issue body and metadata.
2. WHEN a GitHub issue lacks the `agent-task` label THEN the system SHALL NOT invoke the agent under any circumstance.
3. WHEN the GitHub Action invokes the AgentCore endpoint THEN the payload SHALL include at minimum: trigger type (`feature-change`), issue number, issue title, issue body, target module path, and an empty or initial session identifier.
4. WHEN the GitHub Action cannot reach the AgentCore endpoint THEN the system SHALL fail loudly by commenting on the issue with the error and SHALL NOT silently retry without a human-visible signal.
5. The repository SHALL include a GitHub issue template (`.github/ISSUE_TEMPLATE/agent-task.yml`) that captures structured fields the agent needs (target module path, change description, optional acceptance criteria).

### Requirement 2: Editing agent

**User Story:** As a forker of this template, I want a single, well-scoped Strands editing agent so that I can read its tool catalogue, system prompt, and session contract in one place and adapt them to my own module.

#### Acceptance Criteria

1. The editing agent SHALL be implemented as a Strands `Agent` with an explicit system prompt, an explicit model selection (default: a Claude Sonnet via Bedrock), and an explicit tool catalogue.
2. The editing agent's tool catalogue SHALL include: file read scoped to the CDK module path, file write scoped to the same path, `cdk diff` against the preview environment, `cdk deploy` against the preview environment, invocations of each computational sensor (cdk-nag, `tsc --noEmit`, `eslint`, the unit test runner), invocation of the inferential reviewer, fetches of CloudWatch logs and metrics from the preview environment, and invocation of the synthetic post-deploy harness.
3. The editing agent SHALL NOT have any tool that allows it to merge a pull request, to deploy outside the preview environment, to modify GitHub repository settings, or to read or write files outside the CDK module path.
4. The editing agent SHALL read the steering file (`AGENTS.md` at the module root) and the session history on every iteration before planning the next edit.
5. The editing agent SHALL produce a structured PR description on success that names the trigger, the change made, the sensor results, and the post-deploy harness outcome.

### Requirement 3: Engineering harness, guide

**User Story:** As a forker of this template, I want a steering file that codifies the conventions the editing agent should follow, so the agent's first attempt is shaped by my team's standards rather than only the model's defaults.

#### Acceptance Criteria

1. The CDK module SHALL include an `AGENTS.md` file at its root.
2. `AGENTS.md` SHALL document at minimum: stack and construct naming conventions, the requirement that all SNS topics enforce HTTPS-only, the requirement that all SQS queues use encryption at rest, IAM scoping expectations, and tag policy.
3. The editing agent's system prompt SHALL instruct the agent to read `AGENTS.md` before planning any change.

### Requirement 4: Engineering harness, computational sensors

**User Story:** As a forker of this template, I want deterministic, fast structural checks that block bad changes from reaching the preview deploy step, so the inferential review and the post-deploy harness only run on changes that are at least structurally sound.

#### Acceptance Criteria

1. The computational sensor stack SHALL consist of cdk-nag (against the AwsSolutions rule pack by default), `tsc --noEmit`, `eslint`, and unit tests written with `aws-cdk-lib/assertions`.
2. WHEN any computational sensor fails THEN the loop SHALL NOT proceed to the preview deploy step.
3. WHEN any computational sensor fails THEN its structured output SHALL be written to the AgentCore session as context for the agent's next iteration.
4. The repository SHALL document how to swap the cdk-nag rule pack (e.g., to NIST 800-53, HIPAA, or PCI) for teams with stricter requirements.
5. The computational sensor stack SHALL run in under five minutes on the reference module on standard CI hardware.

### Requirement 5: Engineering harness, inferential reviewer

**User Story:** As a forker of this template, I want an inferential review that catches AWS architecture-fitness gaps the structural sensors cannot catch, run as a separate agent so it can serve as a real sensor rather than self-grading.

#### Acceptance Criteria

1. The inferential reviewer SHALL be implemented as a *separate* Strands `Agent` invocation, with its own system prompt, its own model selection (configurable; default: same Claude Sonnet as the editor), and its own tool catalogue.
2. The reviewer's tool catalogue SHALL include only diff-reading and reference-lookup tools. The reviewer SHALL NOT have any file write, deploy, or environment-mutation tools.
3. The reviewer SHALL be scoped to AWS Well-Architected Security and Reliability pillars by default, with documented configuration for adding other pillars.
4. The reviewer SHALL produce a structured checklist output naming each finding, file references, severity, and a suggested fix.
5. WHEN reviewer findings include any severity above the configured threshold THEN the loop SHALL NOT proceed to the preview deploy step until they are addressed in a subsequent iteration.

### Requirement 6: Engineering harness, post-deploy harness

**User Story:** As a forker of this template, I want a synthetic post-deploy check that runs against the deployed preview environment so the loop catches gaps that no in-process sensor can catch (configuration drift, IAM mismatches, network reachability).

#### Acceptance Criteria

1. The synthetic post-deploy harness SHALL run against the preview environment after a successful `cdk deploy`.
2. The post-deploy harness SHALL exercise the deployed system end to end: send a request through the API Gateway, trace the message through the SNS-SQS fan-out, verify the downstream Lambda received the message with the expected encryption properties.
3. WHEN the post-deploy harness fails THEN its structured output (test result, relevant CloudWatch logs, originating diff) SHALL be written to the AgentCore session as context for the agent's next iteration.
4. The post-deploy harness SHALL be implemented as a separate test runner, not as logic inside the editing agent's loop.
5. The post-deploy harness SHALL distinguish between deploy-failure (the `cdk deploy` itself errored) and post-deploy-check-failure (the deploy succeeded but the harness's checks did not pass).

### Requirement 7: Bounded loop

**User Story:** As a developer evaluating this template, I want the closed loop to be bounded by clear trust gates, so the agent's autonomy is legible and adoption-safe.

#### Acceptance Criteria

1. The loop SHALL execute the steps numbered 1 through 12 in Section 4 of `post-draft.md` in that order.
2. The agent SHALL iterate from step 3 (edit) when sensors fail at steps 4-5 OR when the post-deploy harness fails at step 8.
3. The agent SHALL stop and open a PR when the post-deploy harness passes at step 8.
4. A human merge SHALL be required for any change to reach `main`.
5. The preview environment SHALL be torn down on PR close, regardless of merge status.

### Requirement 8: Stop conditions

**User Story:** As an operator of this template, I want explicit stop conditions so the loop is bounded by more than just "until the post-deploy harness passes," so I can trust the agent will not iterate indefinitely.

#### Acceptance Criteria

1. The loop SHALL stop on success (post-deploy harness passes) and open a PR.
2. The loop SHALL stop when an iteration cap is reached (default 5 iterations per trigger, configurable) and open a PR with a "did not converge" status.
3. The loop SHALL stop when a wall-clock cap is reached (default 60 minutes per trigger, configurable) and open a PR with a "timed out" status.
4. The loop SHALL stop when a token-spend cap is reached (default configurable; concrete value pinned during design) and open a PR with a "cost cap reached" status.
5. The loop SHALL stop immediately when an `agent-stop` label is applied to the originating issue or the in-flight PR, and SHALL record the halt reason on the PR.
6. The loop SHALL stop when an oscillation detector trips (configurable heuristics; default: same diff produced twice in three iterations OR sensor results alternating between the same two states) and SHALL record the detector trigger on the PR.

### Requirement 9: Runtime harness boundary

**User Story:** As a security-conscious adopter of this template, I want the runtime harness to enforce limits on what the agent can reach, so the engineering-harness checks do not have to also serve as security boundaries.

#### Acceptance Criteria

1. The agent's IAM role SHALL grant deploy and observe permissions only against the preview environment, scoped by tag and account.
2. The agent's IAM role SHALL deny by default any action against environments other than the preview.
3. The agent SHALL NOT have credentials or tokens granting GitHub merge, branch protection bypass, or repository settings access.
4. The agent's tool registration SHALL be defined declaratively in code that a human can audit, not constructed dynamically at runtime from agent-controlled inputs.
5. The agent's session storage in AgentCore SHALL be scoped per trigger (issue or finding) and SHALL NOT be shared across triggers.

### Requirement 10: Operational contract

**User Story:** As a forker of this template, I want the operational pieces (kill switch, teardown, cost guards, runbook) to ride along with the working code, so I can adopt the template without rebuilding the operational surface.

#### Acceptance Criteria

1. The repository SHALL document a kill switch via the `agent-stop` label and a one-line CLI command equivalent.
2. The repository SHALL include a teardown mechanism that fires on PR close and a scheduled sweep that catches abandoned previews older than a configurable threshold (default 24 hours).
3. The repository SHALL document the per-trigger cost envelope: preview-environment infrastructure cost, agent token cost (editor), reviewer token cost, with measured ranges from the reference module.
4. The repository SHALL include a runbook documenting the failure modes observed during template development: oscillation, post-deploy flakiness, reviewer-vs-computational disagreement, preview teardown failure.
5. All version pins (AgentCore, Strands, CDK, cdk-nag, TypeScript, lint toolchain, model identifiers) SHALL be declared in a single, documented location and SHALL be the versions the template was tested against.

### Requirement 11: Reference CDK module

**User Story:** As a forker of this template, I want the reference module to be small enough to read in one sitting and large enough to demonstrate the engineering harness has something interesting to do.

#### Acceptance Criteria

1. The reference module SHALL implement an event-processing fan-out: API Gateway → Lambda → SNS → SQS → Lambda.
2. The module SHALL include real architecture-fitness concerns the inferential reviewer can catch: HTTPS-only enforcement on SNS, encryption-at-rest on SQS, IAM scoping on the Lambdas.
3. The module SHALL be implemented in TypeScript CDK v2.
4. The module SHALL fit in a single CDK stack of fewer than 500 lines of TypeScript, excluding generated and test files.
5. The module SHALL deploy successfully against a fresh AWS account given the documented prerequisites.

### Requirement 12: Documentation

**User Story:** As a developer who arrives at the repository via the published post, I want a README that lets me decide whether to fork the template, install it, and run my first trigger end to end.

#### Acceptance Criteria

1. The README SHALL link to the published post and state that the post is the canonical reference for the framing.
2. The README SHALL include a "Is this useful for you?" decision section that mirrors the equivalent post subsection.
3. The README SHALL include a quickstart that takes a fresh fork to "trigger the agent on the example issue" in fewer than 30 minutes for someone with the documented prerequisites.
4. The README SHALL document Apache 2.0 licensing.
5. The README SHALL link to this spec and to the `fitness-gap-loop` spec, so a reader can see what is built and what is planned.

## Out of scope

The following are explicitly out of scope for this spec and either belong to `fitness-gap-loop` or to a separate future spec:

- Auto-opening of issues by the inferential reviewer on a schedule. (Goes to `fitness-gap-loop`.)
- The post-deploy harness's gap-closure check (verifying that an originating fitness gap is actually closed in the deployed environment). (Goes to `fitness-gap-loop`.)
- Multi-agent coordination beyond the editor/reviewer pair.
- Autonomous merge or production deploy.
- Self-evolution: the agent editing its own steering files, sensors, or hooks.
- Behavioural correctness beyond what unit tests and the post-deploy harness check.

## Dependencies and prerequisites

- AWS account with permission to create the preview environment infrastructure.
- Access to the AgentCore Harness service.
- Access to the Strands agent framework.
- Access to a Bedrock model the editor and reviewer can call (default: Claude Sonnet, configurable).
- A GitHub repository with Actions enabled.
