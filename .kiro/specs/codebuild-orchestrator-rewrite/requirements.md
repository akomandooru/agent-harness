# Requirements Document

## Introduction

Replace the Lambda-based orchestrator with AWS CodeBuild as the bounded loop runtime. The current Lambda architecture fails due to subprocess spawn restrictions, 15-minute timeout, read-only filesystem, and tool catalogue mismatch. CodeBuild provides a full Linux environment with normal subprocess spawning, real git clone/push workflows, 8-hour configurable timeout, and a writable filesystem. The architecture shifts from a monolithic Lambda handler to a thin webhook Lambda that starts a CodeBuild build, which then runs the bounded loop end-to-end.

## Glossary

- **Orchestrator**: The runtime that executes the bounded edit-sense-review-deploy loop
- **CodeBuild_Project**: The AWS CodeBuild project that replaces the Lambda orchestrator
- **Webhook_Lambda**: A thin Lambda function that receives GitHub dispatch events and starts CodeBuild builds
- **Bounded_Loop**: The iterative cycle of editor invocation, sensor checks, reviewer invocation, deploy, and post-deploy assertions
- **Editor_Harness**: The AgentCore Managed Harness that runs the editor agent in multi-turn mode
- **Reviewer_Harness**: The AgentCore Managed Harness that runs the reviewer agent
- **Sensor**: A CLI tool (tsc, eslint, jest, cdk-nag) that validates code quality between editor iterations
- **Tool_Catalogue**: The registry of tools available to the editor agent via InvokeHarness
- **Module_Root**: The directory within the cloned repository containing the CDK module under maintenance
- **Validation_Spike**: A minimal CodeBuild build that proves AgentCore InvokeHarness works correctly from the CodeBuild environment
- **Session_ID**: A unique identifier per build invocation used for AgentCore session isolation
- **Feature_Branch**: The git branch created by the orchestrator to hold the agent's edits

## Requirements

### Requirement 1: Validation Spike

**User Story:** As a platform engineer, I want to validate that AgentCore InvokeHarness works from CodeBuild before committing to the full rewrite, so that I can de-risk the migration.

#### Acceptance Criteria

1. WHEN the Validation_Spike CodeBuild build runs, THE Orchestrator SHALL invoke the Editor_Harness with a single-turn prompt and receive a valid response
2. WHEN the Validation_Spike build invokes InvokeHarness, THE Orchestrator SHALL use a unique Session_ID derived from the CodeBuild build ID to avoid session-state caching collisions
3. WHEN the Validation_Spike build completes, THE Orchestrator SHALL log the round-trip latency, response token count, and any error details to CloudWatch
4. WHEN the Validation_Spike build executes a subprocess (e.g., `tsc --version`), THE Orchestrator SHALL spawn the process successfully and capture its stdout and exit code
5. IF the InvokeHarness call returns a toolUse block with malformed input, THEN THE Orchestrator SHALL normalize the input (coerce to object, remove `type` field) and continue the session without error

### Requirement 2: CodeBuild Project Infrastructure

**User Story:** As a platform engineer, I want a CDK construct that provisions the CodeBuild project with correct configuration, so that the orchestrator has a properly configured runtime environment.

#### Acceptance Criteria

1. THE CodeBuild_Project SHALL be defined as a CDK construct with a configurable compute type, timeout, and environment image
2. THE CodeBuild_Project SHALL have an IAM role with permissions to invoke AgentCore Managed Harnesses (bedrock:InvokeAgent, bedrock:InvokeHarness)
3. THE CodeBuild_Project SHALL have an IAM role with permissions to deploy CDK stacks (cloudformation:*, s3:*, iam:PassRole for the CDK deploy role)
4. THE CodeBuild_Project SHALL have an IAM role with permissions to read and write to the CodeBuild project's own logs (logs:CreateLogGroup, logs:CreateLogStream, logs:PutLogEvents)
5. THE CodeBuild_Project SHALL accept environment variable overrides at build start time for trigger payload, git credentials, and session configuration
6. WHEN the CDK stack is synthesized, THE CodeBuild_Project SHALL produce a buildspec that clones the repository, installs dependencies, and runs the bounded loop entry point
7. THE CodeBuild_Project SHALL have a configurable timeout defaulting to 60 minutes with a maximum of 480 minutes

### Requirement 3: Webhook Lambda

