# Requirements Document

## Introduction

This spec wires the agent-harness template end-to-end so it can actually run. It has two parts.

**Part 1 — Terminology fix:** The docs (`post-draft.md`, `README.md`, `docs/quickstart.md`) currently use "AgentCore Harness" to mean the AgentCore platform broadly. AWS has since launched a specific preview feature also called "AgentCore Managed Harness" — a managed, config-file-driven loop where each agent is declared in a JSON file (model, system prompt, tools, memory, iteration cap) and invoked turn-by-turn via the `InvokeHarness` AWS SDK call. This template now uses AgentCore Managed Harness for the editor and reviewer agents, with a small custom orchestrator on top that runs the trust gates (sensors, `cdk deploy`, post-deploy harness) and decides when to call each harness. All references to "AgentCore Harness" in the docs must be updated to "AgentCore Managed Harness" and the docs must explain how the Managed Harness sits underneath the custom orchestrator (rather than collapsing the two into one feature).

**Part 2 — End-to-end wiring:** The template currently has stubs where the AgentCore Managed Harness invocations and the orchestrator entry point should be. This spec fills those stubs so the full flow runs: GitHub issue + `agent-task` label → `dispatch-agent-task.yml` → SigV4-signed HTTP POST to the orchestrator's API Gateway endpoint → API Gateway invokes the orchestrator Lambda → Lambda calls `runLoop()` → on each iteration, `runLoop()` calls `InvokeHarness` for the editor harness and (later in the same iteration) the reviewer harness → orchestrator runs sensors, `cdk deploy`, post-deploy harness directly → PR opens → human reviews.

## Glossary

- **AgentCore Managed Harness:** The AWS Bedrock AgentCore preview feature that provides a managed, config-file-driven agent loop. Each agent is declared in a JSON file (model, system prompt, tool catalogue, memory, iteration cap) and deployed via `agentcore deploy`. The deployment produces a harness ARN; callers invoke the agent turn-by-turn via the `InvokeHarness` AWS SDK call. This template uses Managed Harness for the editor and reviewer agents.
- **AgentCore Runtime:** A separate AWS Bedrock AgentCore deployment mode where the operator provides a container or Lambda entry point and AgentCore Runtime hosts it. This template does NOT use AgentCore Runtime; it uses Managed Harness with a custom orchestrator on top. The two are distinct; the docs must not conflate them.
- **InvokeHarness:** The AWS SDK call (`bedrock-agentcore:InvokeHarness`, exposed in `@aws-sdk/client-bedrock-agentcore`) the orchestrator uses to invoke each Managed Harness for one agent turn. Takes a harness identifier and a session id; returns a streaming response with the agent's tool calls and final output.
- **Orchestrator Lambda:** The AWS Lambda function at `app/orchestrator/index.ts` that hosts `runLoop()`. The dispatch workflow POSTs to its API Gateway endpoint; the Lambda reads the session payload, builds the editor and reviewer `InvokeHarness` clients, constructs `LoopGates`, calls `runLoop()`, and writes the termination outcome back to the response.
- **Editor Harness:** The Managed Harness declared in `app/editor/harness.json` that runs the editor agent. The harness config references the system prompt at `agents/editor/system.md` and registers the full editor tool catalogue (file tools, CDK tools, sensors, preview tools, reviewer-as-tool, post-deploy, `pr.open`).
- **Reviewer Harness:** The Managed Harness declared in `app/reviewer/harness.json` that runs the inferential Well-Architected review on a diff. The harness config references the system prompt at `agents/reviewer/system.md` and registers the read-only reviewer tool catalogue (`module.readFile`, `module.diff`, `reference.checklist`).
- **ManagedHarnessEditorInvocation:** The class in `agents/editor/` that implements `LoopGates.runEditor()` by calling `InvokeHarness` against the editor harness ARN. Parses the streaming response, accumulates the agent's edits, and returns an `EditorResult`.
- **ManagedHarnessReviewerInvocation:** The class in `harness/scheduled-reviewer/src/run.ts` that implements the `StandaloneReviewerInvocation` interface by calling `InvokeHarness` against the reviewer harness ARN. Parses the streaming response into a `StandaloneReviewerResult`. Replaces the `StrandsReviewerInvocation` stub.
- **agentcore.json:** The AgentCore project configuration file at `agentcore/agentcore.json`. Declares the project name and the two harnesses (`editor-agent` referencing `app/editor/harness.json`, `reviewer-agent` referencing `app/reviewer/harness.json`). Used by the `agentcore deploy` CLI from `@aws/agentcore@preview`.
- **agentcore deploy (preview):** The CLI command (`agentcore deploy`, from the `@aws/agentcore@preview` npm channel) that deploys the two Managed Harnesses. Produces two harness ARNs the orchestrator's IAM policy must scope to. Distinct from `cdk deploy`.
- **Smoke Test:** The script at `scripts/smoke-test.ts` that exercises the full end-to-end flow: creates a GitHub issue with `agent-task` label, polls for the dispatch workflow to fire, polls for a PR to open, and reports pass/fail.
- **runLoop:** The fully-implemented bounded loop function in `harness/loop/src/run.ts`. The orchestrator Lambda calls this after building the `ManagedHarnessEditorInvocation` and `ManagedHarnessReviewerInvocation` clients.

