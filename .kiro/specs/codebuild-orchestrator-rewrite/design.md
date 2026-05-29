# Design Document: CodeBuild Orchestrator Rewrite

## Overview

This design replaces the Lambda-based orchestrator (`app/orchestrator/index.ts`) with AWS CodeBuild as the bounded loop runtime. The current `DockerImageFunction` Lambda architecture is constrained by a 15-minute timeout, read-only filesystem (outside `/tmp`), subprocess spawn restrictions, and tool catalogue mismatch (dot-notation vs underscore naming). CodeBuild eliminates all four constraints: configurable timeout up to 8 hours, full writable filesystem, unrestricted subprocess spawning, and a real git working tree for producing actual code diffs.

The architecture introduces a thin Webhook Lambda (~50 lines) that receives GitHub dispatch events and starts CodeBuild builds. The CodeBuild build then runs the bounded loop end-to-end using the existing `runLoop` function with `LoopGates` wired to CodeBuild-native implementations (real subprocesses for sensors, real `cdk deploy`, real git clone/push/PR).

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| CodeBuild over ECS/Step Functions | Full Linux env, built-in git credentials helper, buildspec-driven lifecycle, no orchestration overhead |
| Thin webhook Lambda | Keeps existing GitHub Actions trigger workflow unchanged; CodeBuild cannot expose a REST endpoint directly |
| Editor tools trimmed to 3 | Agent should only read/write/list module files; sensors, deploy, PR are runtime gates controlled by the orchestrator |
| Underscore naming (`module_readFile`) | Matches Bedrock's tool naming convention; eliminates the dot-notation workaround |
| Session ID from build ID | CodeBuild build IDs are globally unique; deterministic derivation avoids UUID collisions |
| Real git workflow | Actual code diffs in PRs instead of synthetic diffs computed from tool-use messages |
| Local mode | Enables validation and testing without git dependency |

## Architecture

```mermaid
flowchart TB
    subgraph GitHub
        GH_Issue[GitHub Issue<br/>agent-task template]
        GH_Actions[GitHub Actions<br/>dispatch-agent-task.yml]
        GH_PR[Pull Request]
    end

    subgraph AWS["AWS Account"]
        subgraph Webhook["Webhook Lambda (~50 lines)"]
            WH[Validate payload<br/>→ StartBuild]
        end

        subgraph CodeBuild["CodeBuild Project"]
            subgraph Buildspec["Buildspec Phases"]
                Install[install:<br/>npm ci]
                Pre[pre_build:<br/>git clone → branch]
                Build[build:<br/>runLoop]
                Post[post_build:<br/>commit → push → PR]
            end

            subgraph Loop["Bounded Loop (runLoop)"]
                Editor[Editor Harness<br/>InvokeHarness]
                Sensors[Sensors<br/>tsc, eslint, jest, cdk-nag]
                Reviewer[Reviewer Harness<br/>InvokeHarness]
                Deploy[cdk deploy<br/>preview stack]
                PostDeploy[Post-Deploy<br/>HTTP assertions]
            end
        end

        subgraph AgentCore["Bedrock AgentCore"]
            EditorH[Editor Managed Harness]
            ReviewerH[Reviewer Managed Harness]
        end

        APIGW[API Gateway<br/>POST /webhook]
    end

    GH_Issue --> GH_Actions
    GH_Actions -->|POST trigger| APIGW
    APIGW --> WH
    WH -->|StartBuild| CodeBuild
    Editor <-->|InvokeHarness| EditorH
    Reviewer <-->|InvokeHarness| ReviewerH
    Post -->|git push| GH_PR

    Editor --> Sensors
    Sensors -->|pass| Reviewer
    Sensors -->|fail| Editor
    Reviewer -->|pass| Deploy
    Reviewer -->|fail| Editor
    Deploy -->|ok| PostDeploy
    Deploy -->|fail| Editor
    PostDeploy -->|pass| Post
    PostDeploy -->|fail| Editor
```

### IAM Role Chain

```mermaid
flowchart LR
    subgraph Roles
        WebhookRole[Webhook Lambda Role]
        CBRole[CodeBuild Service Role]
    end

    WebhookRole -->|codebuild:StartBuild| CB[CodeBuild Project]
    CBRole -->|bedrock-agentcore:InvokeHarness| Harnesses[Editor + Reviewer Harness ARNs]
    CBRole -->|cloudformation:*,<br/>s3:*,<br/>iam:PassRole| CFN[CDK Deploy Role]
    CBRole -->|logs:*| CW[CloudWatch Logs]
    CBRole -->|codecommit:GitPull<br/>or HTTPS clone| Repo[Repository]
```

