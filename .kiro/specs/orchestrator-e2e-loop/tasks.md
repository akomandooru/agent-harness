# Implementation Plan: Orchestrator E2E Loop

## Overview

Transform the orchestrator Lambda from demonstration-mode into a fully functional end-to-end bounded loop with multi-turn tool execution, Docker-based deployment, real sensors, real cdk deploy, and real post-deploy assertions.

## Tasks

- [x] 1. Implement core multi-turn loop engine and tool executor
  - [x] 1.1 Create the ToolCatalogue and ToolExecutor
    - Create `app/orchestrator/tool-executor.ts`
    - Implement `ToolCatalogue` interface with `get(toolName)` method
    - Implement `ToolExecutor` that dispatches tool-use blocks to registered handlers
    - Produce `toolResult` blocks with `status: "success"` and JSON-serialized output on success
    - Produce `toolResult` blocks with `status: "error"` and error message on handler throw
    - Produce `toolResult` blocks with `status: "error"` for unregistered tool names
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ]* 1.2 Write property test for ToolExecutor result blocks
    - **Property 3: Tool executor produces correct result blocks**
    - Generate random tool names, inputs, and handler outcomes (success/error). Verify result block structure matches status and toolUseId.
    - **Validates: Requirements 3.1, 3.2, 3.3**

  - [x] 1.3 Create the MultiTurnExecutor engine
    - Create `app/orchestrator/multi-turn-executor.ts`
    - Implement `MultiTurnExecutorOptions` and `MultiTurnResult` interfaces
    - Implement the multi-turn loop: detect `stopReason: "tool_use"`, execute inline_function tools via ToolExecutor, re-invoke InvokeHarness with toolResult content blocks
    - Accumulate full conversation history (messages array) across all turns
    - Terminate loop on terminal stop reasons (`"end_turn"`, `"max_tokens"`, `"timeout_exceeded"`)
    - Throw `MaxTurnsExceededError` when configurable max turn count is exceeded
    - Filter tool-use blocks: only execute `type: "tool_use"`, skip `"server_tool_use"` and `"mcp_tool_use"`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 10.1, 10.2, 10.3_

  - [ ]* 1.4 Write property test for multi-turn message history invariant
    - **Property 1: Multi-turn message history invariant**
    - Generate random multi-turn sequences (1–10 turns), each with 1–5 tool-use blocks. Verify messages array correctness after each turn.
    - **Validates: Requirements 1.3, 10.1, 10.2**

  - [ ]* 1.5 Write property test for multi-turn loop termination
    - **Property 2: Multi-turn loop terminates on terminal stop reason**
    - Generate K (0–maxTurns-1) tool_use rounds + 1 terminal round. Verify exactly K+1 InvokeHarness calls and correct return.
    - **Validates: Requirements 1.2, 1.5, 2.2**

  - [ ]* 1.6 Write property test for server/MCP tool-use block skipping
    - **Property 4: Server and MCP tool-use blocks are skipped**
    - Generate random mixes of block types (`tool_use`, `server_tool_use`, `mcp_tool_use`). Verify only `tool_use` blocks are executed.
    - **Validates: Requirements 10.3**

  - [ ]* 1.7 Write property test for toolResult bijection
    - **Property 8: toolResult blocks match tool-use blocks by toolUseId**
    - Generate random tool-use block sets with unique toolUseIds. Verify 1:1 toolUseId mapping in results.
    - **Validates: Requirements 1.1, 2.1, 10.1**

- [x] 2. Update harness invocation classes to use MultiTurnExecutor
  - [x] 2.1 Refactor ManagedHarnessEditorInvocation for multi-turn support
    - Update `agents/editor/managed-harness-invocation.ts`
    - Accept `toolCatalogue` and `maxTurns` in constructor options
    - Replace single-shot InvokeHarness call with MultiTurnExecutor usage
    - Return accumulated edits from the full multi-turn conversation
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 10.1, 10.2, 10.3_

  - [x] 2.2 Refactor ManagedHarnessReviewerInvocation for multi-turn support
    - Update `harness/scheduled-reviewer/src/run.ts`
    - Accept `toolCatalogue` and `maxTurns` in constructor options
    - Replace single-shot InvokeHarness call with MultiTurnExecutor usage
    - _Requirements: 2.1, 2.2, 2.3_

  - [ ]* 2.3 Write unit tests for updated harness invocations
    - Test ManagedHarnessEditorInvocation multi-turn flow with mocked InvokeHarness
    - Test ManagedHarnessReviewerInvocation multi-turn flow with mocked InvokeHarness
    - Test MaxTurnsExceededError is thrown when cap is exceeded
    - _Requirements: 1.4, 2.3_

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Switch to DockerImageFunction and create Dockerfile
  - [x] 4.1 Create Dockerfile.orchestrator
    - Create `Dockerfile.orchestrator` at project root
    - Base on `public.ecr.aws/lambda/nodejs:22`
    - Install global toolchain: `aws-cdk`, `typescript`, `eslint`, `jest`
    - Copy project source including `modules/fanout/` to a writable path
    - Set CMD to `app/orchestrator/index.handler`
    - Keep image under 2 GB uncompressed
    - _Requirements: 4.2, 4.3, 4.5, 8.1_

  - [x] 4.2 Update OrchestratorStack to use DockerImageFunction
    - Modify `infrastructure/orchestrator-stack.ts` (or equivalent CDK stack file)
    - Replace `NodejsFunction` with `DockerImageFunction` using `DockerImageCode.fromImageAsset`
    - Retain same IAM permissions, environment variables, timeout (900s), and memory (1024 MB)
    - _Requirements: 4.1, 4.4_

  - [ ]* 4.3 Write CDK assertion tests for DockerImageFunction
    - Synth the stack and assert `AWS::Lambda::Function` uses `PackageType: Image`
    - Assert IAM role, timeout, memory, and environment variables match expectations
    - _Requirements: 4.1, 4.4_