## Requirements

### Requirement 1: Terminology — replace "AgentCore Harness" with "AgentCore Managed Harness" in docs

**User Story:** As a developer reading the docs, I want the terminology to match AWS's current naming so I am not confused about which AgentCore feature this template uses.

#### Acceptance Criteria

1. THE Docs_Update SHALL replace every occurrence of "AgentCore Harness" in `post-draft.md`, `README.md`, and `docs/quickstart.md` with "AgentCore Managed Harness".
2. WHEN the term "AgentCore Managed Harness" is first introduced in each document, THE Docs_Update SHALL include a parenthetical note clarifying that this template uses the preview AgentCore Managed Harness feature for the editor and reviewer agents, with a custom orchestrator on top, and that this is distinct from AgentCore Runtime (the code-based deployment mode).
3. THE Docs_Update SHALL preserve all existing links, code blocks, and section structure in the three documents; only the terminology and the clarifying note change.
4. WHEN `README.md` references the AgentCore prerequisites section, THE Docs_Update SHALL update the prerequisite link text and description to read "AgentCore Managed Harness" rather than "AgentCore Harness".
5. WHEN `docs/quickstart.md` references the AgentCore endpoint configuration step, THE Docs_Update SHALL update the step description to read "Orchestrator API Gateway endpoint" and add a note that this is the API Gateway endpoint of the orchestrator Lambda, which in turn calls `InvokeHarness` against the deployed Managed Harnesses. IF no such endpoint configuration step currently exists in the document, THE Docs_Update SHALL add this content as a new step in the appropriate location.

### Requirement 1B: Post-draft — clarify the engineering-harness emphasis

**User Story:** As a reader of the post, I want the post to make explicit that the engineering harness is where most of the template's value sits, so I do not finish reading thinking the agents and GitHub triggers are the main contribution.

#### Acceptance Criteria

1. THE Post_Draft_Update SHALL add a sentence at the start of Section 4 (after the introductory paragraphs and before the "What the agent does on a given PR" subsection) noting that the section describes the runtime layer briefly and the engineering harness layer in detail because the engineering harness is where most of the template's value sits and where forkers will spend most of their adaptation effort.
2. THE Post_Draft_Update SHALL add an explicit line in Section 5's non-claims (or as a new closing sentence in Section 4) stating that the agents are the easy part, and that the loop runner, sensors, post-deploy feedback path, IAM scoping, and kill switch are what the template is mostly contributing.
3. THE Post_Draft_Update SHALL add a sentence in the paragraph that introduces `modules/fanout` (in Section 4) explicitly stating that the reference module is the swappable part of the template — forkers replace `modules/fanout/` and `modules/fanout/AGENTS.md` with their own module and steering file.
4. THE Post_Draft_Update SHALL preserve the existing structure, headings, and argument flow of the post-draft; only the three clarifying sentences are added. No existing prose is removed or reordered.

