# Requirements Document

## Introduction

This spec extends the agent harness template with a second task: a closed loop driven by architecture-fitness gaps surfaced by the inferential reviewer. Where Task 1 (`../feature-change-loop/`) handles human-opened feature requests, Task 2 handles findings produced by the reviewer running on a schedule (or as an upstream PR check) and turns those findings into agent work.

This spec depends on `feature-change-loop` being complete. Task 2 reuses the editor agent, the engineering harness, the bounded loop, the trigger surface, and the operational contract from Task 1; what Task 2 adds is a new trigger producer (the scheduled reviewer that auto-opens issues), a richer post-deploy harness (the gap-closure check), and the configuration and observability needed to operate scheduled reviews safely.

The companion post (`../../post-draft.md` in this workspace) describes both tasks. This spec must stay consistent with the post and with `feature-change-loop`.

The scope is deliberately narrow: this spec adds the auto-open mechanism and the gap-closure check; it does not extend the agent's autonomy past the PR boundary, does not add multi-agent coordination, and does not change any of Task 1's trust gates.

## Glossary

- **Fitness gap:** an architecture-fitness concern surfaced by the inferential reviewer (e.g., SNS topic missing HTTPS-only enforcement, SQS queue missing encryption at rest, IAM role overly permissive).
- **Scheduled reviewer:** a GitHub Actions workflow that invokes the same reviewer agent defined in `feature-change-loop`, on a configurable schedule, against the current state of the CDK module on `main`.
- **Auto-opened issue:** a GitHub issue created programmatically by the auto-open mechanism in response to a fitness-gap finding above the configured severity threshold. Carries `agent-task` and `triage:fitness-gap` labels.
- **Gap-closure check:** a post-deploy probe that verifies the originating fitness gap is no longer exhibited by the deployed preview environment. Probes the deployed resource directly rather than the source code or the synthesised CloudFormation.
- **Trigger type:** a field in the AgentCore payload that distinguishes `feature-change` triggers (Task 1) from `fitness-gap` triggers (Task 2). Determines which post-deploy expectations apply.
- All other terms inherit definitions from the `feature-change-loop` glossary.

## Requirements

### Requirement 1: Scheduled reviewer

**User Story:** As a maintainer of the CDK module, I want the inferential reviewer to run on a schedule against the module so that architecture-fitness gaps are surfaced even when no human or agent has touched the code recently.

#### Acceptance Criteria

1. WHEN a configurable schedule fires (default: daily at a configurable time) THEN a GitHub Action SHALL invoke the reviewer agent against the current state of the CDK module on `main`.
2. WHEN the schedule invokes the reviewer THEN the reviewer SHALL produce the same structured checklist output it produces during Task 1 (one entry per finding, with file references, severity, and a suggested fix).
3. The schedule SHALL be configurable in a single, documented location.
4. The scheduled reviewer SHALL run in the same isolation as the per-PR reviewer in Task 1 (separate Strands `Agent` invocation, no edit or deploy tools).
5. WHEN the scheduled reviewer fails (model unavailable, timeout, permissions error) THEN the failure SHALL be recorded as a GitHub Action failure visible to maintainers AND SHALL NOT silently retry indefinitely.

### Requirement 2: Auto-open issues from findings

**User Story:** As a maintainer, I want findings above a severity threshold to auto-open GitHub issues with the right label and structured body, so the existing Task 1 trigger surface picks them up without new plumbing.

#### Acceptance Criteria

1. WHEN the scheduled reviewer produces a finding above a configurable severity threshold (default: HIGH and CRITICAL) THEN the system SHALL open a GitHub issue with the `agent-task` label and a `triage:fitness-gap` tag.
2. The issue body SHALL include at minimum: the finding's structured output, the affected file path(s), the severity, the suggested fix, the date and identifier of the reviewer run that produced it, and a marker identifying it as auto-opened.
3. WHEN an open issue already exists for the same finding (matched by a content-derived signature) THEN the system SHALL NOT open a duplicate; it MAY add a comment recording the new run.
4. The auto-open mechanism SHALL never apply the `agent-task` label without also applying `triage:fitness-gap`, so maintainers can filter auto-opened issues from human-opened ones.
5. The auto-open mechanism SHALL be configurable (severity threshold, labels, deduplication behaviour) in the same documented location as the schedule.

### Requirement 3: Trigger payload extension

**User Story:** As the editing agent, I want auto-opened fitness-gap issues to be distinguishable from human-opened feature-change issues, so I can read the right context and apply the right post-deploy expectations.

#### Acceptance Criteria

1. The GitHub Action defined in `feature-change-loop` Requirement 1 SHALL recognise the `triage:fitness-gap` tag on an `agent-task`-labelled issue and set the trigger type in the AgentCore payload to `fitness-gap` instead of `feature-change`.
2. WHEN the trigger type is `fitness-gap` THEN the AgentCore payload SHALL include the originating finding's signature so the post-deploy harness can verify gap closure (see Requirement 4).
3. The editing agent's behaviour SHALL be the same in both trigger types except where Requirement 4 (gap-closure check) extends the post-deploy harness.
4. WHEN an `agent-task`-labelled issue carries neither `triage:fitness-gap` nor any equivalent triage tag THEN the trigger type SHALL default to `feature-change`.

