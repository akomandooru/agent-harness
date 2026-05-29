# Implementation Plan: AgentCore E2E Smoke

## Overview

This plan wires the agent-harness template end-to-end against AWS Bedrock AgentCore Managed Harness and fixes the terminology in the public docs to match AWS's current naming. Work proceeds bottom-up: first the version pins and config delta that everything else depends on, then the declarative `harness.json` files, then the two `InvokeHarness`-backed invocation classes, then the Lambda handler that wires them into `runLoop()` via `LoopGates`, then the CDK stack and IAM updates that put API Gateway + IAM auth in front of the Lambda, then the dispatch workflow's SigV4 signing, then the live smoke-test script, and finally the documentation terminology updates with a CI check that pins the new vocabulary.

The design's Testing Strategy section concludes that PBT is not appropriate for this feature (it is configuration wiring and integration glue, not algorithmic code). The plan below uses unit tests (with `aws-sdk-client-mock` for `BedrockAgentCoreClient`), CDK snapshot tests via `Template`, an integration test that validates `harness.json` shape against the agent definitions, and the live smoke test as the canonical wiring gate.

Convert the feature design into a series of prompts for a code-generation LLM that will implement each step with incremental progress. Make sure that each prompt builds on the previous prompts, and ends with wiring things together. There should be no hanging or orphaned code that isn't integrated into a previous step. Focus ONLY on tasks that involve writing, modifying, or testing code.

## Tasks

- [x] 1. Update version pins and `agent-harness.config.json` schema delta
  - [x] 1.1 Add `@aws/agentcore@preview` and `@aws-sdk/client-bedrock-agentcore` dependencies with exact pins
    - Add `@aws-sdk/client-bedrock-agentcore` (exact version pin, no `^` or `~`) to `agents/editor/package.json`, `harness/scheduled-reviewer/package.json`, and any other package that imports it
    - Add `@aws/agentcore@preview` to the root or `infrastructure/package.json` as appropriate (CLI dependency only)
    - Run the install in each affected package to materialize the lock files
    - _Requirements: 5.5, 7.5_

  - [x] 1.2 Update `agent-harness.config.json`: replace `agentcore.endpoint`, update `versions`, add `orchestrator.apiGatewayEndpoint`
    - Remove the `agentcore.endpoint` field and add `orchestrator.apiGatewayEndpoint` set to a templated value documented in `docs/quickstart.md` (the operator fills it post-deploy)
    - Keep `agentcore.regionalRouting`
    - Replace `versions.agentcoreSdk` placeholder with the exact version of `@aws/agentcore@preview` resolved from the preview channel
    - Add `versions.bedrockAgentCoreSdk` set to the exact version of `@aws-sdk/client-bedrock-agentcore` installed in 1.1
    - Remove `versions.strands`
    - _Requirements: 5.4, 7.1, 7.2, 7.3, 8.5_

  - [x] 1.3 Update `schemas/agent-harness-config.schema.json` to match the config delta
    - Remove `agentcore.endpoint`, add `orchestrator.apiGatewayEndpoint`, drop `versions.strands`, add `versions.bedrockAgentCoreSdk`
    - Ensure `scripts/validate-config.ts` still passes against the updated config
    - _Requirements: 5.4, 7.1, 7.2, 7.3, 8.5_

  - [x] 1.4 Verify `scripts/check-version-drift.ts` exits 0 against the updated pins*
    - Run `npx ts-node scripts/check-version-drift.ts` and confirm no drift is reported
    - If the script needs a small update to recognise `bedrockAgentCoreSdk`, make the change here
    - _Requirements: 7.4_

