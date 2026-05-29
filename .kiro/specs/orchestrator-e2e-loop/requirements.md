# Requirements Document

## Introduction

Make the orchestrator Lambda execute the full bounded loop end-to-end. The current implementation is broken because `inline_function` tools require multi-turn execution (the caller must detect `stopReason: "tool_use"` and return results), the Lambda lacks the CDK CLI and TypeScript toolchain for real sensor execution, the module files are not available on a writable filesystem, and there is no real deployed preview environment for post-deploy testing. The solution involves rewriting the harness invocations for multi-turn support, switching to a Docker-based Lambda with the full toolchain, and wiring real sensors, real `cdk deploy`, and real post-deploy assertions against an ephemeral preview stack.

## Glossary

- **Orchestrator_Lambda**: The AWS Lambda function (`app/orchestrator/index.ts`) that drives the bounded loop by invoking the editor and reviewer harnesses, running sensors, deploying, and executing post-deploy checks.
- **ManagedHarnessEditorInvocation**: The class in `agents/editor/managed-harness-invocation.ts` that adapts the `LoopGates.runEditor` contract to the AgentCore `InvokeHarness` API.
- **ManagedHarnessReviewerInvocation**: The class in `harness/scheduled-reviewer/src/run.ts` that adapts the reviewer invocation to the AgentCore `InvokeHarness` API.
- **InvokeHarness**: The AWS Bedrock AgentCore SDK operation used to send messages to a Managed Harness and receive a streaming response.
- **Multi_Turn_Loop**: The pattern where the caller detects `stopReason: "tool_use"` in the harness stream, executes the requested `inline_function` tool locally, and re-invokes `InvokeHarness` with a `toolResult` content block to continue the conversation.
- **Inline_Function_Tool**: A tool of type `inline_function` registered with AgentCore whose execution is the caller's responsibility; AgentCore presents it to the model but does not execute it.
- **DockerImageFunction**: A CDK construct (`aws-cdk-lib/aws-lambda`) that deploys a Lambda from a container image rather than a bundled zip, enabling arbitrary runtimes and toolchains.
- **Preview_Stack**: An ephemeral CloudFormation stack deployed by `cdk deploy` within the Lambda, representing the module under test in an isolated environment.
- **Sensor**: A computational check (tsc, eslint, cdk-nag, jest) that validates the module code and produces structured pass/fail output.
- **Post_Deploy_Harness**: A set of HTTP assertions executed against the deployed Preview_Stack to validate end-to-end behaviour.
- **Stop_Reason**: The `messageStop.stopReason` field in the `InvokeHarness` streaming response indicating why the model stopped (`"end_turn"`, `"tool_use"`, `"max_tokens"`, etc.).

## Requirements

### Requirement 1: Multi-turn tool execution in ManagedHarnessEditorInvocation

**User Story:** As the orchestrator, I want ManagedHarnessEditorInvocation to handle multi-turn `inline_function` tool execution, so that the editor agent can use tools that require caller-side execution across multiple InvokeHarness round-trips.

#### Acceptance Criteria

1. WHEN the InvokeHarness stream ends with `stopReason: "tool_use"`, THE ManagedHarnessEditorInvocation SHALL extract the pending `inline_function` tool-use blocks from the assistant message, execute each tool locally, and re-invoke InvokeHarness with the assistant message followed by a user message containing `toolResult` content blocks.
2. WHILE the InvokeHarness stream continues to end with `stopReason: "tool_use"`, THE ManagedHarnessEditorInvocation SHALL continue the multi-turn cycle by executing tools and re-invoking until the stream ends with `stopReason: "end_turn"` or a terminal stop reason.
3. THE ManagedHarnessEditorInvocation SHALL accumulate tool-use and tool-result content blocks across all turns into the messages array so each subsequent InvokeHarness call carries the full conversation history.
4. IF the multi-turn cycle exceeds a configurable maximum turn count, THEN THE ManagedHarnessEditorInvocation SHALL terminate the cycle and throw an error indicating the turn cap was reached.
5. WHEN a `stopReason` other than `"tool_use"` or `"end_turn"` is received (such as `"max_tokens"` or `"timeout_exceeded"`), THE ManagedHarnessEditorInvocation SHALL treat the response as terminal and return the edits accumulated up to that point.