### Requirement 2: Reviewer harness declaration and invocation

**User Story:** As an operator running the scheduled reviewer workflow, I want a declarative reviewer Managed Harness and a real `InvokeHarness`-backed invocation in `harness/scheduled-reviewer/src/run.ts` so the scheduled reviewer produces real findings instead of throwing `StrandsNotImplementedError`.

#### Acceptance Criteria

1. THE Reviewer_Harness SHALL create `app/reviewer/harness.json` declaring the reviewer Managed Harness with the model from `agent-harness.config.json` `models.reviewer`, the system prompt loaded from `agents/reviewer/system.md`, the read-only reviewer tool catalogue (`module.readFile`, `module.diff`, `reference.checklist`), the memory configuration, and the iteration cap from `agent-harness.config.json` `limits.iterationCap`.
2. THE Reviewer_Harness SHALL implement a `ReviewerHarnessClient` class in `harness/scheduled-reviewer/src/run.ts` that calls `InvokeHarness` via `@aws-sdk/client-bedrock-agentcore` against the reviewer harness ARN with a session id of the form `<sessionId>-reviewer`.
3. WHEN `ReviewerHarnessClient.invoke()` is called, THE Reviewer_Harness SHALL pass the diff under review as the input to `InvokeHarness`, consume the streaming response, and parse the agent's final structured output into a `StandaloneReviewerResult` with `findings`, `tokenCostUSD`, and `modelVersion` fields.
4. THE Reviewer_Harness SHALL replace the `StrandsReviewerInvocation` class (which throws `StrandsNotImplementedError`) with a `ManagedHarnessReviewerInvocation` class implementing `StandaloneReviewerInvocation` and backed by `ReviewerHarnessClient`.
5. THE Reviewer_Harness SHALL update `agent-harness.config.json` `versions.strands` from `"PLACEHOLDER"` by removing the entry (the template no longer depends on Strands) and add a new `versions.bedrockAgentCoreSdk` entry pinned to the exact version of `@aws-sdk/client-bedrock-agentcore` used.
6. IF the `InvokeHarness` call throws or returns a malformed response, THEN THE Reviewer_Harness SHALL populate any available partial result fields and propagate the error only after successful partial-result population, so `runScheduledReviewer()` exits non-zero and the GitHub Actions workflow surfaces the failure. WHEN the `InvokeHarness` call succeeds normally, THE Reviewer_Harness SHALL NOT attempt error propagation or partial-result population.

### Requirement 3: Editor harness declaration and invocation

**User Story:** As an operator running the agent loop, I want a declarative editor Managed Harness and a real `InvokeHarness`-backed invocation so the loop can actually edit the CDK module.

#### Acceptance Criteria

1. THE Editor_Harness SHALL create `app/editor/harness.json` declaring the editor Managed Harness with the model from `agent-harness.config.json` `models.editor`, the system prompt loaded from `agents/editor/system.md`, the full editor tool catalogue (the 15 tools listed by `EDITOR_TOOL_NAMES` in `agents/editor/agent.ts`), the memory configuration, and the iteration cap from `agent-harness.config.json` `limits.iterationCap`.
2. THE Editor_Harness SHALL implement a `ManagedHarnessEditorInvocation` class in `agents/editor/` that calls `InvokeHarness` via `@aws-sdk/client-bedrock-agentcore` against the editor harness ARN and implements the `LoopGates.runEditor()` contract.
3. WHEN `ManagedHarnessEditorInvocation.runEditor(context)` is called, THE Editor_Harness SHALL pass the `LoopContext` (trigger and history) as the input to `InvokeHarness` with a session id matching the orchestrator's session id, consume the streaming response, accumulate the agent's edits across the response stream, and return an `EditorResult` containing the edits the agent produced during that turn. IF `InvokeHarness` fails to be called or throws during invocation, THEN THE Editor_Harness SHALL throw an error immediately rather than returning an empty `EditorResult`.
4. THE Editor_Harness SHALL be importable by `app/orchestrator/index.ts` without circular dependencies.
5. IF the `InvokeHarness` call throws or returns a malformed response, THEN THE Editor_Harness SHALL propagate the error so `runLoop()` can record it and apply stop conditions.