- [x] 2. Declare the editor and reviewer Managed Harness configs and the AgentCore project descriptor
  - [x] 2.1 Create `app/editor/harness.json` declaring the editor Managed Harness
    - Reference the model from `agent-harness.config.json` `models.editor`
    - Reference the system prompt at `agents/editor/system.md` via `$ref`
    - Register the 15 tools listed in `EDITOR_TOOL_NAMES` (from `agents/editor/agent.ts`) — exact match, same order
    - Reference the iteration cap from `agent-harness.config.json` `limits.iterationCap`
    - Set `memory.type` to `"session"`
    - _Requirements: 3.1_

  - [x] 2.2 Create `app/reviewer/harness.json` declaring the reviewer Managed Harness
    - Reference the model from `agent-harness.config.json` `models.reviewer`
    - Reference the system prompt at `agents/reviewer/system.md` via `$ref`
    - Register exactly the three tools in `REVIEWER_TOOL_NAMES` (`module.readFile`, `module.diff`, `reference.checklist`) — no write tools, no CDK tools
    - Reference the iteration cap from `agent-harness.config.json` `limits.iterationCap`
    - Set `memory.type` to `"session"`
    - _Requirements: 2.1_

  - [x] 2.3 Create `agentcore/agentcore.json` declaring the AgentCore project
    - Declare `project: "agent-harness"`, account from `${AWS_ACCOUNT_ID}`, region from `${agentcore.regionalRouting}`
    - List the two harnesses: `editor-agent` referencing `../app/editor/harness.json` and `reviewer-agent` referencing `../app/reviewer/harness.json`
    - _Requirements: 5.1_

  - [x] 2.4 Write integration test validating `harness.json` shape against agent definitions
    - Place at `app/__tests__/harness-config.test.ts` (or a similar package home — choose based on which `package.json` has Jest configured)
    - Load both `harness.json` files. For each, assert: tool list matches `EDITOR_TOOL_NAMES` / `REVIEWER_TOOL_NAMES` exactly; model field references a valid `agent-harness.config.json` `models.*` entry; system prompt path resolves to an existing file on disk; iteration cap matches `agent-harness.config.json` `limits.iterationCap`
    - This catches drift between the harness configs and the editor/reviewer agent definitions before deploy
    - _Requirements: 2.1, 3.1_

- [x] 3. Implement `ManagedHarnessReviewerInvocation` and replace `StrandsReviewerInvocation`
  - [x] 3.1 Implement `ReviewerHarnessClient` and `ManagedHarnessReviewerInvocation` in `harness/scheduled-reviewer/src/run.ts`
    - Add `ReviewerHarnessClient` class that calls `InvokeHarness` via `@aws-sdk/client-bedrock-agentcore` against the reviewer harness ARN with session id `<sessionId>-reviewer`
    - Replace the `StrandsReviewerInvocation` class with `ManagedHarnessReviewerInvocation` implementing `StandaloneReviewerInvocation` and backed by `ReviewerHarnessClient`
    - Constructor takes `{ harnessArn, sessionId, client? }`; the client is injectable for tests
    - On `invoke({ diff }?)`: serialise input, issue `InvokeHarnessCommand`, consume the streaming response, parse the `final` event's output into `StandaloneReviewerResult { findings, tokenCostUSD, modelVersion }`
    - On a malformed response: populate available partial fields (default missing `tokenCostUSD` to 0; default malformed `findings` to `[]`) and only then propagate the parse error
    - Remove the exports `StrandsReviewerInvocation` and `StrandsNotImplementedError`
    - _Requirements: 2.2, 2.3, 2.4, 2.6_

  - [x] 3.2 Update `runScheduledReviewer()` and existing callers to use `ManagedHarnessReviewerInvocation`
    - Replace the default `new StrandsReviewerInvocation()` with `new ManagedHarnessReviewerInvocation({ harnessArn, sessionId })` in `runScheduledReviewer()`
    - The reviewer harness ARN is read from an env var (e.g., `REVIEWER_HARNESS_ARN`); the scheduled workflow supplies it
    - Update any other callers of `StrandsReviewerInvocation` (search the workspace for stray references) to use the new class
    - _Requirements: 2.4_

  - [x] 3.3 Write unit tests for `ManagedHarnessReviewerInvocation`
    - Place at `harness/scheduled-reviewer/__tests__/managed-harness-invocation.test.ts`
    - Use `aws-sdk-client-mock` to stub `BedrockAgentCoreClient`
    - Test: canned streaming response → `StandaloneReviewerResult` with correct `findings`, `tokenCostUSD`, `modelVersion`
    - Test: SDK throws → error propagated
    - Test: malformed `final` event (missing `tokenCostUSD`, malformed `findings`) → partial-result population, then error propagated
    - Test: session id is built as `<sessionId>-reviewer`
    - _Requirements: 2.3, 2.6_

  - [x] 3.4 Update existing scheduled-reviewer tests for the rename
    - Update any references in `harness/scheduled-reviewer/__tests__/*` from `StrandsReviewerInvocation` / `StrandsNotImplementedError` to `ManagedHarnessReviewerInvocation`
    - Tests that previously asserted the stub throws should now use a stubbed client to assert real flow
    - _Requirements: 2.4_