### Requirement 2: Multi-turn tool execution in ManagedHarnessReviewerInvocation

**User Story:** As the orchestrator, I want ManagedHarnessReviewerInvocation to handle multi-turn `inline_function` tool execution, so that the reviewer agent can use tools that require caller-side execution.

#### Acceptance Criteria

1. WHEN the InvokeHarness stream ends with `stopReason: "tool_use"`, THE ManagedHarnessReviewerInvocation SHALL extract the pending `inline_function` tool-use blocks, execute each tool locally, and re-invoke InvokeHarness with the accumulated messages including `toolResult` content blocks.
2. WHILE the InvokeHarness stream continues to end with `stopReason: "tool_use"`, THE ManagedHarnessReviewerInvocation SHALL continue the multi-turn cycle until the stream ends with a terminal stop reason.
3. IF the multi-turn cycle exceeds a configurable maximum turn count, THEN THE ManagedHarnessReviewerInvocation SHALL terminate the cycle and throw an error indicating the turn cap was reached.

### Requirement 3: Inline function tool executor

**User Story:** As the orchestrator, I want a local tool executor that can run `inline_function` tools requested by the harness, so that tool results are returned correctly in subsequent InvokeHarness calls.

#### Acceptance Criteria

1. WHEN the multi-turn loop extracts a tool-use block with `type: "tool_use"` (inline_function), THE Tool_Executor SHALL look up the tool by name in the registered tool catalogue and invoke its handler with the parsed input.
2. WHEN the tool handler returns successfully, THE Tool_Executor SHALL produce a `toolResult` content block with `status: "success"` and the handler's output serialized as JSON.
3. IF the tool handler throws an error, THEN THE Tool_Executor SHALL produce a `toolResult` content block with `status: "error"` and the error message as text content.
4. IF the requested tool name is not found in the registered catalogue, THEN THE Tool_Executor SHALL produce a `toolResult` content block with `status: "error"` and a message indicating the tool is not registered.

### Requirement 4: Switch to DockerImageFunction

**User Story:** As a developer, I want the orchestrator Lambda deployed as a DockerImageFunction with the full toolchain, so that sensors and cdk deploy execute against real CLI tools rather than being skipped.

#### Acceptance Criteria

1. THE OrchestratorStack SHALL deploy the orchestrator Lambda using the `DockerImageFunction` construct instead of `NodejsFunction`.
2. THE Dockerfile SHALL include Node.js 22, the AWS CDK CLI, TypeScript compiler, ESLint, and Jest as globally or locally available executables.
3. THE Dockerfile SHALL copy the full project source (including `modules/fanout/`) into the container image so the module files are available at a known absolute path on a writable filesystem.
4. THE Orchestrator_Lambda SHALL retain the same IAM permissions, environment variables, timeout, and memory configuration as the current `NodejsFunction` deployment.
5. THE Dockerfile SHALL produce a container image smaller than 2 GB uncompressed to stay within Lambda container image size limits.

### Requirement 5: Real sensor execution in Lambda

**User Story:** As the orchestrator, I want sensors (tsc, eslint, cdk-nag, jest) to execute against real CLI tools in the Lambda container, so that sensor results reflect actual code quality rather than synthetic pass-through values.

#### Acceptance Criteria

1. WHEN `runLocalSensors` is called, THE Orchestrator_Lambda SHALL invoke `npx tsc --noEmit --pretty false` against the module root and parse the output into structured errors.
2. WHEN `runLocalSensors` is called, THE Orchestrator_Lambda SHALL invoke `npx eslint . --format json` against the module root and parse the output into structured findings.
3. WHEN `runLocalSensors` is called, THE Orchestrator_Lambda SHALL invoke `npx cdk synth --strict --no-color` against the module root and parse cdk-nag annotations into structured findings.
4. WHEN `runLocalSensors` is called, THE Orchestrator_Lambda SHALL invoke `npx jest --json` against the module root and parse the output into structured test results.
5. THE Orchestrator_Lambda SHALL remove the `safeSensorCall` fallback that silently passes sensors when CLI tools are missing, so that a missing tool causes a visible failure.

### Requirement 6: Real cdk deploy to ephemeral preview stack