## Components and Interfaces

### 1. Webhook Lambda (`app/webhook/handler.ts`)

A thin Lambda function (~50 lines) that validates the trigger payload and starts a CodeBuild build.

```typescript
interface WebhookEvent {
  body: string; // JSON-encoded TriggerPayload
}

interface TriggerPayload {
  issue: {
    number: number;
    title: string;
  };
  module: {
    repository: string; // "org/repo"
    path: string;       // "modules/fanout"
    ref: string;        // "main"
    commitSha: string;  // specific commit to clone
  };
  auth: {
    githubInstallationToken: string;
  };
  session?: {
    id?: string; // Optional override; generated if absent
  };
}

interface WebhookResponse {
  statusCode: 202 | 400 | 500;
  body: string;
}

// Core logic:
// 1. Parse and validate TriggerPayload from event.body
// 2. Generate sessionId = deriveSessionId(codebuild-build-id) OR use provided
// 3. Call codebuild.startBuild({ projectName, environmentVariablesOverride: [
//      { name: "TRIGGER_PAYLOAD", value: JSON.stringify(payload) },
//      { name: "SESSION_ID", value: sessionId },
//    ]})
// 4. Return 202 with { buildId }
```

### 2. CodeBuild Entry Point (`app/codebuild/main.ts`)

The entry point invoked by the buildspec's `build` phase. Parses environment variables, sets up `LoopGates`, and calls `runLoop`.

```typescript
interface CodeBuildConfig {
  /** From TRIGGER_PAYLOAD env var, or synthetic for local mode */
  triggerPayload: TriggerPayload;
  /** From SESSION_ID env var, or derived from CODEBUILD_BUILD_ID */
  sessionId: string;
  /** From LOCAL_MODE env var or absence of TRIGGER_PAYLOAD */
  localMode: boolean;
  /** From CODEBUILD_SRC_DIR or cwd */
  sourceDir: string;
  /** Resolved module root: sourceDir + triggerPayload.module.path */
  moduleRoot: string;
}

// Entry point:
// 1. Parse config from environment
// 2. If !localMode: git clone → checkout commitSha → create branch
// 3. Build ToolCatalogue with module_readFile, module_writeFile, module_listFiles
// 4. Build LoopGates with CodeBuild-native implementations
// 5. Call runLoop(session, store, config, killSwitchPoll, gates)
// 6. If !localMode: git add → commit → push → open PR
// 7. Write session record to build artifacts
// 8. Exit with code 0 (success) or 1 (failure)
```

### 3. CodeBuild Tool Catalogue (`app/codebuild/tool-catalogue.ts`)

Registers exactly three tools with underscore naming convention.

```typescript
import { MapToolCatalogue, type ToolHandler } from "../orchestrator/tool-executor";

interface ModuleToolCatalogueOptions {
  moduleRoot: string; // Absolute path to cloned module directory
}

function createCodeBuildToolCatalogue(options: ModuleToolCatalogueOptions): MapToolCatalogue {
  const catalogue = new MapToolCatalogue();
  
  catalogue.register("module_readFile", createReadFileHandler(options.moduleRoot));
  catalogue.register("module_writeFile", createWriteFileHandler(options.moduleRoot));
  catalogue.register("module_listFiles", createListFilesHandler(options.moduleRoot));
  
  return catalogue;
}

// module_readFile: reads file at moduleRoot + input.path
// module_writeFile: writes content to moduleRoot + input.path  
// module_listFiles: returns glob-matched paths relative to moduleRoot
```

### 4. CodeBuild LoopGates (`app/codebuild/gates.ts`)

Implements `LoopGates` using real subprocess invocations.

```typescript
import { type LoopGates } from "@agent-harness/loop/src/run";
import { execFile } from "node:child_process";

interface CodeBuildGatesOptions {
  moduleRoot: string;
  sessionId: string;
  editorHarnessArn: string;
  reviewerHarnessArn: string;
  toolCatalogue: MapToolCatalogue;
  sensorTimeout: number; // Default 120_000 ms
}

function createCodeBuildGates(options: CodeBuildGatesOptions): LoopGates {
  return {
    runEditor: async (context) => {
      // Uses ManagedHarnessEditorInvocation (reused from existing code)
      // Tool catalogue contains only module_readFile, module_writeFile, module_listFiles
    },
    
    runSensors: async () => {
      // Spawns real subprocesses: tsc, eslint, jest, cdk-nag
      // Each with per-sensor timeout (default 120s)
      // Captures stdout, stderr, exit code
      // Parses output into structured findings on non-zero exit
    },
    
    runReviewer: async (diff) => {
      // Uses ManagedHarnessReviewerInvocation (reused from existing code)
    },
    
    runDeploy: async () => {
      // Spawns `npx cdk deploy --require-approval never` as subprocess
      // Parses CDK output JSON for stack outputs
    },
    
    runPostDeploy: async (stackOutputs) => {
      // Runs HTTP assertions against deployed endpoint (reused logic)
    },
    
    openPR: async (body, partial) => {
      // Calls GitHub API to create PR from feature branch
      // Only called in non-local mode
    },
  };
}
```