- [x] 4. Implement `ManagedHarnessEditorInvocation`
  - [x] 4.1 Implement `ManagedHarnessEditorInvocation` in `agents/editor/managed-harness-invocation.ts`
    - New file (does not modify the existing data-only `agents/editor/agent.ts`)
    - Constructor takes `{ harnessArn, sessionId, client? }`
    - On `runEditor(context)`: serialise `LoopContext` (trigger + history) as JSON, issue `InvokeHarnessCommand` against the editor harness ARN with the supplied session id, consume the streaming response
    - Walk the response stream and, for each `module.writeFile` `tool-result` event, record `{path, diff}` into the accumulator (`diff` computed from before/after contents); ignore other tool calls
    - Return `EditorResult { edits }`
    - On any SDK throw or malformed stream (e.g., stream ended without a `final` event): throw immediately rather than returning an empty `EditorResult`
    - Implement `LoopGates.runEditor` contract from `harness/loop`
    - _Requirements: 3.2, 3.3, 3.4, 3.5_

  - [x] 4.2 Write unit tests for `ManagedHarnessEditorInvocation`
    - Place at `agents/editor/__tests__/managed-harness-invocation.test.ts`
    - Use `aws-sdk-client-mock` to stub `BedrockAgentCoreClient`
    - Test: canned stream with two `module.writeFile` results → `EditorResult.edits` has two entries with correct `{path, diff}`
    - Test: canned stream with no `module.writeFile` results but a `final` event → `EditorResult.edits` is empty (legitimate outcome)
    - Test: SDK throws → error propagated, not swallowed
    - Test: stream ends before a `final` event → throws (malformed stream)
    - _Requirements: 3.3, 3.5_

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement the orchestrator Lambda handler and `LoopGates` adapter
  - [x] 6.1 Implement local-runner adapters for the trust gates
    - In `app/orchestrator/index.ts`, add thin wrappers `runLocalSensors`, `runLocalCdkDeploy`, `runLocalPostDeploy`, `openGitHubPR` that unwrap the existing tool-shape (`{output, cost}`) returned by `agents/editor/tools/sensors.ts`, `agents/editor/tools/cdk.ts`, `harness/post-deploy/src/runner.ts`, and `agents/editor/tools/pr.ts` into the shape `LoopGates` expects
    - These wrappers do not duplicate logic — they delegate to the existing implementations
    - _Requirements: 4.3, 4.4_

  - [x] 6.2 Implement the `adaptReviewerResultToReviewerResult` helper
    - In `app/orchestrator/index.ts`, add a pure function that maps `StandaloneReviewerResult` (`{findings, tokenCostUSD, modelVersion}`) into `runLoop`'s `ReviewerResult` (`{findings, passed, severityCounts}`)
    - Compute `passed` and `severityCounts` from `findings` using the same logic as `agents/reviewer/agent.ts`'s output-validation pass (extract or share that logic to avoid duplication)
    - _Requirements: 4.3_

  - [x] 6.3 Implement the Lambda handler in `app/orchestrator/index.ts`
    - Add the file-top comment documenting the 15-minute Lambda execution cap, that the smoke test fits inside it, and that longer loops need a different host (Step Functions, ECS) — out of scope here
    - Export `handler: APIGatewayProxyHandler`
    - In the handler: parse `event.body` JSON, build a `Session` via `createSessionFromTrigger` (already in `harness/loop/src/session.ts`)
    - Construct `ManagedHarnessEditorInvocation` (harness ARN from `process.env.EDITOR_HARNESS_ARN`) and `ManagedHarnessReviewerInvocation` (harness ARN from `process.env.REVIEWER_HARNESS_ARN`)
    - Build the `LoopGates` object: `runEditor` → editor invocation method; `runReviewer` → reviewer invocation `invoke` adapted via `adaptReviewerResultToReviewerResult`; `runSensors`, `runDeploy`, `runPostDeploy`, `openPR` → the local-runner wrappers from 6.1
    - Call `runLoop({ session, store: new InMemorySessionStore(), config, killSwitchPoll, gates })`
    - On `runLoop()` returning: write `{ terminationReason, prNumber }` to the response body and return `200`
    - On any throw (parse, construction, `runLoop` itself): log to stdout and return `500` with `{ error: String(err) }`. Do not write a `200` in this path
    - The trust gates are NOT registered as Managed Harness tools — they remain orchestrator-side custom code
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [x] 6.4 Write unit tests for the orchestrator handler
    - Place at `app/orchestrator/__tests__/handler.test.ts`
    - Stub `runLoop` (inject via dependency injection seam, or mock the import)
    - Test: success → 200 with `{ terminationReason, prNumber }`; bad JSON in `event.body` → 500 with `{ error }`; `runLoop` throws → 500; verify no 200 is written when `runLoop` does not return (early throw path)
    - Test: `LoopGates` is built with `runEditor` delegated to the editor invocation and `runReviewer` delegated to the reviewer invocation (use a spy)
    - _Requirements: 4.5, 4.6_

  - [x] 6.5 Write unit tests for `adaptReviewerResultToReviewerResult`
    - Place at `app/orchestrator/__tests__/adapter.test.ts`
    - Pure-function tests: empty findings → `passed: true`, empty severityCounts; mixed-severity findings → `passed` false when threshold breached, correct severityCounts; matches `agents/reviewer/agent.ts`'s validation logic
    - _Requirements: 4.3_

