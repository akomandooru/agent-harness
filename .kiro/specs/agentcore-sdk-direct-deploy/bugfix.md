# Bugfix Requirements Document

## Introduction

The `agentcore-e2e-smoke` spec produced a deploy step that depends on the `@aws/agentcore@preview` CLI consuming three hand-written config files: `app/editor/harness.json`, `app/reviewer/harness.json`, and `agentcore/agentcore.json`. The CLI does not accept files in that shape. It is a project scaffolder plus CDK-backed deployer that expects to drive its own scaffolded layout via `agentcore create`, `agentcore add harness`, and `agentcore deploy`. Even if the project layout were regenerated through the CLI, the `agentcore add tool` command does not expose a way to register `inline_function` tools with custom JSON Schema input definitions, which the editor and reviewer harnesses both require.

The underlying `bedrock-agentcore-control:CreateHarness` API does fully support custom inline function tools with arbitrary JSON Schema. A direct SDK call has been confirmed to work end-to-end via `scripts/test-create-harness.ts`. The fix replaces the CLI-based deploy with a TypeScript script that calls `CreateHarness` directly for the editor and reviewer harnesses, reading model, system prompt, and tool definitions from the existing engineering harness layer.

The IAM stack also needs the harness execution roles to trust `bedrock-agentcore.amazonaws.com` for `CreateHarness` to succeed. That trust policy update has already been implemented as a `CompositePrincipal` that retains `bedrock.amazonaws.com` for compatibility, and the spec records this as part of the fix so that snapshot tests assert it.

## Bug Analysis

### Current Behavior (Defect)

When a developer or CI runs the AgentCore deploy step from `scripts/setup.sh` / `scripts/setup.ps1` (Step 4b) against the current repository, the deploy fails because the `agentcore` CLI does not understand the hand-written config files, and even a regenerated layout cannot express the tool schemas the harnesses require.

1.1 WHEN the setup script invokes `agentcore deploy` against the existing `agentcore/agentcore.json` THEN the system fails because the CLI does not consume hand-written `agentcore.json` referencing external `harness.json` files.

1.2 WHEN `agentcore validate` is run against `agentcore/agentcore.json` and `agentcore/aws-targets.json` THEN the system rejects the files as not matching any schema the CLI accepts.

1.3 WHEN a developer attempts to register the editor's 15 inline function tools or the reviewer's 3 inline function tools through `agentcore add tool --type inline_function` THEN the system provides no mechanism to attach a custom JSON Schema input definition to the tool, so the harness cannot be expressed through the CLI at all.

1.4 WHEN `bedrock-agentcore-control:CreateHarness` is called with an `executionRoleArn` whose trust policy only includes `bedrock.amazonaws.com` THEN the system rejects the call because the AgentCore control plane assumes the role under the `bedrock-agentcore.amazonaws.com` service principal.

1.5 WHEN the orchestrator stack deploy step in the setup script needs the editor and reviewer harness ARNs THEN the system prompts the operator to paste them manually because the failed `agentcore deploy` step never produced them.

1.6 WHEN `docs/quickstart.md`, `README.md`, and `post-draft.md` describe the deploy mechanism THEN the system documents a flow that does not work, listing the `agentcore` CLI as a prerequisite and referring to `harness.json` as the source of harness configuration.

### Expected Behavior (Correct)

After the fix, the deploy step uses a TypeScript script that calls `CreateHarness` directly through the SDK, reads configuration from sources that already exist in the repository, and writes the resulting ARNs to a file the orchestrator stack deploy can consume.

2.1 WHEN the setup script reaches Step 4b THEN the system SHALL invoke `npx ts-node scripts/deploy-harnesses.ts` instead of `agentcore deploy`, and that script SHALL call `bedrock-agentcore-control:CreateHarness` once for the editor harness and once for the reviewer harness.

2.2 WHEN `scripts/deploy-harnesses.ts` builds each `CreateHarnessRequest` THEN the system SHALL read the model id from `agent-harness.config.json` (`models.editor`, `models.reviewer`), the system prompt from `agents/editor/system.md` and `agents/reviewer/system.md` with frontmatter stripped, and the limits (`maxIterations`, `maxTokens`, `timeoutSeconds`) from `agent-harness.config.json` (`limits.iterationCap`, `limits.tokenSpendCapUSD`, `limits.wallClockCapMinutes`).

2.3 WHEN `scripts/deploy-harnesses.ts` builds the `tools` array for the editor harness THEN the system SHALL emit 15 `inline_function` tool entries whose names match `EDITOR_TOOL_NAMES` in `agents/editor/agent.ts` and whose `inputSchema` values are JSON Schema converted from the Zod schemas in `agents/editor/tools/*.ts`.

2.4 WHEN `scripts/deploy-harnesses.ts` builds the `tools` array for the reviewer harness THEN the system SHALL emit 3 `inline_function` tool entries whose names match `REVIEWER_TOOL_NAMES` in `agents/reviewer/tools.ts` and whose `inputSchema` values are JSON Schema converted from the Zod schemas in `agents/reviewer/tools.ts`.

2.5 WHEN `bedrock-agentcore-control:CreateHarness` is called by the script THEN the system SHALL pass an `executionRoleArn` whose IAM trust policy is a `CompositePrincipal` of `bedrock.amazonaws.com` and `bedrock-agentcore.amazonaws.com`, so the AgentCore control plane can assume the role.

2.6 WHEN each `CreateHarness` call succeeds THEN the system SHALL poll `GetHarness` until the harness status transitions from `CREATING` to `READY` before exiting, and SHALL write both ARNs to `.deployed-harnesses.json` for the orchestrator stack deploy to read.