**User Story:** As a platform engineer, I want a thin Lambda that receives dispatch events and starts CodeBuild builds, so that the existing GitHub Actions trigger workflow continues to work unchanged.

#### Acceptance Criteria

1. WHEN the Webhook_Lambda receives a POST request with a valid trigger payload, THE Webhook_Lambda SHALL start a CodeBuild build with the trigger payload passed as environment variable overrides and return HTTP 202
2. WHEN the Webhook_Lambda receives a POST request with a missing or malformed trigger payload, THE Webhook_Lambda SHALL return HTTP 400 with a descriptive error message
3. THE Webhook_Lambda SHALL validate that the trigger payload contains required fields: issue number, module repository, module path, module ref, and auth credentials
4. WHEN the Webhook_Lambda starts a CodeBuild build, THE Webhook_Lambda SHALL pass the full trigger payload as a single JSON-encoded environment variable (TRIGGER_PAYLOAD)
5. WHEN the Webhook_Lambda starts a CodeBuild build, THE Webhook_Lambda SHALL generate a unique Session_ID and pass it as an environment variable override
6. IF the CodeBuild StartBuild API call fails, THEN THE Webhook_Lambda SHALL return HTTP 500 with the error details

### Requirement 4: Real Git Workflow

**User Story:** As a platform engineer, I want the orchestrator to perform real git clone, branch, commit, and push operations, so that PRs contain actual code diffs.

#### Acceptance Criteria

1. WHEN the CodeBuild build starts, THE Orchestrator SHALL clone the repository at the commit SHA specified in the trigger payload
2. WHEN the CodeBuild build starts, THE Orchestrator SHALL create a Feature_Branch named `agent-harness/{session-id}` from the cloned commit
3. WHEN the Bounded_Loop completes with edits, THE Orchestrator SHALL stage all modified files, create a git commit with a descriptive message, and push the Feature_Branch to the remote
4. WHEN pushing the Feature_Branch, THE Orchestrator SHALL authenticate using the GitHub installation token from the trigger payload
5. IF the git push fails due to a conflict or authentication error, THEN THE Orchestrator SHALL log the error details and terminate the build with a non-zero exit code
6. WHEN the Bounded_Loop terminates early (kill switch, iteration cap, oscillation), THE Orchestrator SHALL still commit and push any partial edits before opening a partial PR

### Requirement 5: Editor Tool Trimming

**User Story:** As a platform engineer, I want the editor harness to only have access to module filesystem tools, so that the agent cannot accidentally invoke sensors, deploy, or PR tools directly.

#### Acceptance Criteria

1. THE Tool_Catalogue SHALL register exactly three tools: module_readFile, module_writeFile, and module_listFiles
2. THE Tool_Catalogue SHALL use underscore naming convention (module_readFile, module_writeFile, module_listFiles) matching Bedrock's tool naming convention
3. WHEN the Editor_Harness returns a toolUse block for a tool not in the Tool_Catalogue, THE Orchestrator SHALL return a toolResult with status "error" and message "Tool not registered: {toolName}"
4. THE Editor_Harness system prompt SHALL list only module_readFile, module_writeFile, and module_listFiles as available tools
5. WHEN module_readFile is invoked with a valid relative path, THE Tool_Catalogue SHALL read the file from the cloned repository's Module_Root and return its contents
6. WHEN module_writeFile is invoked with a valid relative path and content, THE Tool_Catalogue SHALL write the file to the cloned repository's Module_Root on the real filesystem
7. WHEN module_listFiles is invoked with a glob pattern, THE Tool_Catalogue SHALL return matching file paths relative to Module_Root

### Requirement 6: Sensors as Runtime Gates

**User Story:** As a platform engineer, I want sensors to run as real CLI invocations between editor iterations, so that the agent gets accurate feedback from standard tooling.

#### Acceptance Criteria

1. WHEN an editor iteration completes, THE Orchestrator SHALL run tsc, eslint, jest, and cdk-nag as subprocess invocations in the Module_Root directory
2. WHEN a Sensor subprocess completes, THE Orchestrator SHALL capture its stdout, stderr, and exit code
3. WHEN a Sensor subprocess exits with a non-zero code, THE Orchestrator SHALL parse the output into structured findings and feed them back to the editor in the next iteration
4. THE Orchestrator SHALL run sensors sequentially or in parallel as configured, with a per-sensor timeout of 120 seconds
5. IF a Sensor subprocess exceeds its timeout, THEN THE Orchestrator SHALL kill the process and report a timeout finding to the editor

