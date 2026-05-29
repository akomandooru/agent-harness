# Implementation Plan

## Overview

This plan turns the requirements and design into buildable, ordered tasks. Tasks are scoped so each one ends with something runnable or testable. Tasks reference the requirements they implement; the design document holds the structural decisions each task carries through.

The order respects dependencies: foundations (repository, config, CDK module) come first, then the tool catalogue and wrappers (the security boundary), then the agents that use them, then the trigger surface and operational contract, then the documentation. Acceptance gating (the live-fire smoke test from design's Testing Strategy) is the last task.

## Tasks

- [x] 1. Bootstrap repository skeleton

  - Initialise the repository with TypeScript, pnpm or npm workspaces, and Apache 2.0 license file.
  - Add baseline `.gitignore`, `.editorconfig`, and `.nvmrc` matching the design's pinned Node version.
  - Add `agent-harness.config.json` at repo root with the schema from `design.md` Data Models section, populated with the design's defaults (iteration cap 5, wall-clock 60 minutes, token-spend 10 USD, cdk-nag rule pack `AwsSolutions`, reviewer severity threshold MEDIUM, sweep interval 6 hours, sweep max age 24 hours).
  - Add a config validator (`scripts/validate-config.ts`) that runs in CI and rejects missing or malformed fields.
  - Verification: `npm run validate-config` passes against the shipped config.
  - _Requirements: 10.5_

- [x] 2. Build the reference CDK module

  - [x] 2.1 Scaffold `modules/fanout/` with CDK v2 in TypeScript.
    - Create `bin/`, `lib/`, `test/` directories and `cdk.json` with `app: "npx ts-node bin/fanout.ts"`.
    - Pin CDK and `aws-cdk-lib` versions in `package.json`.
    - Verification: `npm run cdk synth` produces a valid template.
    - _Requirements: 11.3, 11.5_

  - [x] 2.2 Implement `FanoutStack` (`lib/fanout-stack.ts`).
    - Define the resources from `design.md` Data Models: `RestApi`, `IngressFn`, `Topic`, `Queue` (KMS-encrypted), `EgressFn`, subscription with optional filter slot, IAM roles least-scoped per function.
    - Apply `agent-harness/session` and `agent-harness/env` tags from CDK context.
    - Enforce HTTPS-only on the SNS topic via topic policy; encryption-at-rest on SQS via KMS; IAM roles scoped per function.
    - Constraint: stack stays under 500 lines of TypeScript excluding generated and test files.
    - Verification: stack synthesises against the AwsSolutions cdk-nag rule pack with no expected baseline findings.
    - _Requirements: 11.1, 11.2, 11.4, 11.5_

  - [x] 2.3 Add `aws-cdk-lib/assertions` unit tests for `FanoutStack` (`test/fanout-stack.test.ts`).
    - Assert each resource exists with the required encryption, HTTPS-only, and IAM properties.
    - Cover the construct-shape expectations the design names as the unit-test sensor's responsibility.
    - Verification: `npm test` passes.
    - _Requirements: 4.1, 11.1_

  - [x] 2.4 Author `modules/fanout/AGENTS.md` (the steering file).
    - Document stack and construct naming conventions, the HTTPS-only-on-SNS rule, the encryption-at-rest-on-SQS rule, IAM scoping expectations, and tag policy.
    - Reference the rules in language the editor agent's system prompt can quote.
    - Verification: a human review confirms the file matches the design's Engineering harness layer description.
    - _Requirements: 3.1, 3.2_

- [x] 3. Implement tool wrappers (the security boundary)

  - [x] 3.1 Define shared wrapper plumbing (`agents/shared/wrapper.ts`).
    - Implement input/output JSON-schema validation for tools.
    - Implement path-scope enforcement: any path argument must start with `module.path` and must not contain `..`, symlink components, or absolute paths outside the module root.
    - Implement structured logging that writes tool inputs and outputs to the AgentCore session record.
    - Implement cost-counter hooks for token-using tools (reviewer invocations) and for cdk-deploy.
    - Verification: wrapper unit tests cover schema rejection, path violation rejection, cost accounting, and logging shape.
    - _Requirements: 2.3, 9.4_

  - [x] 3.2 Implement file-tool wrappers (`agents/editor/tools/module.ts`).
    - `module.readFile`, `module.writeFile`, `module.listFiles`, `module.diff` with the shapes from `design.md` Tool catalogue table.
    - Verification: unit tests cover happy paths and rejection paths (out-of-scope paths, symlink attempts, oversized writes).
    - _Requirements: 2.2, 2.3_

  - [x] 3.3 Implement CDK-tool wrappers (`agents/editor/tools/cdk.ts`).
    - `cdk.diff` and `cdk.deploy` against the preview environment, hard-coded to the preview context.
    - Tag every deployed resource with `agent-harness/session` and `agent-harness/env=preview`.
    - Verification: integration tests against a local-mock CDK runner exercise the deploy/teardown path.
    - _Requirements: 2.2, 9.1, 9.2_

  - [x] 3.4 Implement sensor-tool wrappers (`agents/editor/tools/sensors.ts`).
    - `sensor.cdkNag`, `sensor.tsc`, `sensor.eslint`, `sensor.unitTests`, each producing the typed output contracts from `design.md` Data Models.
    - Each sensor wrapper invokes the underlying tool, parses its output, and conforms to the shared output shape.
    - Verification: sensor self-tests against fixtures cover passing and failing cases for each sensor.
    - _Requirements: 4.1, 4.2, 4.3, 4.5_

  - [x] 3.5 Implement preview-observation wrappers (`agents/editor/tools/preview.ts`).
    - `preview.cwLogs` and `preview.cwMetrics` against the preview environment only, scoped by `agent-harness/session` tag.
    - Verification: integration tests with mocked CloudWatch exercise log fetch and metric fetch with tag-scoped credentials.
    - _Requirements: 2.2, 9.1_

  - [x] 3.6 Implement PR-creation wrapper (`agents/editor/tools/pr.ts`).
    - `pr.open` accepts a title, body, branch, and base ref; uses the short-lived `auth.githubInstallationToken` from the session payload.
    - Wrapper redacts the token from any logged inputs.
    - Verification: unit tests cover token redaction and a recorded GitHub API fixture for the create-PR call.
    - _Requirements: 2.5, 9.3_

- [x] 4. Implement the synthetic post-deploy harness

  - Create `harness/post-deploy/` as a separate test runner package.
  - Implement the smoke flow from `design.md`: send a request through API Gateway, trace the message through SNS → SQS, assert the EgressFn received it with expected encryption properties.
  - Distinguish `deploy-failure` (when invoked but the deploy itself errored upstream) from `pass | fail | partial`.
  - Output the typed contract from `design.md` Data Models (`PostDeployOutput`).
  - Implement the `postDeploy.invoke` tool wrapper that the editor agent calls (`agents/editor/tools/post-deploy.ts`).
  - Verification: harness self-tests run against a mocked preview environment; the runner returns `pass`, `fail`, `partial`, and `deploy-failure` correctly across fixtures.
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 5. Implement the reviewer agent

  - [x] 5.1 Define reviewer system prompt (`agents/reviewer/system.md`).
    - Orient the reviewer to produce Well-Architected reviews on Security and Reliability pillars by default.
    - Specify the structured-checklist output schema; instruct the reviewer not to propose edits.
    - Pin a versioned identifier the reviewer agent definition references.
    - _Requirements: 5.1, 5.3_

  - [x] 5.2 Embed Well-Architected reference checklists for Security and Reliability (`agents/reviewer/checklists/`).
    - Source the checklist items from the AWS Well-Architected pillar references; include each item's id, severity guidance, and what to look for.
    - Embed in the repository (per `design.md` deferred-decisions: lean toward embedded for forkability).
    - Verification: a unit test asserts every checklist item has the required fields.
    - _Requirements: 5.3_

  - [x] 5.3 Define reviewer tool catalogue (`agents/reviewer/tools.ts`).
    - `module.readFile` and `module.diff` (read-only), `reference.checklist` to fetch a pillar's checklist.
    - Reject any other tool registration at runtime.
    - Verification: unit tests cover catalogue declaration and rejection of non-catalogue tools.
    - _Requirements: 5.2_

  - [x] 5.4 Implement reviewer agent definition (`agents/reviewer/agent.ts`).
    - Strands `Agent` configured with the system prompt, the model from `agent-harness.config.json`, and the reviewer tool catalogue.
    - The wrapper that invokes the reviewer (called by the editor's `reviewer.invoke`) accepts only a diff input and rejects pass-through prompts from the editor.
    - Verification: agent integration tests on recorded fixtures (a diff with a known HTTPS-only gap) produce the expected structured findings.
    - _Requirements: 5.1, 5.4, 5.5_

- [x] 6. Implement the editor agent

  - [x] 6.1 Define editor system prompt (`agents/editor/system.md`).
    - Orient the editor to maintain the CDK module at `module.path`, read `AGENTS.md` before any change, only use catalogued tools, call `postDeploy.invoke` after every successful `cdk deploy`, and stop only on success or stop condition.
    - Include explicit instructions to ignore "ignore previous instructions"-style patterns from the issue body (the wrapper layer is the real defence; the prompt is the stated intent).
    - Pin a versioned identifier the editor agent definition references.
    - _Requirements: 2.1, 2.4, 3.3_

  - [x] 6.2 Implement editor agent definition (`agents/editor/agent.ts`).
    - Strands `Agent` configured with the system prompt, the model from `agent-harness.config.json`, and the full editor tool catalogue from task 3.
    - Verification: a smoke test where the editor edits a single file via `module.writeFile` and reads it back via `module.readFile` succeeds.
    - _Requirements: 2.1, 2.2_

  - [x] 6.3 Implement PR body templates (`agents/editor/pr-body.template.md` and `pr-body-partial.template.md`).
    - Success template: trigger summary, change summary, file diff highlights, sensor results table, post-deploy summary, preview link, session log link.
    - Partial template: top banner with termination reason, embedded session log, recommended next-step note.
    - Verification: snapshot tests against synthetic session fixtures produce the expected rendered PR bodies.
    - _Requirements: 2.5, 8.2, 8.3, 8.4, 8.5, 8.6_

- [ ] 7. Implement the bounded loop runner

  - [x] 7.1 Implement session-update logic (`harness/loop/session.ts`).
    - Append iteration records, write termination records, update cost counters, redact secrets.
    - Verification: unit tests cover append, terminate, redact, and read-back roundtrip.
    - _Requirements: 9.5_

  - [x] 7.2 Implement stop-condition checker (`harness/loop/stop-conditions.ts`).
    - Implement the deterministic ordering from `design.md`: `agent-stop` label poll, iteration cap, wall-clock cap, token-spend cap, oscillation detector.
    - Implement the oscillation detector with the configured windows (`oscillation.sameDiffWindow`, `oscillation.alternationWindow`).
    - Verification: unit tests cover each stop condition individually; a property test asserts only one termination reason fires per session trace (correctness Property 2).
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [x] 7.3 Implement the loop body (`harness/loop/run.ts`).
    - Translate the pseudo-code from `design.md` Behavioural design into TypeScript: read context, plan and edit, run computational sensors, run reviewer, deploy, run post-deploy harness, decide.
    - Wire each gate to the stop-condition checker and to session updates.
    - Verification: agent integration tests on recorded fixture triggers converge in ≤ iteration cap; property tests cover Properties 1 (gate ordering) and 3 (iteration cap honesty).
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 7.4 Implement loop entry point and AgentCore endpoint (`harness/loop/entry.ts`).
    - Receive the trigger payload, validate against the schema in `design.md`, create the AgentCore session, spawn the loop, return the PR number on completion.
    - Wire to the AgentCore endpoint the GitHub Action will call.
    - Verification: integration tests against a recorded payload produce a session record with the expected shape.
    - _Requirements: 1.3, 9.5_

- [x] 8. Implement the GitHub trigger surface

  - [x] 8.1 Author the GitHub issue template (`.github/ISSUE_TEMPLATE/agent-task.yml`).
    - Capture target module path, change description, optional acceptance criteria.
    - Include a YAML body that parses cleanly into the structured fields the trigger payload needs.
    - Verification: a manual test opens an issue from the template and confirms the structured fields render as expected.
    - _Requirements: 1.5_

  - [x] 8.2 Implement the dispatch GitHub Action (`.github/workflows/dispatch-agent-task.yml`).
    - Trigger on `issues.labeled` for `agent-task`.
    - Validate the issue template fields, build the payload, sign and POST to the AgentCore endpoint.
    - On any failure, comment on the issue with the error and exit non-zero (Requirement 1.4).
    - Mint a short-lived GitHub installation token scoped to PR creation; pass it in the payload.
    - Refuse to start a new session if one is already in flight for the same issue (concurrency rule from `design.md` Error Handling).
    - Verification: workflow dry-run with a fixture issue produces the expected payload; failure-injection tests verify the comment-and-exit path.
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 8.3 Implement the kill-switch handler (`.github/workflows/agent-stop.yml`).
    - Trigger on `issues.labeled` and `pull_request.labeled` for `agent-stop`.
    - Signal the in-flight loop to halt (writes to a session-scoped flag the stop-condition checker reads).
    - Verification: a fixture session reaches the kill-switch flag check and terminates with reason `kill-switch`.
    - _Requirements: 8.5, 10.1_

  - [x] 8.4 Document the one-line CLI kill-switch equivalent.
    - Add a script `scripts/agent-stop.ts` that performs the same flag write directly (for cases where GitHub UI is not convenient).
    - Document usage in the runbook.
    - _Requirements: 10.1_

- [x] 9. Implement IAM and the preview environment lifecycle

  - [x] 9.1 Define the agent IAM policies in CDK (`infrastructure/iam-stack.ts`).
    - Editor agent role: `cdk diff`, `cdk deploy`, CloudWatch read on resources tagged `agent-harness/session = <session>` AND `agent-harness/env = preview` in the template account; deny everything else.
    - Reviewer agent role: read-only access to checklist storage; no CDK, CloudWatch, or GitHub.
    - GitHub Action runner: AgentCore endpoint invocation and issue-comment write.
    - Verification: a CDK assertions test enforces the policy structure; a runtime smoke test confirms the editor cannot reach a non-preview environment.
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 9.2 Implement preview-environment teardown.
    - On PR close (workflow `.github/workflows/preview-teardown.yml`), destroy the CDK stack tagged with the session id.
    - Implement the scheduled sweep (`scripts/sweep-previews.ts` invoked by `.github/workflows/preview-sweep.yml`) that destroys preview stacks older than `preview.sweepMaxAgeHours`.
    - Verification: integration tests with mocked CDK destroy confirm both the on-close and the scheduled-sweep paths.
    - _Requirements: 7.5, 10.2_

- [x] 10. Implement the operational contract

  - [x] 10.1 Pin all versions in a single location.
    - Declare AgentCore SDK version, Strands version, CDK version, cdk-nag version, TypeScript version, ESLint version, model identifiers, and Bedrock region in `agent-harness.config.json` plus `package.json` lock files.
    - Add a CI check that fails if version drift is detected against the config.
    - _Requirements: 10.5_

  - [x] 10.2 Author the runbook (`docs/runbook.md`).
    - Document failure modes from `design.md` Error Handling: oscillation, post-deploy flakiness, reviewer-vs-computational disagreement, preview teardown failure, AgentCore session-storage unavailability.
    - For each, list symptoms, diagnosis steps, and the first-move response.
    - Include the kill-switch invocation (label and CLI).
    - Include guidance for "how to restart a halted session" (remove and re-apply `agent-task` label).
    - _Requirements: 10.4_

  - [x] 10.3 Author cost notes (`docs/cost-envelope.md`).
    - Document measured ranges from the live-fire smoke test (task 12) for: preview infra cost per trigger, editor token cost per trigger, reviewer token cost per trigger, total cost per trigger across iteration counts.
    - Document guardrails: the `tokenSpendCapUSD` default and how to set CloudWatch billing alarms.
    - _Requirements: 10.3_

- [x] 11. Implement README and quickstart

  - Write `README.md` covering the "Is this useful for you?" decision section (mirroring the post), prerequisites, quickstart for first trigger, link to the published post, link to both spec directories, Apache 2.0 declaration.
  - Write `docs/quickstart.md` with the 30-minute happy path: clone, configure, deploy AgentCore endpoint, create example issue, watch the loop converge.
  - Verification: a fresh checkout on a clean machine reaches "first trigger converges" within the documented window.
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

- [x] 12. Acceptance gating

  - Run unit and property-based tests; all must pass.
  - Run sensor self-tests against the reference fixtures; all must pass.
  - Synthesise the reference module and confirm cdk-nag produces the expected baseline findings.
  - Run agent integration tests on the recorded fixture triggers; all must converge within iteration caps.
  - Run a live-fire smoke test: open an issue from the issue template with the example trigger ("add a dead-letter queue to the SQS subscriber"), apply `agent-task`, watch a successful PR open end-to-end against a clean preview environment, confirm teardown on PR close.
  - Record measured costs from the live-fire run; update `docs/cost-envelope.md`.
  - Tag the release.
  - _Requirements: 7 entire, 8 entire, 11.5, 12.3_

## Task Dependency Graph

```json
{
  "waves": [
    {
      "wave": 1,
      "description": "Foundation. Repository skeleton and config validation must land before anything else.",
      "tasks": ["1"]
    },
    {
      "wave": 2,
      "description": "Independent authoring and CDK scaffolding. All depend only on wave 1 and can run in parallel.",
      "tasks": ["2.1", "2.4", "5.1", "5.2", "6.1", "8.1"]
    },
    {
      "wave": 3,
      "description": "CDK module body, shared wrapper plumbing, IAM policies. Each builds on its wave-2 prerequisite.",
      "tasks": ["2.2", "3.1", "9.1"]
    },
    {
      "wave": 4,
      "description": "CDK assertions tests and tool wrappers that depend on wave 3.",
      "tasks": ["2.3", "3.2", "3.3", "3.5", "3.6", "5.3", "9.2"]
    },
    {
      "wave": 5,
      "description": "Sensor wrappers, post-deploy harness, and reviewer agent definition. All require their wave-4 prerequisites.",
      "tasks": ["3.4", "4", "5.4"]
    },
    {
      "wave": 6,
      "description": "Editor agent and PR body templates. Editor requires the full tool catalogue, the reviewer, and the post-deploy harness.",
      "tasks": ["6.2", "6.3"]
    },
    {
      "wave": 7,
      "description": "Bounded loop runner. Each subtask builds on the previous within the wave.",
      "tasks": ["7.1", "7.2", "7.3", "7.4"]
    },
    {
      "wave": 8,
      "description": "GitHub trigger surface. Requires the loop entry point.",
      "tasks": ["8.2", "8.3", "8.4"]
    },
    {
      "wave": 9,
      "description": "Operational contract pieces that do not depend on live-fire measurements.",
      "tasks": ["10.1", "10.2", "11"]
    },
    {
      "wave": 10,
      "description": "Acceptance gating. Live-fire smoke test produces the cost numbers consumed by 10.3.",
      "tasks": ["12"]
    },
    {
      "wave": 11,
      "description": "Cost notes. Captures measured ranges from wave 10's live-fire run.",
      "tasks": ["10.3"]
    }
  ],
  "criticalPath": ["1", "2.1", "2.2", "3.1", "3.4", "4", "6.2", "7.3", "7.4", "8.2", "12"],
  "notes": [
    "Subtasks within wave 7 (7.1 -> 7.2 -> 7.3 -> 7.4) are sequential; the wave is one band only because the entries share a parent task.",
    "Wave 11 (task 10.3) is intentionally after wave 10 because the cost envelope cannot be written until live-fire measurements exist.",
    "Tasks in the same wave are independent and can run in parallel. Tasks across waves must respect wave order."
  ]
}
```

Critical path: 1 → 2.1 → 2.2 → 3.1 → 3.4 → 4 → 6.2 → 7.3 → 7.4 → 8.2 → 12. The reference module, the wrappers, the editor, the loop, and the dispatch Action are the load-bearing chain. Everything else either supports the chain (5, 9, 10) or documents it (11).

Parallelisation opportunities:
- Tasks 2.4 (AGENTS.md), 5.1 (reviewer system prompt), 6.1 (editor system prompt), and 8.1 (issue template) are pure authoring with no code dependencies; they can land any time after task 1.
- Task 9 (IAM and preview lifecycle) can run in parallel with the agent and loop work once task 1 is complete.
- Task 10.2 (runbook) can be drafted in parallel with later development; it converges with task 12 because the runbook absorbs lessons from acceptance gating.

## Notes

A few execution-time conventions worth setting before work starts:

- *Each task lands as its own pull request, in its own branch.* The harness template will eventually use itself; landing tasks one at a time is consistent with the bounded loop the template demonstrates.
- *Verification is part of the task, not a follow-up.* Each task's "verification" line is the acceptance criterion for the PR. A task is not done until verification passes in CI.
- *Decisions deferred in the design (action language, checklist storage, cost-counter granularity, smoke-test schedule) get pinned in the task that first needs them.* Each pin gets a one-line rationale in the task's PR description, and any pin that contradicts the design's lean is escalated to a design-doc revision before merging.
- *The token-spend cap default (10 USD) is provisional.* Task 12's live-fire run produces measured numbers. If the measured cost across iteration counts is meaningfully different (off by 2x or more), the cap is revised and both the spec and the design are updated before the release tag.
- *Task 2.2's "no expected baseline findings" constraint is the cleanliness bar.* If cdk-nag flags something legitimate that the team accepts (with rationale), it goes in a documented suppression list, not an exception in the rule pack.