### 5. Git Operations (`app/codebuild/git.ts`)

Encapsulates all git subprocess invocations.

```typescript
interface GitOps {
  clone(repo: string, commitSha: string, destDir: string, token: string): Promise<void>;
  createBranch(branchName: string, cwd: string): Promise<void>;
  stageAll(cwd: string): Promise<void>;
  commit(message: string, cwd: string): Promise<void>;
  push(remote: string, branch: string, token: string, cwd: string): Promise<void>;
  hasCommitsAhead(baseBranch: string, cwd: string): Promise<boolean>;
}

// Implementation uses child_process.execFile for each git command
// Token injected via HTTPS URL: https://x-access-token:{token}@github.com/{org}/{repo}.git
```

### 6. Session ID Derivation (`app/codebuild/session.ts`)

```typescript
import { createHash } from "node:crypto";

/**
 * Derives a deterministic, unique session ID from the CodeBuild build ID.
 * 
 * CodeBuild build IDs have the form: project-name:build-uuid
 * We hash the full build ID to produce a fixed-length, URL-safe identifier.
 */
function deriveSessionId(codeBuildBuildId: string): string {
  return createHash("sha256")
    .update(codeBuildBuildId)
    .digest("hex")
    .slice(0, 16); // 16 hex chars = 64 bits of entropy, sufficient for session isolation
}
```

## Data Models

### Buildspec Structure

```yaml
version: 0.2

env:
  variables:
    LOCAL_MODE: "false"
  parameter-store: {}

phases:
  install:
    runtime-versions:
      nodejs: 22
    commands:
      - npm ci --workspace=app/codebuild --workspace=harness/loop --workspace=agents/editor --workspace=agents/reviewer

  pre_build:
    commands:
      - |
        if [ "$LOCAL_MODE" = "true" ] || [ -z "$TRIGGER_PAYLOAD" ]; then
          echo "Local mode: skipping git clone"
          export LOCAL_MODE=true
        else
          node app/codebuild/scripts/git-clone.js
        fi

  build:
    commands:
      - node app/codebuild/main.js

  post_build:
    commands:
      - |
        if [ "$LOCAL_MODE" != "true" ]; then
          node app/codebuild/scripts/git-push-and-pr.js
        fi
      - cp session-record.json $CODEBUILD_SRC_DIR/artifacts/

artifacts:
  files:
    - artifacts/session-record.json
  discard-paths: no

cache:
  paths:
    - node_modules/**/*
```

### Environment Variable Contract

| Variable | Source | Required | Description |
|----------|--------|----------|-------------|
| `TRIGGER_PAYLOAD` | Webhook Lambda override | No (local mode if absent) | JSON-encoded TriggerPayload |
| `SESSION_ID` | Webhook Lambda override | No (derived from CODEBUILD_BUILD_ID) | Session isolation key |
| `LOCAL_MODE` | Build override or default | No (defaults to "false") | Skip git operations |
| `CODEBUILD_BUILD_ID` | CodeBuild runtime | Yes (always present) | `project:uuid` format |
| `CODEBUILD_SRC_DIR` | CodeBuild runtime | Yes (always present) | Source directory path |
| `EDITOR_HARNESS_ARN` | Project environment | Yes | Editor Managed Harness ARN |
| `REVIEWER_HARNESS_ARN` | Project environment | Yes | Reviewer Managed Harness ARN |

### CDK Stack Resources