### Requirement 4: Orchestrator entry point as Lambda function

**User Story:** As an operator deploying the template, I want `app/orchestrator/index.ts` to serve as a Lambda function handler so the GitHub Actions dispatch workflow can invoke it via API Gateway and the full loop runs.

#### Acceptance Criteria

1. THE Orchestrator_Entry_Point SHALL create `app/orchestrator/index.ts` exporting a Lambda handler the API Gateway integration invokes when a trigger arrives.
2. WHEN the Lambda handler is invoked, THE Orchestrator_Entry_Point SHALL read the session payload from the API Gateway request body, extract the trigger fields (issue number, issue title, issue body, module path, session id), and build a `Session` object.
3. WHEN the `Session` object is built, THE Orchestrator_Entry_Point SHALL construct the `ManagedHarnessEditorInvocation` (configured with the editor harness ARN) and the `ManagedHarnessReviewerInvocation` (configured with the reviewer harness ARN), build the orchestrator-side `LoopGates` (with `runEditor` delegated to `ManagedHarnessEditorInvocation`, `runReviewer` delegated to `ManagedHarnessReviewerInvocation`, and the trust-gate methods `runSensors`, `runDeploy`, and `runPostDeploy` wired to the orchestrator's local sensor runner, CDK runner, and post-deploy runner respectively), and call `runLoop()` with these gates.
4. THE Orchestrator_Entry_Point SHALL keep the trust gates (cdk-nag, tsc, eslint, unit tests, `cdk deploy`, post-deploy harness) as orchestrator-side custom code; THE Orchestrator_Entry_Point SHALL NOT register the trust gates as Managed Harness tools.
5. WHEN `runLoop()` returns, THE Orchestrator_Entry_Point SHALL write the termination reason and PR number to the API Gateway response body and return a `200` status code. Response data SHALL only be written when `runLoop()` actually returns; early failures or kill-switch activations SHALL not attempt to write a `200` response.
6. IF any step in the entry point throws before `runLoop()` is called, OR IF `runLoop()` itself throws or times out after being called, THEN THE Orchestrator_Entry_Point SHALL log the error to stdout (for CloudWatch Logs ingestion) and return a `500` status code so API Gateway surfaces the failure.
7. THE Orchestrator_Entry_Point SHALL document in a comment at the top of `app/orchestrator/index.ts` that AWS Lambda has a 15-minute execution cap, that the smoke test is sized so a typical 2–4 iteration run completes inside that cap, and that operators running longer loops will need a different host (e.g., Step Functions, ECS task) — this is out of scope for this spec.

### Requirement 5: AgentCore Managed Harness deployment and orchestrator infrastructure

**User Story:** As an operator deploying the template, I want a documented `agentcore deploy` flow plus a CDK stack for the orchestrator Lambda and API Gateway so I can deploy the two Managed Harnesses and the orchestrator in front of them without guessing.

#### Acceptance Criteria

1. THE AgentCore_Deploy SHALL create `agentcore/agentcore.json` declaring the AgentCore project with the two harnesses: `editor-agent` referencing `app/editor/harness.json` and `reviewer-agent` referencing `app/reviewer/harness.json`. The project SHALL declare the AWS account id and region from `agent-harness.config.json` `agentcore.regionalRouting`.
2. THE AgentCore_Deploy SHALL document the `agentcore deploy` command (using the `@aws/agentcore@preview` CLI) in `docs/quickstart.md` as a numbered step between "Deploy the IAM stack" and "Deploy the orchestrator stack".
3. THE AgentCore_Deploy SHALL document that `agentcore deploy` produces two harness ARNs (one for the editor harness, one for the reviewer harness) and that the operator must capture these ARNs and pass them as CDK context values when deploying the orchestrator stack so the orchestrator's IAM policy can scope `bedrock-agentcore:InvokeHarness` to those exact ARNs.
4. THE AgentCore_Deploy SHALL update `agent-harness.config.json` `versions.agentcoreSdk` from `"PLACEHOLDER"` to the exact version of `@aws/agentcore@preview` used (resolved from the preview channel) and add `versions.bedrockAgentCoreSdk` pinned to the exact version of `@aws-sdk/client-bedrock-agentcore` used.
5. THE AgentCore_Deploy SHALL add `@aws/agentcore@preview` and `@aws-sdk/client-bedrock-agentcore` to the appropriate `package.json` files with exact version pins (no `^` or `~` prefixes).
6. THE AgentCore_Deploy SHALL add a new CDK stack at `infrastructure/orchestrator-stack.ts` that creates the orchestrator Lambda function (entry point `app/orchestrator/index.ts`, Node.js 20.x runtime, 15-minute timeout, sized memory), the API Gateway REST API in front of it, and the Lambda execution role with `bedrock-agentcore:InvokeHarness` permission scoped to exactly the two harness ARNs supplied as CDK context.

### Requirement 6: Smoke test script

**User Story:** As an operator validating the end-to-end wiring, I want a `scripts/smoke-test.ts` script that exercises the full flow so I can confirm the template is wired correctly without manually watching every step.

#### Acceptance Criteria

1. THE Smoke_Test SHALL create `scripts/smoke-test.ts` that exercises the full end-to-end flow: creates a GitHub issue with `agent-task` label on the fanout module, polls for the `dispatch-agent-task.yml` workflow run to start, polls for a PR to open, and reports pass/fail with a summary.
2. WHEN the Smoke_Test creates the GitHub issue, THE Smoke_Test SHALL use the GitHub CLI (`gh`) or the GitHub REST API and SHALL close the issue on both pass and fail. The PR opened by the agent SHALL be left open for the operator to review and merge or close manually.
3. WHEN the Smoke_Test polls for the dispatch workflow, THE Smoke_Test SHALL poll at a configurable interval (default 30 seconds) for a configurable timeout (default 10 minutes) before reporting failure.
4. WHEN the Smoke_Test polls for a PR, THE Smoke_Test SHALL poll at a configurable interval (default 60 seconds) for a configurable timeout (default 90 minutes) before reporting failure.
5. WHEN the Smoke_Test completes, THE Smoke_Test SHALL print a structured summary to stdout: issue number, workflow run URL, PR number (if opened), elapsed time, and pass/fail verdict.
6. IF the Smoke_Test times out waiting for the workflow or PR, THEN THE Smoke_Test SHALL exit non-zero and print the last observed state so the operator knows where the flow stalled.
7. THE Smoke_Test SHALL be runnable with `npx ts-node scripts/smoke-test.ts` and SHALL read the GitHub repository and the orchestrator API Gateway endpoint from `agent-harness.config.json` rather than requiring separate environment variables.

### Requirement 7: Version pin updates

**User Story:** As a forker of this template, I want all version pins updated from `"PLACEHOLDER"` to real values so `scripts/check-version-drift.ts` passes and the template is immediately usable.

#### Acceptance Criteria

1. THE Version_Pins SHALL update `agent-harness.config.json` `versions.agentcoreSdk` to the exact version of `@aws/agentcore@preview` installed (resolved from the preview channel; the resolved version, not the `preview` tag, is recorded).
2. THE Version_Pins SHALL add a new entry `versions.bedrockAgentCoreSdk` set to the exact version of `@aws-sdk/client-bedrock-agentcore` installed.
3. THE Version_Pins SHALL remove the `versions.strands` entry from `agent-harness.config.json` (the template no longer depends on Strands).
4. WHEN `npx ts-node scripts/check-version-drift.ts` is run after the version pins are updated, THE Version_Pins SHALL exit 0 with no drift reported. The drift check is allowed to fail when version pins have not yet been updated.
5. THE Version_Pins SHALL add `@aws/agentcore@preview` and `@aws-sdk/client-bedrock-agentcore` to the relevant `package.json` files with exact version pins (no `^` or `~` prefixes).

### Requirement 8: Orchestrator IAM and API Gateway

**User Story:** As an operator deploying the template, I want the orchestrator Lambda's IAM permissions scoped narrowly and its API Gateway authenticated via the existing GitHub runner role so the dispatch workflow can call the orchestrator without exposing a public endpoint.

#### Acceptance Criteria

1. THE Orchestrator_IAM SHALL create the orchestrator Lambda's execution role inside `infrastructure/orchestrator-stack.ts` with a policy that grants `bedrock-agentcore:InvokeHarness` on exactly two resources: the editor harness ARN and the reviewer harness ARN supplied as CDK context. THE Orchestrator_IAM SHALL NOT grant `bedrock-agentcore:InvokeHarness` on `*` or any wildcard ARN.
2. THE Orchestrator_IAM SHALL create the API Gateway REST API in `infrastructure/orchestrator-stack.ts` with `AWS_IAM` authorization on the POST method so callers must SigV4-sign their requests.
3. THE Orchestrator_IAM SHALL update the existing `agent-harness-github-runner` role (in `infrastructure/iam-stack.ts`) to grant `execute-api:Invoke` on exactly the orchestrator API Gateway's resource ARN. THE Orchestrator_IAM SHALL NOT grant `execute-api:Invoke` on `*` or any wildcard ARN.
4. THE Orchestrator_IAM SHALL update `.github/workflows/dispatch-agent-task.yml` so the "POST payload to AgentCore" step is renamed to "POST payload to orchestrator API Gateway" and the step SigV4-signs the POST request using the `agent-harness-github-runner` role's credentials (assumed via the existing OIDC federation step) instead of an unsigned POST to a generic AgentCore endpoint.
5. THE Orchestrator_IAM SHALL update `agent-harness.config.json` so the `agentcore.endpoint` field is replaced with `orchestrator.apiGatewayEndpoint`, and the dispatch workflow and smoke test SHALL read the orchestrator endpoint from this new field.
6. IF the `agent-harness-github-runner` role's SigV4 signature is invalid or the role is not authorized for the API Gateway resource ARN, THEN the API Gateway SHALL return a `403` and the dispatch workflow SHALL surface the failure as a comment on the issue (per the existing failure-comment pattern in `dispatch-agent-task.yml`).

## Out of scope

The following are explicitly out of scope for this spec:

- Changes to the CDK module itself (`modules/fanout/`). The fanout module is already implemented; this spec only wires the agent that maintains it.
- Changes to the engineering harness sensors (`agents/editor/tools/sensors.ts`, `agents/editor/tools/cdk.ts`, etc.). Those are already implemented.
- The fitness-gap loop (Task 2). That is covered by the `fitness-gap-loop` spec.
- Multi-region or multi-account AgentCore Managed Harness deployment.
- Hosting the orchestrator on anything other than AWS Lambda (e.g., Step Functions for longer-running loops, ECS tasks). The 15-minute Lambda cap is acknowledged and the smoke test is sized to fit within it.
- CI/CD pipeline changes beyond what is needed to run the smoke test.
- Changes to the `harness/loop/src/run.ts` `runLoop()` implementation. It is already fully implemented.

## Dependencies and prerequisites

- `@aws/agentcore@preview` npm package must be available and installable from the preview channel (`npm install -g @aws/agentcore@preview`).
- `@aws-sdk/client-bedrock-agentcore` npm package must be available and installable; this is the AWS SDK package exposing the `InvokeHarness` operation.
- AWS account with AgentCore Managed Harness preview access enabled in the configured region (`agent-harness.config.json` `agentcore.regionalRouting`).
- The `feature-change-loop` spec's implementation must be complete: `loadEditorAgentDefinition()`, `buildEditorToolCatalogue()`, `loadReviewerAgentDefinition()`, and `runLoop()` are all fully implemented and this spec depends on them.
- The existing `infrastructure/iam-stack.ts` `agent-harness-github-runner` role must be in place before the orchestrator stack is deployed, because the orchestrator stack grants `execute-api:Invoke` to that role.