**User Story:** As the orchestrator, I want `cdk deploy` to execute within the Lambda container against an ephemeral preview CloudFormation stack, so that the bounded loop validates real deployments.

#### Acceptance Criteria

1. WHEN `runLocalCdkDeploy` is called, THE Orchestrator_Lambda SHALL execute `cdk deploy` from the module root using the CDK CLI available in the container image.
2. THE Orchestrator_Lambda SHALL pass a unique stack name derived from the session ID to `cdk deploy` so each loop execution targets an isolated ephemeral Preview_Stack.
3. WHEN `cdk deploy` succeeds, THE Orchestrator_Lambda SHALL capture the stack outputs (endpoint URLs, resource ARNs) and return them in the `DeployResult`.
4. IF `cdk deploy` fails, THEN THE Orchestrator_Lambda SHALL capture the failure logs and return them in the `DeployResult` with `success: false`.
5. THE Orchestrator_Lambda SHALL remove the `safeSensorCall`-style fallback that returns synthetic success when `cdk deploy` cannot spawn, so that a deploy failure is visible to the loop.

### Requirement 7: Real post-deploy harness execution

**User Story:** As the orchestrator, I want the post-deploy harness to execute HTTP assertions against the real deployed Preview_Stack, so that the bounded loop validates end-to-end behaviour in a live environment.

#### Acceptance Criteria

1. WHEN `runLocalPostDeploy` is called with `stackOutputs` containing an API endpoint URL, THE Post_Deploy_Harness SHALL send HTTP requests to the deployed Preview_Stack endpoint.
2. WHEN all HTTP assertions pass, THE Post_Deploy_Harness SHALL return `outcome: "passed"` with a structured report of each assertion result.
3. IF any HTTP assertion fails, THEN THE Post_Deploy_Harness SHALL return `outcome: "failed"` with a structured report including the failing assertion, expected value, and actual value.
4. IF `stackOutputs` is not provided or the deploy failed, THEN THE Post_Deploy_Harness SHALL return `outcome: "deploy-failure"` without attempting HTTP assertions.

### Requirement 8: Module files on writable filesystem

**User Story:** As the editor agent, I want module files available on a writable filesystem in the Lambda container, so that `module.readFile` and `module.writeFile` tool calls operate on real files that sensors and cdk deploy subsequently read.

#### Acceptance Criteria

1. THE Dockerfile SHALL copy the module source directory (`modules/fanout/`) to a known absolute path within the container image.
2. WHEN the editor agent calls `module.writeFile`, THE Orchestrator_Lambda SHALL write the file contents to the container filesystem at the resolved module path so subsequent sensor and deploy invocations read the updated code.
3. THE Orchestrator_Lambda SHALL resolve `moduleRoot` to the container filesystem path where the module source is located rather than relying on the bundled zip path.

### Requirement 9: Remove synthetic first-iteration failure

**User Story:** As a developer, I want the orchestrator to use real sensor results on every iteration, so that the bounded loop demonstrates genuine feedback rather than a hardcoded synthetic failure.

#### Acceptance Criteria

1. THE Orchestrator_Lambda SHALL remove the `isFirstIteration` check in `runSensors` that returns a hardcoded synthetic tsc failure on the first iteration.
2. WHEN `runSensors` is called on any iteration, THE Orchestrator_Lambda SHALL invoke real sensors and return their actual results.

### Requirement 10: Conversation message assembly for multi-turn

**User Story:** As the orchestrator, I want the InvokeHarness messages array correctly assembled across turns, so that the model receives its full conversation history including tool-use requests and tool results.

#### Acceptance Criteria

1. WHEN re-invoking InvokeHarness after executing inline_function tools, THE ManagedHarnessEditorInvocation SHALL include the prior assistant message (containing the tool-use blocks) followed by a user message containing one `toolResult` content block per executed tool, matching each result to its `toolUseId`.
2. THE ManagedHarnessEditorInvocation SHALL preserve all prior messages from earlier turns in the messages array so the model has access to the full conversation context.
3. WHEN a tool-use block has `type: "server_tool_use"` or `type: "mcp_tool_use"`, THE ManagedHarnessEditorInvocation SHALL skip local execution for that block since server-executed tools are handled by AgentCore.