```typescript
interface CodeBuildOrchestratorStackResources {
  // Webhook
  webhookLambda: lambda.Function;        // ~50 lines handler
  webhookApi: apigateway.RestApi;         // POST /webhook
  webhookRole: iam.Role;                  // codebuild:StartBuild

  // CodeBuild
  codeBuildProject: codebuild.Project;    // Linux, standard:7.0, 60min default
  codeBuildRole: iam.Role;               // InvokeHarness + CloudFormation + Logs

  // Shared
  editorHarnessArn: string;              // From CDK context
  reviewerHarnessArn: string;            // From CDK context
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Session ID derivation is deterministic and collision-resistant

*For any* CodeBuild build ID string, `deriveSessionId` SHALL always produce the same 16-character hex output, and *for any* two distinct build ID strings, `deriveSessionId` SHALL produce different outputs with overwhelming probability (collision probability < 2^-64).

**Validates: Requirements 1.2, 3.5**

### Property 2: Malformed tool-use input normalization

*For any* tool-use block input value (including primitives, arrays, null, strings, and objects with a `type` field), the normalization function SHALL produce a valid JSON object (non-null, non-array, no `type` key), and the session SHALL continue without throwing.

**Validates: Requirements 1.5**

### Property 3: Webhook accepts all valid trigger payloads

*For any* trigger payload containing all required fields (issue.number, module.repository, module.path, module.ref, auth.githubInstallationToken) with valid types, the Webhook Lambda SHALL call StartBuild and return HTTP 202 with a buildId.

**Validates: Requirements 3.1**

### Property 4: Webhook rejects all invalid trigger payloads

*For any* payload missing at least one required field or containing a required field with an invalid type, the Webhook Lambda SHALL return HTTP 400 with a descriptive error message naming the missing/invalid field(s).

**Validates: Requirements 3.2, 3.3**

### Property 5: Trigger payload serialization round-trip

*For any* valid TriggerPayload object, encoding it as JSON into the `TRIGGER_PAYLOAD` environment variable and then decoding it back SHALL produce an object deeply equal to the original.

**Validates: Requirements 3.4**

### Property 6: Feature branch name derivation

*For any* session ID string, the derived feature branch name SHALL always equal `agent-harness/{sessionId}` and SHALL be a valid git branch name (no spaces, no `..`, no control characters).

**Validates: Requirements 4.2**

### Property 7: Early termination preserves partial edits

*For any* bounded loop execution that terminates early (kill switch, iteration cap, wall-clock cap, token cap, oscillation), if edits were made during the session, the orchestrator SHALL invoke git commit and git push before opening a PR, and the pushed branch SHALL contain all module_writeFile changes from the session.

**Validates: Requirements 4.6**

### Property 8: Unregistered tool rejection

*For any* tool name string not in the set {`module_readFile`, `module_writeFile`, `module_listFiles`}, the ToolExecutor SHALL return a toolResult with status `"error"` and content containing `"Tool not registered: {toolName}"`.

**Validates: Requirements 5.3**

### Property 9: Module file read/write round-trip

*For any* valid relative file path (no `..` segments, no absolute prefix) and *for any* UTF-8 string content, calling `module_writeFile(path, content)` followed by `module_readFile(path)` SHALL return content identical to what was written.

**Validates: Requirements 5.5, 5.6**

### Property 10: Module listFiles returns only matching paths

*For any* set of files present under the module root and *for any* glob pattern, `module_listFiles(pattern)` SHALL return only paths that match the glob pattern, all paths SHALL be relative to the module root, and no path outside the module root SHALL appear in the result.

**Validates: Requirements 5.7**

### Property 11: Sensor output parsing produces structured findings

*For any* non-zero exit code sensor output string (from tsc, eslint, jest, or cdk-nag), the sensor parser SHALL produce a structured findings array where each finding has at minimum a `message` field, and the array length SHALL be ≥ 1 for any non-empty error output.

**Validates: Requirements 6.3**

### Property 12: CDK deploy output parsing extracts stack outputs

*For any* valid CDK deploy JSON output containing a `Stacks` array with `Outputs` entries (each having `OutputKey` and `OutputValue`), the parser SHALL produce a record where every OutputKey maps to its OutputValue, and no key-value pair from the CDK output SHALL be missing.

**Validates: Requirements 7.2**

### Property 13: PR body completeness

*For any* session record (with iterations, sensor results, reviewer findings, and optional termination reason), the generated PR body string SHALL contain: the session ID, iteration count, and module path. For partial PRs, it SHALL additionally contain the termination reason. For success PRs, it SHALL contain sensor pass/fail summary.

**Validates: Requirements 9.2, 9.3**

## Error Handling

### Error Categories and Recovery

| Error | Source | Recovery Strategy |
|-------|--------|-------------------|
| InvokeHarness timeout/throttle | AgentCore | Propagate to loop; stop-condition evaluates; partial PR on cap |
| InvokeHarness access denied | IAM misconfiguration | Fail fast; non-zero exit; CloudWatch log |
| Git clone failure | Network/auth | Fail fast; non-zero exit; no PR (nothing to push) |
| Git push conflict | Remote diverged | Log error; terminate with non-zero exit |
| Sensor timeout (>120s) | Hanging subprocess | Kill process; report timeout finding; continue loop |
| CDK deploy failure | CloudFormation error | Feed error to editor; continue loop |
| StartBuild failure | Webhook Lambda | Return HTTP 500 to caller |
| Malformed TRIGGER_PAYLOAD | Environment | Default to local mode with synthetic trigger |
| MaxTurnsExceeded | MultiTurnExecutor | Propagate; treated as iteration failure; loop continues |

### Exit Code Contract

| Exit Code | Meaning |
|-----------|---------|
| 0 | Loop terminated (success or partial); PR opened if applicable |
| 1 | Fatal error before or during loop (git failure, missing config, IAM denied) |

### Subprocess Error Handling

All subprocess invocations (sensors, cdk deploy, git) use the following pattern:

```typescript
async function execWithTimeout(
  cmd: string,
  args: string[],
  options: { cwd: string; timeout: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Uses child_process.execFile with signal-based timeout
  // On timeout: SIGTERM → wait 5s → SIGKILL
  // Returns structured result regardless of exit code
  // Throws only on spawn failure (ENOENT, EACCES)
}
```

## Testing Strategy

### Unit Tests (Jest)

- **Webhook Lambda**: Mock CodeBuild SDK; test validation logic, 202/400/500 paths
- **Session ID derivation**: Test determinism, uniqueness, format
- **Tool catalogue registration**: Verify exactly 3 tools registered with correct names
- **Input normalization**: Test various malformed inputs (primitives, arrays, objects with `type`)
- **PR body generation**: Test with various session shapes
- **Config loading**: Test parsing and defaults
- **Local mode detection**: Test env var combinations

### Property-Based Tests (fast-check)

The project already uses Jest with fast-check. Each property test runs minimum 100 iterations.

| Property | Test File | fast-check Generators |
|----------|-----------|----------------------|
| 1: Session ID | `app/codebuild/__tests__/session.prop.test.ts` | `fc.string()` for build IDs |
| 2: Input normalization | `app/codebuild/__tests__/normalization.prop.test.ts` | `fc.anything()` for malformed inputs |
| 3: Webhook valid | `app/webhook/__tests__/handler.prop.test.ts` | Custom `triggerPayloadArbitrary` |
| 4: Webhook invalid | `app/webhook/__tests__/handler.prop.test.ts` | `triggerPayloadArbitrary` with field removals |
| 5: Payload round-trip | `app/webhook/__tests__/handler.prop.test.ts` | Custom `triggerPayloadArbitrary` |
| 6: Branch name | `app/codebuild/__tests__/git.prop.test.ts` | `fc.string()` for session IDs |
| 8: Unregistered tool | `app/codebuild/__tests__/tool-catalogue.prop.test.ts` | `fc.string().filter(s => !registeredTools.has(s))` |
| 9: File round-trip | `app/codebuild/__tests__/module-tools.prop.test.ts` | `fc.string()` for paths + content |
| 10: listFiles glob | `app/codebuild/__tests__/module-tools.prop.test.ts` | Custom file tree + glob arbitraries |
| 11: Sensor parsing | `app/codebuild/__tests__/sensors.prop.test.ts` | `fc.string()` for error outputs |
| 12: CDK output parsing | `app/codebuild/__tests__/deploy.prop.test.ts` | Custom CDK output arbitrary |
| 13: PR body | `app/codebuild/__tests__/pr-body.prop.test.ts` | Custom session record arbitrary |

### Integration Tests

- **Validation spike**: Real CodeBuild build invoking InvokeHarness in local mode
- **Git workflow**: Test repo with clone → branch → edit → commit → push → verify
- **Full pipeline**: GitHub issue → webhook → CodeBuild → PR (manual verification)

### CDK Assertion Tests

- Snapshot tests for synthesized CloudFormation
- Fine-grained assertions for IAM policies, environment variables, buildspec content
- Timeout configuration validation (default 60, max 480)

### Migration Path

1. **Wave 0 (Validation Spike)**: Deploy CodeBuild project, run local-mode build proving InvokeHarness works
2. **Wave 1 (Core Loop)**: Wire `runLoop` with CodeBuild gates, run full loop in local mode
3. **Wave 2 (Real PR)**: Add git workflow, deploy webhook Lambda, end-to-end test with real PR
4. **Wave 3 (Cleanup)**: Remove Lambda orchestrator stack, update documentation, deprecate old workflow

Each wave is independently deployable and verifiable. The Lambda orchestrator remains functional until Wave 3 confirms the CodeBuild path is stable.