- [x] 7. Implement the orchestrator CDK stack and update IAM
  - [x] 7.1 Create `infrastructure/orchestrator-stack.ts` with the Lambda, API Gateway, and execution role
    - Read `editorHarnessArn` and `reviewerHarnessArn` from CDK context; fail synth with a clear error message if either is missing
    - Create the orchestrator Lambda: entry point `app/orchestrator/index.ts`, Node.js 20.x runtime, 15-minute timeout, 1024 MB memory; pass the harness ARNs as environment variables (`EDITOR_HARNESS_ARN`, `REVIEWER_HARNESS_ARN`)
    - Create the execution role with `bedrock-agentcore:InvokeHarness` scoped to exactly the two harness ARNs (no wildcards) plus standard CloudWatch Logs write permissions; add `sts:AssumeRole` for the existing `agent-harness-editor` role so trust gates can use the editor role's credentials
    - Create the API Gateway REST API with a single `POST /orchestrate` route, `AWS_IAM` authorization, and Lambda integration
    - Export the API resource ARN as a stack output named `OrchestratorApiResourceArn`
    - _Requirements: 5.6, 8.1, 8.2_

  - [x] 7.2 Update `infrastructure/iam-stack.ts` to grant `execute-api:Invoke` on the orchestrator API resource ARN
    - Remove the `agentCoreAgentArn` prop from `IamStackProps` and drop the existing `bedrock:InvokeAgent` / `InvokeAgentCore` policy statement on the runner role
    - Add an `orchestratorApiResourceArn` prop (supplied via `Fn::ImportValue` or operator-supplied context)
    - Add a new policy statement on `agent-harness-github-runner`: `sid: "InvokeOrchestratorApiGateway"`, action `execute-api:Invoke`, resources `[props.orchestratorApiResourceArn]` (no wildcards)
    - Preserve the runner role's existing OIDC trust policy and other statements
    - Leave the editor and reviewer agent roles unchanged — Managed Harness manages those at deploy time
    - _Requirements: 8.3_

  - [x] 7.3 Write CDK snapshot test for `infrastructure/orchestrator-stack.ts`
    - Place at `infrastructure/test/orchestrator-stack.test.ts`
    - Synth with fixture context (`editorHarnessArn=arn:...editor/abc`, `reviewerHarnessArn=arn:...reviewer/def`)
    - Assert via `Template.fromStack`: Lambda exists with 900s timeout and Node.js 20.x runtime; API Gateway POST method has `AuthorizationType: AWS_IAM`; IAM policy grants `bedrock-agentcore:InvokeHarness` on exactly the two ARNs from context; no resource is `*`
    - Assert synth fails when the harness ARN context keys are missing
    - _Requirements: 5.6, 8.1, 8.2_

  - [x] 7.4 Update `infrastructure/test/iam-stack.test.ts` for the policy change
    - Assert the new `execute-api:Invoke` statement scopes to the orchestrator API resource ARN exactly (no wildcards)
    - Assert the old `bedrock:InvokeAgent` / `InvokeAgentCore` statement is gone
    - Assert the OIDC trust policy is preserved unchanged
    - _Requirements: 8.3_