2.7 WHEN the script is run a second time and a harness with the target name already exists THEN the system SHALL skip creation and reuse the existing ARN, unless the operator passes `--force-recreate`, in which case the system SHALL call `DeleteHarness` (using `harnessId`, not the ARN) and then `CreateHarness` again.

2.8 WHEN the orchestrator stack deploy step runs THEN the system SHALL read the editor and reviewer harness ARNs from `.deployed-harnesses.json` instead of prompting the operator.

2.9 WHEN the obsolete files are no longer needed THEN the system SHALL remove `app/editor/harness.json`, `app/reviewer/harness.json`, `agentcore/agentcore.json`, and `agentcore/aws-targets.json`, and SHALL clean up the `app/editor/`, `app/reviewer/`, and `agentcore/` directories if they become empty.

2.10 WHEN documentation describes the deploy mechanism THEN `docs/quickstart.md` SHALL describe Step 4b in terms of the new TypeScript script, SHALL drop the `agentcore` CLI from the prerequisites, and SHALL note that `.deployed-harnesses.json` is gitignored; `README.md` SHALL remove references to `app/editor/harness.json`, `app/reviewer/harness.json`, and `agentcore/`, and SHALL reference `scripts/deploy-harnesses.ts`; `post-draft.md` Section 4 SHALL describe the editor as declared via the `bedrock-agentcore-control:CreateHarness` API call from `scripts/deploy-harnesses.ts`, which reads model, system prompt, and tool definitions from the engineering harness layer.

2.11 WHEN the repository's ignore list is consulted THEN the system SHALL list `.deployed-harnesses.json` in `.gitignore`.

### Unchanged Behavior (Regression Prevention)

The architectural framing and runtime behavior of the harnesses are unchanged. Only the deploy mechanism changes. Code paths that already use `InvokeHarness` correctly stay as they are, and the conceptual two-layer split (runtime harness vs engineering harness) in the post draft remains accurate.

3.1 WHEN the orchestrator Lambda invokes the editor or reviewer harness THEN the system SHALL CONTINUE TO call `InvokeHarness` unchanged through `ManagedHarnessEditorInvocation` and `ManagedHarnessReviewerInvocation`.

3.2 WHEN the editor `runLoop` advances through iterations THEN the system SHALL CONTINUE TO enforce the iteration cap, oscillation detection, and bounded loop semantics with no behavioral change.

3.3 WHEN the dispatch workflow, smoke test, or post-deploy harness runs THEN the system SHALL CONTINUE TO behave as before; this fix does not touch those modules.

3.4 WHEN the reference fanout module is built or deployed THEN the system SHALL CONTINUE TO behave as before; this fix does not touch the module.

3.5 WHEN the post draft argues for the runtime/engineering split, the bounded loop, or the sensors-beat-prompts framing THEN the system SHALL CONTINUE TO present that framing; only the description of the deploy mechanism in Section 4 changes.

3.6 WHEN the editor or reviewer execution role is assumed by `bedrock.amazonaws.com` (for example for direct Bedrock model invocation paths that already exist) THEN the system SHALL CONTINUE TO trust that principal; the fix uses a `CompositePrincipal` that adds `bedrock-agentcore.amazonaws.com` without removing `bedrock.amazonaws.com`.

3.7 WHEN the editor and reviewer agent code references tool names and schemas THEN the system SHALL CONTINUE TO source them from `agents/editor/tools/*.ts` and `agents/reviewer/tools.ts`; the deploy script is a consumer of those files, not a parallel definition.

## Bug Condition and Properties

### Bug Condition

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type DeployAttempt
  OUTPUT: boolean

  // The bug fires whenever a deploy attempt routes through the agentcore CLI
  // against the hand-written config files in their original shape.
  RETURN X.deployTool = "agentcore CLI"
     AND X.configFiles INCLUDES one of {
           "agentcore/agentcore.json",
           "agentcore/aws-targets.json",
           "app/editor/harness.json",
           "app/reviewer/harness.json"
         }
END FUNCTION
```

### Fix Checking Property

```pascal
// Property: Fix Checking - Direct SDK deploy succeeds where CLI deploy fails
FOR ALL X WHERE isBugCondition(X) DO
  // X is replaced by X' that uses the new script against the same logical inputs:
  //   - model ids from agent-harness.config.json
  //   - system prompts from agents/<role>/system.md
  //   - tool schemas from agents/<role>/tools/*.ts (or agents/reviewer/tools.ts)
  //   - execution role with CompositePrincipal trust
  result ← deployHarnesses'(X')
  ASSERT result.editorHarness.status   = "READY"
     AND result.reviewerHarness.status = "READY"
     AND result.editorHarness.arn   matches "arn:aws:bedrock-agentcore:.*:harness/.*"
     AND result.reviewerHarness.arn matches "arn:aws:bedrock-agentcore:.*:harness/.*"
     AND fileExists(".deployed-harnesses.json")
     AND no_obsolete_files_remain({
           "app/editor/harness.json",
           "app/reviewer/harness.json",
           "agentcore/agentcore.json",
           "agentcore/aws-targets.json"
         })
END FOR
```

### Preservation Checking Property

```pascal
// Property: Preservation Checking - Runtime behavior is unchanged
FOR ALL X WHERE NOT isBugCondition(X) DO
  // Non-buggy inputs are runtime invocations and unrelated subsystems.
  ASSERT F(X) = F'(X)
  // Concretely:
  //   - InvokeHarness paths through ManagedHarness*Invocation: unchanged
  //   - runLoop iteration cap, oscillation detection: unchanged
  //   - dispatch workflow, smoke test, post-deploy harness: unchanged
  //   - reference fanout module: unchanged
  //   - post draft conceptual framing (Sections other than 4's deploy mechanism): unchanged
END FOR
```