### Requirement 4: Gap-closure check in the post-deploy harness

**User Story:** As a forker of this template, I want the post-deploy harness to verify that the originating fitness gap is actually closed in the deployed preview environment, so the closed-loop architecture-fitness sensor demonstrates its full job.

#### Acceptance Criteria

1. WHEN the trigger type is `fitness-gap` THEN the post-deploy harness SHALL include a check that the deployed preview environment no longer exhibits the originating finding.
2. The gap-closure check SHALL run against the *deployed* environment, not against the source code or the synthesised CloudFormation. (The intent is to catch the case where the code looks fixed but the deployed system still does not exhibit the desired property.)
3. The gap-closure check SHALL be defined for at least the three architecture-fitness concerns demonstrated in the reference module: HTTPS-only on SNS, encryption-at-rest on SQS, IAM scoping on the Lambdas. Each check SHALL probe the deployed resource directly (e.g., describe the SNS topic policy, describe the SQS queue attributes, describe the Lambda execution role).
4. WHEN the gap-closure check fails on a `fitness-gap` trigger THEN the failure SHALL be written to the AgentCore session as context for the next iteration with the same shape as other post-deploy harness failures.
5. WHEN the gap-closure check passes AND all other post-deploy checks pass THEN the agent SHALL stop and open the PR with a section in the description noting which gap was closed and how the check verified it.

### Requirement 5: Observability and reporting

**User Story:** As an operator running the scheduled reviewer over time, I want enough visibility into reviewer runs and auto-opened issues to know whether the system is working, drifting, or thrashing.

#### Acceptance Criteria

1. The system SHALL emit a structured run record for every scheduled reviewer invocation: timestamp, model identifier and version, number of findings produced by severity, number of issues opened, number of duplicates skipped.
2. The repository SHALL include a documented query (CloudWatch Insights, GitHub query, or simple script) that summarises the last N reviewer runs.
3. The system SHALL emit a structured outcome record for every auto-opened issue once it closes (merged, closed without merge, expired): time-to-PR-open, number of agent iterations, post-deploy outcome, gap-closure outcome.
4. The runbook SHALL document signs that the reviewer is drifting (sudden jump in findings, repeated identical findings that the agent fails to close) and the first-move responses for each.
5. The repository SHALL include guardrails that fail loudly if reviewer cost (token spend per run) crosses a configurable threshold.

### Requirement 6: Integration with feature-change-loop

**User Story:** As a maintainer, I want Task 2's additions to integrate cleanly with Task 1 so I can adopt them incrementally and so the two tasks share the trust gates and operational contract.

#### Acceptance Criteria

1. Task 2 SHALL NOT change any behaviour required by `feature-change-loop` for `feature-change`-typed triggers.
2. Task 2 SHALL NOT add new tools to the editing agent's catalogue. (The editor's tool catalogue is fixed in `feature-change-loop` Requirement 2.)
3. Task 2 SHALL NOT relax any IAM scoping, kill switch, or trust gate defined in `feature-change-loop`.
4. Task 2's auto-open mechanism SHALL be disable-able via a single configuration flag, so a fork that does not want scheduled reviews can stay on Task 1 behaviour without code changes.
5. Task 2's gap-closure check SHALL be skipped for `feature-change`-typed triggers.

### Requirement 7: Documentation

**User Story:** As a forker arriving at the template after Task 2 ships, I want documentation that describes both tasks together and explains where the line between them sits.

#### Acceptance Criteria

1. The README SHALL describe both tasks and link to both specs.
2. The README SHALL document the configuration knobs added by Task 2: schedule, severity threshold, auto-open labels, deduplication behaviour, gap-closure check selection.
3. The runbook (defined in `feature-change-loop` Requirement 10) SHALL be extended with the failure modes specific to Task 2: scheduled reviewer drift, auto-open duplication, gap-closure flakiness.
4. The "Is this useful for you?" section in the post and README SHALL note that Task 2 requires a tolerance for scheduled, autonomous issue creation; teams that need every agent task to start with a human action should leave Task 2 disabled.

## Out of scope

The following are explicitly out of scope for this spec:

- Extending the closed loop past the PR boundary (autonomous merge, production deploy, post-merge auto-correction). The post's Section 3 covers what would need to be true for that step; it is not solved here.
- Multi-pillar Well-Architected coverage beyond Security and Reliability. Adding pillars is documented as a configuration extension, not a Task 2 deliverable.
- Cross-account or cross-region scheduled reviews. Single account, single region by default.
- Replacing the editor agent or the runtime harness with alternatives. The two-layer split is preserved as scoped in `feature-change-loop`.
- A meta-loop where the agent edits its own steering files, sensors, or hooks based on reviewer feedback over time.

## Dependencies and prerequisites

- All of `feature-change-loop` complete and merged.
- The scheduled reviewer requires the same Bedrock access as Task 1.
- Auto-open requires GitHub Actions permissions to create issues and apply labels in the repository.
- Gap-closure checks require the agent's IAM role to include read-only describe permissions for SNS, SQS, and IAM in the preview environment (extension to the IAM scope defined in `feature-change-loop` Requirement 9).
