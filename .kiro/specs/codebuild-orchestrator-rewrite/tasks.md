# Implementation Plan: CodeBuild Orchestrator Rewrite

## Overview

Replace the Lambda-based orchestrator with AWS CodeBuild as the bounded loop runtime. Implementation proceeds in waves: session utilities and tool catalogue first, then gates and entry point, then webhook and git workflow, then CDK infrastructure, and finally integration wiring.

## Tasks

- [x] 1. Set up project structure and core utilities
  - [x] 1.1 Create `app/codebuild/` directory structure and `package.json` workspace entry
    - Create directories: `app/codebuild/`, `app/codebuild/__tests__/`, `app/codebuild/scripts/`, `app/webhook/`, `app/webhook/__tests__/`
    - Add `app/codebuild` and `app/webhook` to the workspace configuration in root `package.json`
    - Create `app/codebuild/tsconfig.json` extending the root config
    - _Requirements: 2.1_

  - [x] 1.2 Implement session ID derivation (`app/codebuild/session.ts`)
    - Implement `deriveSessionId(codeBuildBuildId: string): string` using SHA-256 hash truncated to 16 hex chars
    - Export the function for use by webhook and main entry point
    - _Requirements: 1.2, 3.5_

  - [ ]* 1.3 Write property test for session ID derivation
    - **Property 1: Session ID derivation is deterministic and collision-resistant**
    - **Validates: Requirements 1.2, 3.5**
    - Test file: `app/codebuild/__tests__/session.prop.test.ts`
    - Use `fc.string()` for build IDs; assert same input → same output; assert distinct inputs → distinct outputs

  - [x] 1.4 Implement input normalization utility (`app/codebuild/normalize-input.ts`)
    - Implement function that coerces tool-use block inputs to valid JSON objects
    - Handle primitives, arrays, null, and objects with `type` field
    - Remove `type` key from normalized output
    - _Requirements: 1.5_

  - [ ]* 1.5 Write property test for input normalization
    - **Property 2: Malformed tool-use input normalization**
    - **Validates: Requirements 1.5**
    - Test file: `app/codebuild/__tests__/normalization.prop.test.ts`
    - Use `fc.anything()` for malformed inputs; assert output is always a non-null, non-array object without `type` key

- [x] 2. Implement tool catalogue and module filesystem tools
  - [x] 2.1 Implement tool catalogue (`app/codebuild/tool-catalogue.ts`)
    - Create `createCodeBuildToolCatalogue(options: { moduleRoot: string }): MapToolCatalogue`
    - Register exactly three tools: `module_readFile`, `module_writeFile`, `module_listFiles`
    - Implement `module_readFile`: read file at `moduleRoot + input.path`, return contents
    - Implement `module_writeFile`: write `input.content` to `moduleRoot + input.path`, create directories as needed
    - Implement `module_listFiles`: return glob-matched paths relative to moduleRoot
    - Unregistered tool calls return error toolResult with `"Tool not registered: {toolName}"`
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.6, 5.7_

  - [ ]* 2.2 Write property test for unregistered tool rejection
    - **Property 8: Unregistered tool rejection**
    - **Validates: Requirements 5.3**
    - Test file: `app/codebuild/__tests__/tool-catalogue.prop.test.ts`
    - Use `fc.string().filter(s => !['module_readFile','module_writeFile','module_listFiles'].includes(s))`

  - [ ]* 2.3 Write property tests for module file operations
    - **Property 9: Module file read/write round-trip**
    - **Property 10: Module listFiles returns only matching paths**
    - **Validates: Requirements 5.5, 5.6, 5.7**
    - Test file: `app/codebuild/__tests__/module-tools.prop.test.ts`
    - Use temp directories for filesystem isolation; `fc.string()` for paths and content

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement CodeBuild LoopGates
  - [x] 4.1 Implement subprocess execution utility (`app/codebuild/exec.ts`)
    - Implement `execWithTimeout(cmd, args, options: { cwd, timeout }): Promise<{ stdout, stderr, exitCode }>`
    - Use `child_process.execFile` with signal-based timeout (SIGTERM → 5s → SIGKILL)
    - Return structured result regardless of exit code; throw only on spawn failure
    - _Requirements: 6.2, 6.4, 6.5_

  - [x] 4.2 Implement sensor gate (`app/codebuild/gates/sensors.ts`)
    - Run tsc, eslint, jest, cdk-nag as subprocess invocations in the moduleRoot
    - Capture stdout, stderr, exit code for each sensor
    - Parse non-zero exit output into structured findings array
    - Apply per-sensor timeout of 120 seconds; report timeout finding on exceed
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ]* 4.3 Write property test for sensor output parsing
    - **Property 11: Sensor output parsing produces structured findings**
    - **Validates: Requirements 6.3**
    - Test file: `app/codebuild/__tests__/sensors.prop.test.ts`
    - Use `fc.string()` for error outputs with non-zero exit codes

  - [x] 4.4 Implement deploy gate (`app/codebuild/gates/deploy.ts`)
    - Run `npx cdk deploy --require-approval never` as subprocess
    - Parse CDK deploy JSON output to extract stack outputs (OutputKey → OutputValue)
    - Feed deploy errors back to editor on failure
    - _Requirements: 7.1, 7.2, 7.4_

  - [ ]* 4.5 Write property test for CDK deploy output parsing
    - **Property 12: CDK deploy output parsing extracts stack outputs**
    - **Validates: Requirements 7.2**
    - Test file: `app/codebuild/__tests__/deploy.prop.test.ts`
    - Use custom CDK output arbitrary with `Stacks[].Outputs[]` structure

  - [x] 4.6 Implement post-deploy gate (`app/codebuild/gates/post-deploy.ts`)
    - Run HTTP assertions against deployed endpoint using stack outputs
    - Report assertion failures back to editor on failure
    - _Requirements: 7.3, 7.5_

  - [x] 4.7 Implement editor and reviewer gates (`app/codebuild/gates/harness.ts`)
    - Implement `runEditor` using `ManagedHarnessEditorInvocation` with the trimmed tool catalogue
    - Implement `runReviewer` using `ManagedHarnessReviewerInvocation`
    - Wire input normalization into tool-use response handling
    - _Requirements: 1.1, 5.4, 8.1_

  - [x] 4.8 Assemble `createCodeBuildGates` factory (`app/codebuild/gates.ts`)
    - Combine all gate implementations into a single `LoopGates` object
    - Accept `CodeBuildGatesOptions` (moduleRoot, sessionId, harness ARNs, tool catalogue, sensorTimeout)
    - _Requirements: 8.1_