### Requirement 7: Deploy and Post-Deploy as Runtime Gates

**User Story:** As a platform engineer, I want cdk deploy and post-deploy assertions to run as runtime steps controlled by the orchestrator, so that the deploy pipeline is deterministic and observable.

#### Acceptance Criteria

1. WHEN all sensors pass, THE Orchestrator SHALL run `cdk deploy` targeting the preview stack as a subprocess
2. WHEN the cdk deploy subprocess completes successfully, THE Orchestrator SHALL extract stack outputs from the CDK output
3. WHEN the deploy succeeds and stack outputs are available, THE Orchestrator SHALL run post-deploy HTTP assertions against the deployed endpoint
4. IF the cdk deploy subprocess fails, THEN THE Orchestrator SHALL feed the deploy error output back to the editor for the next iteration
5. WHEN post-deploy assertions fail, THE Orchestrator SHALL feed the failure details back to the editor for the next iteration

### Requirement 8: Bounded Loop Integration

**User Story:** As a platform engineer, I want the existing bounded loop logic (LoopGates, stop conditions, session record) to work within CodeBuild, so that proven convergence logic is preserved.

#### Acceptance Criteria

1. THE Orchestrator SHALL reuse the existing `runLoop` function with `LoopGates` wired to CodeBuild-native implementations
2. THE Orchestrator SHALL reuse the existing stop condition logic (iteration cap, wall-clock cap, token spend cap, oscillation detection, kill switch)
3. WHEN the Bounded_Loop completes, THE Orchestrator SHALL write the session record to a well-known path in the build artifacts
4. THE Orchestrator SHALL load loop configuration from `agent-harness.config.json` at the repository root

### Requirement 9: PR Opening with Real Code Changes

**User Story:** As a platform engineer, I want the PR opened at the end of the loop to show actual code diffs, so that reviewers can see what the agent changed.

#### Acceptance Criteria

1. WHEN the Bounded_Loop completes successfully, THE Orchestrator SHALL open a GitHub PR from the Feature_Branch to the base ref
2. THE Orchestrator SHALL include a PR body with the session summary, iteration count, sensor results, and reviewer findings
3. WHEN the Bounded_Loop terminates early, THE Orchestrator SHALL open a partial PR with a body indicating incomplete convergence and the termination reason
4. THE Orchestrator SHALL verify that the Feature_Branch has at least one commit ahead of the base ref before opening a PR

### Requirement 10: Simplified Quickstart

**User Story:** As a new user, I want to deploy a single CDK app that sets up the complete system, so that I can get started without complex multi-step setup.

#### Acceptance Criteria

1. THE infrastructure stack SHALL provision all resources in a single `cdk deploy` command: IAM roles, Webhook_Lambda, API Gateway, CodeBuild_Project, and AgentCore harness registrations
2. THE infrastructure stack SHALL output the API Gateway endpoint URL and required GitHub secret names for easy copy-paste setup
3. WHEN a user creates a GitHub issue with the agent-task template, THE system SHALL trigger the full pipeline from webhook through CodeBuild to PR without manual intervention

### Requirement 11: Local Mode (No Git Required)

**User Story:** As a developer testing the bounded loop, I want to run the loop directly from CodeBuild against a local source directory without git clone or push, so that I can validate the loop independently of git integration.

#### Acceptance Criteria

1. WHEN the Orchestrator is invoked with a `--local` flag or `LOCAL_MODE=true` environment variable, THE Orchestrator SHALL skip the git clone step and use the source directory already present in the CodeBuild build environment
2. WHEN running in local mode, THE Orchestrator SHALL skip the git commit, push, and PR opening steps after the loop completes
3. WHEN running in local mode, THE Orchestrator SHALL still run the full bounded loop: editor invocation, sensors, reviewer, deploy, and post-deploy
4. WHEN running in local mode, THE Orchestrator SHALL output the loop results (iteration count, sensor outcomes, deploy outcome, edits made) to stdout and the build log
5. THE Validation_Spike (Requirement 1) SHALL use local mode to prove the loop works without any git dependency
6. WHEN the CodeBuild build is started manually via `aws codebuild start-build` without a trigger payload, THE Orchestrator SHALL default to local mode with a synthetic trigger targeting the bundled module at `modules/fanout`