- [x] 5. Implement real sensors and remove fallbacks
  - [x] 5.1 Rewrite runLocalSensors to invoke real CLI tools
    - Update `runLocalSensors` to execute `tsc`, `eslint`, `cdk-nag`, `jest` via real CLI invocations
    - Remove `safeSensorCall` fallback logic entirely
    - Parse each sensor's output into structured results
    - Resolve `moduleRoot` to the container filesystem path
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 8.3_

  - [x] 5.2 Remove synthetic first-iteration failure
    - Remove the `isFirstIteration` check in `runSensors` that returns a hardcoded synthetic tsc failure
    - Ensure all iterations invoke real sensors
    - _Requirements: 9.1, 9.2_

  - [ ]* 5.3 Write unit tests for real sensor execution
    - Test that missing CLI tool propagates error (no fallback)
    - Test that first iteration uses real sensors
    - _Requirements: 5.5, 9.1_

- [x] 6. Implement real cdk deploy with session-derived stack name
  - [x] 6.1 Rewrite runLocalCdkDeploy for real deployment
    - Update `runLocalCdkDeploy` to execute `cdk deploy` with real CDK CLI
    - Derive stack name from session ID as `preview-${sessionId}`
    - Capture stack outputs (endpoint URLs, resource ARNs) on success
    - Capture failure logs on deploy failure
    - Remove `safeSensorCall`-style fallback for deploy
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ]* 6.2 Write property test for session-derived stack name uniqueness
    - **Property 5: Session-derived stack name uniqueness**
    - Generate pairs of random session IDs. Verify derived names are distinct and valid CloudFormation stack names (alphanumeric + hyphens, 1–128 chars).
    - **Validates: Requirements 6.2**

- [x] 7. Implement real post-deploy harness
  - [x] 7.1 Implement runLocalPostDeploy with HTTP assertions
    - Implement `runLocalPostDeploy` to send HTTP requests to the deployed Preview_Stack endpoint from `stackOutputs`
    - Return `outcome: "passed"` with structured assertion report when all pass
    - Return `outcome: "failed"` with failing assertion details (expected vs actual) when any fail
    - Return `outcome: "deploy-failure"` when `stackOutputs` is undefined or deploy failed
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ]* 7.2 Write property test for post-deploy outcome
    - **Property 6: Post-deploy outcome reflects assertion results**
    - Generate random assertion sets (all-pass and mixed). Verify outcome and report structure match.
    - **Validates: Requirements 7.2, 7.3**

  - [ ]* 7.3 Write unit test for post-deploy with no stackOutputs
    - Test that missing stackOutputs returns `outcome: "deploy-failure"`
    - _Requirements: 7.4_

- [x] 8. Wire module filesystem tool handlers
  - [x] 8.1 Implement module.writeFile and module.readFile tool handlers
    - Register `module.writeFile` and `module.readFile` handlers in the tool catalogue
    - Write files to the container filesystem at the resolved module path
    - Ensure written files are visible to subsequent sensor and deploy invocations
    - _Requirements: 8.1, 8.2, 8.3_

  - [ ]* 8.2 Write property test for file write round-trip
    - **Property 7: File write round-trip on container filesystem**
    - Generate random file paths (relative to moduleRoot) and contents. Verify write-then-read identity.
    - **Validates: Requirements 8.2**

- [x] 9. Integration and wiring
  - [x] 9.1 Wire all components into the orchestrator handler
    - Update `app/orchestrator/index.ts` Lambda handler
    - Instantiate ToolCatalogue with module.writeFile, module.readFile, and other tool handlers
    - Wire MultiTurnExecutor into ManagedHarnessEditorInvocation and ManagedHarnessReviewerInvocation
    - Connect real sensors, real cdk deploy, and real post-deploy into the bounded loop flow
    - _Requirements: 1.1, 1.2, 2.1, 2.2, 5.1, 6.1, 7.1_

  - [ ]* 9.2 Write integration tests for the full loop
    - Test multi-turn editor invocation with mocked InvokeHarness returning tool-use blocks
    - Test full bounded loop flow: sensors → editor → sensors → deploy → post-deploy
    - _Requirements: 1.1, 2.1, 5.1, 6.1, 7.1_

- [x] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The project uses TypeScript with fast-check for property-based testing
- All multi-turn logic is shared via `MultiTurnExecutor` to avoid duplication between editor and reviewer

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "4.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "4.2"] },
    { "id": 2, "tasks": ["1.4", "1.5", "1.6", "1.7", "2.1", "2.2", "4.3"] },
    { "id": 3, "tasks": ["2.3", "5.1", "5.2", "6.1", "8.1"] },
    { "id": 4, "tasks": ["5.3", "6.2", "7.1", "8.2"] },
    { "id": 5, "tasks": ["7.2", "7.3", "9.1"] },
    { "id": 6, "tasks": ["9.2"] }
  ]
}
```