- [x] 5. Implement git operations and PR body generation
  - [x] 5.1 Implement git operations module (`app/codebuild/git.ts`)
    - Implement `GitOps` interface: clone, createBranch, stageAll, commit, push, hasCommitsAhead
    - Use `child_process.execFile` for each git command
    - Inject token via HTTPS URL: `https://x-access-token:{token}@github.com/{org}/{repo}.git`
    - Derive feature branch name as `agent-harness/{sessionId}`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [ ]* 5.2 Write property test for feature branch name derivation
    - **Property 6: Feature branch name derivation**
    - **Validates: Requirements 4.2**
    - Test file: `app/codebuild/__tests__/git.prop.test.ts`
    - Use `fc.string()` for session IDs; assert format `agent-harness/{sessionId}` and valid git branch name

  - [x] 5.3 Implement PR body generation (`app/codebuild/pr-body.ts`)
    - Generate PR body containing: session ID, iteration count, module path, sensor summary
    - Generate partial PR body containing: termination reason in addition to standard fields
    - Use existing PR body template patterns from `agents/editor/pr-body.ts` as reference
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [ ]* 5.4 Write property test for PR body completeness
    - **Property 13: PR body completeness**
    - **Validates: Requirements 9.2, 9.3**
    - Test file: `app/codebuild/__tests__/pr-body.prop.test.ts`
    - Use custom session record arbitrary; assert required fields present in output

  - [x] 5.5 Implement PR opening gate (`app/codebuild/gates/pr.ts`)
    - Call GitHub API to create PR from feature branch to base ref
    - Verify feature branch has at least one commit ahead before opening
    - Only called in non-local mode
    - _Requirements: 9.1, 9.4_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement CodeBuild entry point and local mode
  - [x] 7.1 Implement config loading (`app/codebuild/config.ts`)
    - Parse `CodeBuildConfig` from environment variables (TRIGGER_PAYLOAD, SESSION_ID, LOCAL_MODE, CODEBUILD_BUILD_ID, CODEBUILD_SRC_DIR)
    - Default to local mode when TRIGGER_PAYLOAD is absent
    - Load loop configuration from `agent-harness.config.json`
    - Default local-mode synthetic trigger targeting `modules/fanout`
    - _Requirements: 11.1, 11.6, 8.4_

  - [ ]* 7.2 Write unit tests for config loading
    - Test env var parsing and defaults
    - Test local mode detection (--local flag, LOCAL_MODE=true, absent TRIGGER_PAYLOAD)
    - Test synthetic trigger generation for local mode
    - _Requirements: 11.1, 11.6_

  - [x] 7.3 Implement main entry point (`app/codebuild/main.ts`)
    - Parse config from environment
    - If not local mode: git clone → checkout commitSha → create branch
    - Build tool catalogue and LoopGates
    - Call `runLoop(session, store, config, killSwitchPoll, gates)`
    - If not local mode: git add → commit → push → open PR (handling early termination)
    - Write session record to build artifacts
    - Exit with code 0 (success/partial) or 1 (fatal error)
    - _Requirements: 8.1, 8.2, 8.3, 4.6, 11.2, 11.3, 11.4_

  - [x] 7.4 Create buildspec scripts (`app/codebuild/scripts/git-clone.js`, `app/codebuild/scripts/git-push-and-pr.js`)
    - `git-clone.js`: parse TRIGGER_PAYLOAD, clone repo at commitSha, create feature branch
    - `git-push-and-pr.js`: stage, commit, push, open PR (reuses git.ts and pr.ts)
    - _Requirements: 4.1, 4.2, 4.3, 9.1_