- [x] 8. Update `dispatch-agent-task.yml` to SigV4-sign the orchestrator POST
  - [x] 8.1 Replace the unsigned `curl` POST with a SigV4-signed POST in `.github/workflows/dispatch-agent-task.yml`
    - Rename the step from "POST payload to AgentCore" to "POST payload to orchestrator API Gateway"
    - Read the endpoint from `agent-harness.config.json` `orchestrator.apiGatewayEndpoint` via `jq`
    - Use `awscurl` (Option A from design): `awscurl --service execute-api -X POST -d @/tmp/payload.json "$ORCHESTRATOR_ENDPOINT"`; install `awscurl` in a setup step if not already available on the runner
    - The runner role's credentials are already assumed via the existing OIDC step; the SigV4 signing reuses those credentials
    - Preserve the existing failure-comment pattern so a 403 (invalid signature, missing IAM grant) becomes a comment on the issue
    - _Requirements: 8.4, 8.5, 8.6_

- [x] 9. Implement the live smoke-test script
  - [x] 9.1 Implement `scripts/smoke-test.ts`
    - Read the GitHub repository (owner/name) and the orchestrator API Gateway endpoint from `agent-harness.config.json` (no separate env vars required)
    - Create a GitHub issue titled `[smoke-test] <ISO timestamp>` with the `agent-task` label on the fanout module path; use the `gh` CLI or the GitHub REST API via `fetch`
    - Poll for the `dispatch-agent-task.yml` workflow run to start: configurable `--workflow-poll-interval` (default 30s), configurable `--workflow-timeout` (default 10min)
    - Poll for a PR referencing the issue to be opened: configurable `--pr-poll-interval` (default 60s), configurable `--pr-timeout` (default 90min)
    - Print a structured stdout summary on completion: issue number, workflow run URL, PR number (or null), elapsed time, pass/fail verdict
    - On any timeout: print the last observed state (last polled status, workflow run URL if available) and exit non-zero
    - On both pass and fail: close the smoke-test issue. Leave the PR open for manual review
    - Make the script runnable with `npx ts-node scripts/smoke-test.ts` (no setup beyond the cloned repo and AWS credentials in the operator's environment)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

  - [x] 9.2 Write unit tests for the smoke test's helper functions
    - Place at `scripts/__tests__/smoke-test.test.ts`
    - Pure-function-ish tests for: config loading from `agent-harness.config.json`; CLI flag parsing with defaults; structured-summary formatting
    - Polling and GitHub API calls are not unit-tested (they are the integration target the smoke test exists to validate); skip live-fire tests here
    - _Requirements: 6.5, 6.7_

- [x] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Documentation terminology updates and CI gate
  - [x] 11.1 Replace "AgentCore Harness" with "AgentCore Managed Harness" across `README.md`, `docs/quickstart.md`, and `post-draft.md`
    - Replace every occurrence of the literal phrase `AgentCore Harness` (without "Managed") with `AgentCore Managed Harness`
    - On the first introduction in each document, add a parenthetical clarifying that this template uses the preview AgentCore Managed Harness feature for the editor and reviewer agents with a custom orchestrator on top, and that this is distinct from AgentCore Runtime (the code-based deployment mode)
    - In `README.md`: update the AgentCore prerequisites section's link text and description to read "AgentCore Managed Harness"
    - In `docs/quickstart.md`: update the AgentCore endpoint configuration step description to "Orchestrator API Gateway endpoint" and add a note explaining this is the API Gateway endpoint of the orchestrator Lambda which calls `InvokeHarness` against the deployed Managed Harnesses; if the step does not exist, add it in the appropriate location
    - In `docs/quickstart.md`: add a numbered step between "Deploy the IAM stack" and "Deploy the orchestrator stack" that documents `agentcore deploy` (using `@aws/agentcore@preview`), explains that it produces two harness ARNs, and instructs the operator to capture them and pass them as CDK context (`--context editorHarnessArn=… --context reviewerHarnessArn=…`) when deploying the orchestrator stack
    - Preserve all existing links, code blocks, headings, and section structure in the three documents
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 5.2, 5.3_

  - [x] 11.2 Update `post-draft.md` to clarify the engineering-harness emphasis
    - Add a sentence at the start of Section 4 (after the introductory paragraphs and before "What the agent does on a given PR") noting that the section describes the runtime layer briefly and the engineering harness layer in detail because the engineering harness is where most of the template's value sits
    - Add an explicit line in Section 5's non-claims (or as a closing sentence in Section 4) stating that the agents are the easy part, and that the loop runner, sensors, post-deploy feedback path, IAM scoping, and kill switch are the template's main contribution
    - Add a sentence in the paragraph that introduces `modules/fanout` (in Section 4) explicitly stating that the reference module is the swappable part of the template — forkers replace `modules/fanout/` and `modules/fanout/AGENTS.md` with their own module and steering file
    - Preserve existing structure, headings, and argument flow; only the three clarifying sentences are added
    - _Requirements: 1B.1, 1B.2, 1B.3, 1B.4_

  - [x] 11.3 Add `scripts/check-terminology.ts` and wire it as a CI guard
    - New script that greps for the literal string `AgentCore Harness` (without "Managed") in `README.md`, `docs/quickstart.md`, `post-draft.md` and exits non-zero if any match is found
    - Exclude `harness-engineering-primer.md` (different concept — engineering harness) and any `CHANGELOG*` entries
    - Wire the script into the existing CI invocation point (extend the existing doc-validation step, or add a new step alongside `validate-config.ts`)
    - _Requirements: 1.1_

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional sub-tasks (tests and CI verification helpers) and can be skipped for a faster MVP. Core implementation tasks are not marked optional.
- Each task references the specific requirement clauses it satisfies for traceability.
- Property-based tests are intentionally absent: the design's Testing Strategy section concludes that PBT is not appropriate here (configuration wiring, IaC, and integration glue rather than algorithmic code).
- Unit tests use `aws-sdk-client-mock` to stub `BedrockAgentCoreClient`. CDK stacks use snapshot tests via `Template.fromStack`. The live smoke test (`scripts/smoke-test.ts`) is the canonical "is the wiring working" gate and runs once per release rather than on every CI build.
- Tasks 1–4 build the foundation (config, harness JSON, two invocation classes). Task 6 wires those into the Lambda handler. Task 7 wraps the Lambda in API Gateway + IAM. Task 8 makes the dispatch workflow speak SigV4. Task 9 lets the operator validate end-to-end. Task 11 closes the loop on terminology so the docs match the new vocabulary.
- The 15-minute Lambda execution cap is acknowledged in the file-top comment of `app/orchestrator/index.ts` (task 6.3) and in the design's "Out of scope" section. Operators wanting longer loops will need a different host.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "1.4", "2.1", "2.2", "2.3"] },
    { "id": 3, "tasks": ["2.4", "3.1", "4.1"] },
    { "id": 4, "tasks": ["3.2", "3.3", "3.4", "4.2", "6.1"] },
    { "id": 5, "tasks": ["6.2"] },
    { "id": 6, "tasks": ["6.3", "6.5"] },
    { "id": 7, "tasks": ["6.4", "7.1", "7.2"] },
    { "id": 8, "tasks": ["7.3", "7.4", "8.1", "9.1", "11.1", "11.3"] },
    { "id": 9, "tasks": ["11.2"] },
    { "id": 10, "tasks": ["9.2"] }
  ]
}
```