- [x] 8. Implement Webhook Lambda
  - [x] 8.1 Implement webhook handler (`app/webhook/handler.ts`)
    - Parse and validate TriggerPayload from event.body
    - Validate required fields: issue.number, module.repository, module.path, module.ref, auth.githubInstallationToken
    - Generate sessionId via `deriveSessionId` or use provided override
    - Call `codebuild.startBuild` with TRIGGER_PAYLOAD and SESSION_ID as environment variable overrides
    - Return 202 with `{ buildId }` on success, 400 on validation failure, 500 on StartBuild failure
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [ ]* 8.2 Write property tests for webhook handler
    - **Property 3: Webhook accepts all valid trigger payloads**
    - **Property 4: Webhook rejects all invalid trigger payloads**
    - **Property 5: Trigger payload serialization round-trip**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
    - Test file: `app/webhook/__tests__/handler.prop.test.ts`
    - Use custom `triggerPayloadArbitrary` generator

- [x] 9. Implement CDK infrastructure stack
  - [x] 9.1 Create CDK construct for CodeBuild project (`infrastructure/codebuild-orchestrator-stack.ts`)
    - Define CodeBuild project: Linux, standard:7.0 image, configurable compute type and timeout (default 60min, max 480min)
    - Define IAM role with: InvokeHarness, CloudFormation/S3/IAM:PassRole, CloudWatch Logs permissions
    - Accept environment variable overrides (TRIGGER_PAYLOAD, SESSION_ID, harness ARNs)
    - Embed buildspec inline from the design spec
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [x] 9.2 Create CDK construct for Webhook Lambda and API Gateway
    - Define Lambda function (~50 lines handler reference)
    - Define API Gateway REST API with POST /webhook route
    - Define IAM role with codebuild:StartBuild permission
    - _Requirements: 3.1, 10.1_

  - [x] 9.3 Create unified CDK app entry point
    - Provision all resources in a single `cdk deploy`: IAM roles, Webhook Lambda, API Gateway, CodeBuild Project, harness ARN context
    - Output API Gateway endpoint URL and required GitHub secret names
    - _Requirements: 10.1, 10.2_

  - [ ]* 9.4 Write CDK assertion tests
    - Snapshot test for synthesized CloudFormation
    - Fine-grained assertions for IAM policies, environment variables, buildspec content
    - Assert timeout configuration (default 60, max 480)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.7_

- [x] 10. Integration wiring and end-to-end validation
  - [x] 10.1 Wire GitHub Actions workflow to new webhook endpoint
    - Update `dispatch-agent-task.yml` to POST to the new API Gateway endpoint instead of invoking Lambda directly
    - Ensure trigger payload format matches the `TriggerPayload` interface
    - _Requirements: 10.3_

  - [x] 10.2 Create buildspec.yml at project root (`buildspec.yml`)
    - Implement the buildspec structure from the design: install, pre_build, build, post_build phases
    - Configure artifacts and cache paths
    - _Requirements: 2.6_

  - [ ]* 10.3 Write integration tests for local mode end-to-end
    - Test full bounded loop in local mode (no git) using a test module
    - Verify session record output, iteration count, sensor outcomes
    - _Requirements: 11.3, 11.4, 11.5_

- [x] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The implementation uses TypeScript throughout, matching the existing codebase
- The existing `runLoop`, `LoopGates`, and `ManagedHarnessEditorInvocation` are reused, not rewritten
- CDK infrastructure can be developed in parallel with runtime code after interfaces are established

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.4", "2.1"] },
    { "id": 2, "tasks": ["1.3", "1.5", "2.2", "2.3"] },
    { "id": 3, "tasks": ["4.1", "5.1", "5.3"] },
    { "id": 4, "tasks": ["4.2", "4.4", "4.6", "4.7", "5.2", "5.4", "5.5"] },
    { "id": 5, "tasks": ["4.3", "4.5", "4.8"] },
    { "id": 6, "tasks": ["7.1", "8.1"] },
    { "id": 7, "tasks": ["7.2", "7.3", "7.4", "8.2"] },
    { "id": 8, "tasks": ["9.1", "9.2"] },
    { "id": 9, "tasks": ["9.3", "9.4"] },
    { "id": 10, "tasks": ["10.1", "10.2", "10.3"] }
  ]
}
```
