# agentcore-sdk-direct-deploy Bugfix Design

## Overview

The current Step 4b of the setup scripts (`scripts/setup.sh`, `scripts/setup.ps1`) calls the `@aws/agentcore@preview` CLI's `agentcore deploy` command against three hand-written config files (`agentcore/agentcore.json`, `app/editor/harness.json`, `app/reviewer/harness.json`). The CLI does not consume files in that shape, and even a CLI-regenerated layout cannot register `inline_function` tools with custom JSON Schema — which both harnesses require (15 tools for the editor, 3 for the reviewer). The same operation succeeds when invoked directly through the `bedrock-agentcore-control:CreateHarness` API; this has already been confirmed end-to-end by `scripts/test-create-harness.ts`.

The fix replaces the CLI step with a small TypeScript script (`scripts/deploy-harnesses.ts`) that drives `CreateHarness` directly. The script reads the model id from `agent-harness.config.json`, the system prompts from the existing `agents/<role>/system.md` files (with frontmatter stripped using the same parser the agent code already uses), and the tool definitions — including the `inputSchema` JSON Schema — straight from the existing `ToolDefinition` exports in `agents/editor/tools/*.ts` and `agents/reviewer/tools.ts`. The script polls `GetHarness` until each harness reaches `READY`, writes both ARNs to `.deployed-harnesses.json`, and the modified Step 4b reads that file instead of prompting the operator.

The fix is deliberately a single-seam change: it swaps one deploy mechanism for another. The runtime invocation path (`InvokeHarness` via `ManagedHarnessEditorInvocation` / `ManagedHarnessReviewerInvocation`), the editor `runLoop`, the dispatch workflow, the smoke test, the post-deploy harness, and the reference fanout module all stay unchanged. The IAM trust policy update that `CreateHarness` requires (`bedrock-agentcore.amazonaws.com` added as a `CompositePrincipal` alongside `bedrock.amazonaws.com`) is already in `infrastructure/iam-stack.ts`; the design references and verifies it rather than re-implementing it. The conceptual two-layer framing in `post-draft.md` stays intact — only the one paragraph in Section 4 that describes the deploy mechanism is rewritten.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug — a deploy attempt routed through the `agentcore` CLI against the hand-written config files (`agentcore/agentcore.json`, `agentcore/aws-targets.json`, `app/editor/harness.json`, `app/reviewer/harness.json`) in their original shape.
- **Property (P)**: The desired behavior under C — direct SDK calls to `bedrock-agentcore-control:CreateHarness` succeed for both the editor and reviewer harnesses, both reach status `READY`, both ARNs are written to `.deployed-harnesses.json`, and the obsolete files are removed.
- **Preservation**: All non-deploy behavior — `InvokeHarness` paths, `runLoop` semantics, dispatch workflow, smoke test, post-deploy harness, reference fanout module, and the conceptual framing in `post-draft.md` outside Section 4's deploy mechanism paragraph — must remain unchanged.
- **`scripts/deploy-harnesses.ts`**: The new TypeScript script (in the existing `scripts/` directory) that calls `CreateHarness` once per harness and writes the resulting ARNs to `.deployed-harnesses.json`.
- **`scripts/test-create-harness.ts`**: The existing reference script that has already proven the SDK-direct path works end-to-end. The new `deploy-harnesses.ts` follows its shape.
- **`.deployed-harnesses.json`**: The new output artifact written by `deploy-harnesses.ts` and consumed by Step 4b's orchestrator-stack deploy. Contains the editor and reviewer harness ARNs and ids. Listed in `.gitignore`.
- **`CreateHarnessRequest`**: The SDK type for `bedrock-agentcore-control:CreateHarness`. Field shape verified in `node_modules/@aws-sdk/client-bedrock-agentcore-control/dist-types/models/models_0.d.ts` (see the inline citation in `scripts/test-create-harness.ts`).
- **`EDITOR_TOOL_NAMES`**: The frozen 15-element array exported from `agents/editor/agent.ts` listing the editor's tool names in catalogue order. The deploy script's tool array MUST contain exactly these names in any order.
- **`REVIEWER_TOOL_NAMES`**: The frozen 3-name set exported from `agents/reviewer/tools.ts`. Same role for the reviewer.
- **`ToolDefinition.inputSchema`**: The JSON Schema literal authored on each tool's exported `ToolDefinition` (e.g. `readFileTool.inputSchema` in `agents/editor/tools/module.ts`). The deploy script reads this directly; there is no conversion step.
- **`CompositePrincipal` trust**: The trust-policy shape on `agent-harness-editor` and `agent-harness-reviewer` IAM roles that allows both `bedrock.amazonaws.com` and `bedrock-agentcore.amazonaws.com` to assume the role. Already implemented in `infrastructure/iam-stack.ts` lines 99–103 (editor) and 286–290 (reviewer).
- **`harnessId` vs ARN**: `DeleteHarness` takes the bare `harnessId` (e.g. `abc123`), not the full ARN. `CreateHarness` returns both via `result.harness.harnessId` and `result.harness.arn`. The script stores both in `.deployed-harnesses.json` so the recreate path can call `DeleteHarness` without re-parsing the ARN.

## Bug Details

### Bug Condition

The bug manifests whenever the setup pipeline routes a deploy attempt through the `agentcore` CLI against the hand-written config files in the repository's current shape. The CLI is a project scaffolder plus CDK-backed deployer that expects to drive its own scaffolded layout; it does not consume `agentcore/agentcore.json` referencing external `harness.json` files, and `agentcore add tool --type inline_function` exposes no way to attach a custom JSON Schema input definition. The harnesses cannot be expressed through the CLI at all.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type DeployAttempt
  OUTPUT: boolean

  // The bug fires whenever a deploy attempt routes through the agentcore
  // CLI against the hand-written config files in their original shape.
  RETURN input.deployTool = "agentcore CLI"
     AND input.configFiles INCLUDES one of {
           "agentcore/agentcore.json",
           "agentcore/aws-targets.json",
           "app/editor/harness.json",
           "app/reviewer/harness.json"
         }
END FUNCTION
```

### Examples

- **Concrete example 1 — `agentcore deploy` from setup.sh Step 4b.** The bash script runs `agentcore deploy` from the repo root (line 204 of `scripts/setup.sh`). The CLI rejects `agentcore/agentcore.json` because the shape does not match any layout the CLI scaffolds. **Expected:** both harnesses reach `READY`, two ARNs printed. **Actual:** CLI exits non-zero (or exits zero with a `DeployError` line in stdout that the script greps for) and the script aborts.
- **Concrete example 2 — `agentcore validate` against the hand-written configs.** A developer attempts to validate the existing files before deploying. **Expected:** the validator accepts the files. **Actual:** the validator rejects them as not matching any schema the CLI accepts.
- **Concrete example 3 — registering an `inline_function` tool with a JSON Schema.** A developer attempts to register `module.readFile` (with its `{path: string}` input schema) via `agentcore add tool --type inline_function`. **Expected:** the CLI provides a flag or interactive path to attach a JSON Schema. **Actual:** no such mechanism exists; the 15 editor tools and 3 reviewer tools cannot be registered.
- **Concrete example 4 — `CreateHarness` against an editor role with only `bedrock.amazonaws.com` trust.** Even when the SDK path is taken directly, an execution role whose trust policy lists only `bedrock.amazonaws.com` is rejected. **Expected:** the AgentCore control plane assumes the role under `bedrock-agentcore.amazonaws.com` and `CreateHarness` succeeds. **Actual (pre-fix IAM):** access denied. (This is the IAM half of the bug; already addressed in `infrastructure/iam-stack.ts` via `CompositePrincipal`.)
- **Edge case — orchestrator-stack Step 4b operator prompt.** With the deploy step broken, the script falls back to prompting the operator to paste two ARNs that were never produced. **Expected behavior after fix:** the orchestrator-stack step reads `.deployed-harnesses.json` and never prompts.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- `InvokeHarness` runtime path through `ManagedHarnessEditorInvocation` and `ManagedHarnessReviewerInvocation` continues to call the deployed harnesses with the existing payload shape and outcome contract.
- The editor `runLoop` continues to enforce iteration cap, oscillation detection, and bounded loop semantics with no behavioral change.
- The dispatch workflow (`.github/workflows/dispatch-agent-task.yml`), the smoke test (`scripts/smoke-test.ts`), and the post-deploy harness module continue to behave as before; the fix does not touch those modules.
- The reference fanout module under `modules/fanout/` continues to build and deploy as before; the fix does not touch the module.
- The conceptual two-layer split in `post-draft.md` (runtime harness vs. engineering harness, the bounded-loop argument, the sensors-beat-prompts framing, the prerequisites for extending past the PR boundary, the stop-conditions list) remains byte-identical outside the single deploy-mechanism paragraph in Section 4 named in 2.10.
- The editor and reviewer execution roles continue to trust `bedrock.amazonaws.com` for any direct Bedrock-side assumptions; the `CompositePrincipal` adds `bedrock-agentcore.amazonaws.com` without removing the existing principal.
- The agent source-of-truth files (`agents/editor/agent.ts`, `agents/editor/tools/*.ts`, `agents/reviewer/agent.ts`, `agents/reviewer/tools.ts`) remain the canonical declaration of tool names and schemas. The new deploy script imports from them; it does not declare a parallel set.

**Scope:**
All inputs that do NOT match `isBugCondition` should be completely unaffected by this fix. Concretely, this includes:
- Runtime invocations of either harness (`InvokeHarness`).
- Any test in `agents/editor/__tests__/`, `agents/reviewer/__tests__/`, or `agents/shared/__tests__/`.
- The orchestrator Lambda's `runLoop`, dispatch handler, and smoke test.
- The reference fanout module's CDK app, tests, and CI checks.
- Direct Bedrock model invocation paths that already exist and assume the editor/reviewer roles via `bedrock.amazonaws.com`.

## Hypothesized Root Cause

Based on the bug analysis in `bugfix.md` and direct inspection of the `agentcore` CLI surface and the `bedrock-agentcore-control` SDK, the root cause is two-fold:

1. **CLI vs. hand-written config shape mismatch.** The `agentcore` CLI (`@aws/agentcore@preview`) is a project scaffolder, not a thin SDK passthrough. It expects to own its own layout via `agentcore create` / `agentcore add harness` / `agentcore add tool`. The hand-written `agentcore/agentcore.json` referencing external `app/<role>/harness.json` files is not a layout the CLI scaffolds, and `agentcore validate` rejects it accordingly. **Evidence:** the deploy step in `scripts/setup.sh` lines 204–215 already greps the CLI's output for `DeployError|Error:` because the CLI sometimes exits zero on rejection — the failure mode has been observed in practice.

2. **`agentcore add tool --type inline_function` does not expose JSON Schema attachment.** Even if the layout were regenerated through `agentcore create`, the CLI's `add tool` subcommand for `inline_function` tools provides no flag, no interactive prompt, and no file-reference syntax for attaching a custom JSON Schema input definition. The editor harness's 15 tools and the reviewer harness's 3 tools all rely on `inline_function` with custom JSON Schema (e.g. `module.readFile`'s `{path: string}` input, `cdk.deploy`'s empty input with structured output, `reference.checklist`'s `{pillar: string}` input with an enumerated severity field in its output). **Evidence:** `scripts/test-create-harness.ts` registered exactly such a tool by calling `CreateHarness` directly with a JSON Schema in `tools[0].config.inlineFunction.inputSchema` and the call succeeded. The same payload through the CLI has no expression.

The IAM half of the original failure mode (`CreateHarness` rejected when the execution role's trust policy listed only `bedrock.amazonaws.com`) was a third contributing factor and is already addressed: `infrastructure/iam-stack.ts` declares both the editor and reviewer roles with a `CompositePrincipal` that adds `bedrock-agentcore.amazonaws.com` while retaining `bedrock.amazonaws.com` for compatibility (lines 99–103 and 286–290). The design references that change rather than re-applying it; the testing strategy below verifies it remains in place.

The fix follows directly: stop calling the CLI; call `CreateHarness` directly with the same payload that `test-create-harness.ts` already proved works.

## Correctness Properties

Property 1: Bug Condition - Direct SDK Deploy Succeeds Where CLI Deploy Fails

_For any_ deploy attempt where `isBugCondition` returns true (i.e., the original input shape — model from `agent-harness.config.json`, system prompts from `agents/<role>/system.md`, tool definitions from `agents/editor/tools/*.ts` and `agents/reviewer/tools.ts`, execution role with `CompositePrincipal` trust), the fixed pipeline SHALL call `bedrock-agentcore-control:CreateHarness` once for the editor harness and once for the reviewer harness, SHALL poll `GetHarness` until both harnesses reach status `READY`, SHALL produce two ARNs matching `arn:aws:bedrock-agentcore:.*:harness/.*`, SHALL write both ARNs (with their `harnessId` values) to `.deployed-harnesses.json`, SHALL skip creation and reuse the existing ARN on a second run unless `--force-recreate` is passed, SHALL call `DeleteHarness` (with `harnessId`) followed by `CreateHarness` when `--force-recreate` is passed, and SHALL leave no obsolete files (`app/editor/harness.json`, `app/reviewer/harness.json`, `agentcore/agentcore.json`, `agentcore/aws-targets.json`) on disk after the fix is applied.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11**

Property 2: Preservation - Runtime Behavior and Conceptual Framing Unchanged

_For any_ input where `isBugCondition` returns false (i.e., runtime invocations and unrelated subsystems), the fixed code SHALL produce the same observable result as the original code. Concretely: (a) `InvokeHarness` paths through `ManagedHarnessEditorInvocation` and `ManagedHarnessReviewerInvocation` are byte-identical at the call site; (b) the editor `runLoop` retains its iteration cap, oscillation detection, and bounded-loop semantics with no behavioral change; (c) the dispatch workflow, smoke test, and post-deploy harness modules are untouched; (d) the reference fanout module is untouched; (e) `post-draft.md` outside the single deploy-mechanism paragraph in Section 4 (and the matching reference at line 266) is byte-identical to the pre-fix version; (f) the `agent-harness-editor` and `agent-harness-reviewer` IAM roles continue to list `bedrock.amazonaws.com` in their assume-role policy as part of the `CompositePrincipal`; and (g) the editor and reviewer agent code remains the single source of truth for tool names and schemas — `scripts/deploy-harnesses.ts` imports `EDITOR_TOOL_NAMES`, `REVIEWER_TOOL_NAMES`, and the per-tool `ToolDefinition` exports rather than declaring a parallel set.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**



## Fix Implementation

### Changes Required

The fix is a single-seam swap: replace the CLI deploy call with a TypeScript script, plumb the resulting ARNs through the rest of Step 4b, delete the obsolete config files, and update the docs that referenced the old shape. The IAM trust-policy half of the fix is already in `infrastructure/iam-stack.ts` and is referenced (and verified) rather than re-applied.

#### File: `scripts/deploy-harnesses.ts` (NEW)

The new script. Modelled directly on `scripts/test-create-harness.ts` (which has already proved the SDK path works end-to-end) and importing from the existing agent code so tool names and schemas have one source of truth.

**Specific Changes:**

1. **CLI argument parsing.** Accept the same flags `test-create-harness.ts` accepts (`--account-id`, `--region`, `--execution-role`) plus two more:
   - `--reviewer-execution-role <arn>` — optional; defaults to deriving the reviewer role ARN from `--execution-role` by replacing the trailing `agent-harness-editor` segment with `agent-harness-reviewer`. (The two roles share an account and region by construction; see `infrastructure/iam-stack.ts`.)
   - `--force-recreate` — boolean flag. When present, any existing harness with a matching name is deleted via `DeleteHarness({ harnessId })` before `CreateHarness` is called. When absent, an existing harness with the matching name is reused and its ARN is written through to `.deployed-harnesses.json` unchanged. (Requirement 2.7.)
   - The script MUST exit non-zero with a clear usage message if any required flag is missing, mirroring `test-create-harness.ts`.

2. **Config and prompt loading.** Load the editor's model from `models.editor` and the reviewer's model from `models.reviewer` in `agent-harness.config.json` (path: repo root, located via `path.resolve(__dirname, "..", "agent-harness.config.json")`). Load the system prompts from `agents/editor/system.md` and `agents/reviewer/system.md`. Frontmatter MUST be stripped using the same parser shape the agent code already implements — specifically, reuse `parseEditorSystemPromptFrontmatter` from `agents/editor/agent.ts` (and the equivalent reviewer-side parser) by importing them; do not duplicate the parser. The script passes only the `body` field of the parsed result as the system prompt text. (Requirement 2.2.)

3. **Tool array assembly.** Import `EDITOR_TOOL_NAMES` from `agents/editor/agent.ts` and `reviewerToolCatalogue` (plus `REVIEWER_TOOL_NAMES`) from `agents/reviewer/tools.ts`. For the editor, build the tool array by importing each tool's `ToolDefinition` directly from `agents/editor/tools/*.ts` (`readFileTool`, `writeFileTool`, `listFilesTool`, `diffTool` from `module.ts`; `cdkDiffTool`, `deployTool` from `cdk.ts`; the four `sensor.*` tools from `sensors.ts`; `cwLogsTool`, `cwMetricsTool` from `preview.ts`; `prOpenTool` from `pr.ts`; `postDeployTool` from `post-deploy.ts`; `reviewerInvokeTool` from `agents/reviewer/agent.ts` for the reviewer-as-tool entry). For each `ToolDefinition`, emit a `HarnessTool` entry of the shape proven in `test-create-harness.ts`:
   ```ts
   {
     type: "inline_function",
     name: tool.name.replace(/\./g, "_"),  // "module.readFile" → "module_readFile"
     config: {
       inlineFunction: {
         description: tool.description,
         inputSchema: tool.inputSchema,  // already a JSON Schema literal
       },
     },
   }
   ```
   The name-mangling step (`.` → `_`) matches `test-create-harness.ts` line 88 (`name: "module_readFile"`), reflecting AgentCore's tool-name constraint. The reviewer's three tools follow the same shape from `reviewerToolCatalogue`. **No Zod conversion is required**: every `ToolDefinition` in the codebase already authors `inputSchema` as a JSON Schema literal (verified by `grep -r "from \"zod\"" agents/` returning zero matches; the bugfix.md's mention of "JSON Schema converted from Zod" is corrected here to "read directly from each `ToolDefinition.inputSchema`"). Total: 15 tools for the editor, 3 for the reviewer. (Requirements 2.3, 2.4.)

4. **Limits mapping.** Map fields from `agent-harness.config.json` to the SDK's `CreateHarnessRequest` limit fields:
   - `limits.iterationCap` → `maxIterations`
   - `limits.tokenSpendCapUSD` → `maxTokens` (Note: the SDK's `maxTokens` is a token count, not a dollar amount. The script MUST convert by multiplying the dollar cap by a configured tokens-per-USD ratio. Until the live-fire run pins a real ratio, the script uses a conservative placeholder of 1,000,000 tokens per USD; this is documented inline in the script and matches the placeholder convention used in `agents/editor/tools/cdk.ts` `PROVISIONAL_DEPLOY_COST_USD`. A follow-up issue tracks pinning the ratio.)
   - `limits.wallClockCapMinutes` → `timeoutSeconds` (multiply by 60)
   The mapping function MUST be exported from the script for unit tests. (Requirement 2.2.)

5. **Existence check and idempotency.** Before each `CreateHarness` call, list existing harnesses (via `ListHarnesses` paginated) and look for one with a matching `harnessName`. If found and `--force-recreate` is not set, capture its ARN and `harnessId` and skip the `CreateHarness` call. If found and `--force-recreate` is set, call `DeleteHarness({ harnessId })`, wait for the delete to complete (poll `GetHarness` until it returns a not-found error), then proceed with `CreateHarness`. If not found, call `CreateHarness` directly. The script logs which path it took for each harness. (Requirement 2.7.)

6. **Polling.** After each `CreateHarness` call, poll `GetHarness({ harnessId })` every 5 seconds (mirroring the SDK's recommended interval) until `harness.status` transitions from `CREATING` to `READY`. The polling loop MUST have a hard timeout (default 10 minutes per harness) and MUST exit non-zero on either timeout or a terminal failure status (`FAILED`, `DELETING`, `DELETED`). The polling helper MUST be exported for unit tests. (Requirement 2.6.)

7. **Output artifact.** After both harnesses reach `READY`, write `.deployed-harnesses.json` at the repo root with the shape:
   ```json
   {
     "editor":   { "harnessId": "...", "arn": "arn:aws:bedrock-agentcore:..." },
     "reviewer": { "harnessId": "...", "arn": "arn:aws:bedrock-agentcore:..." }
   }
   ```
   The shape stores `harnessId` alongside the ARN so the recreate path does not need to re-parse the ARN. The file MUST be written atomically (write to `.deployed-harnesses.json.tmp` then rename) so a partial failure does not leave a half-formed file. (Requirements 2.6, 2.8.)

8. **Logging.** The script uses plain `console.log` / `console.error` to match `test-create-harness.ts`. Each step (`existence check`, `creating`, `polling status`, `READY`, `wrote artifact`) is logged with the harness name as a prefix so a failure mid-run is easy to localise.

#### File: `scripts/setup.sh` Step 4b (MODIFIED)

**Specific Changes:**

1. **Replace the `agentcore deploy` call (lines 199–215).** Replace the `pushd "$REPO_ROOT"` block that runs `agentcore deploy` and greps stdout for errors with a single invocation:
   ```bash
   npx ts-node scripts/deploy-harnesses.ts \
     --account-id "$ACCOUNT_ID" \
     --region "$REGION" \
     --execution-role "$EDITOR_EXECUTION_ROLE_ARN"
   ```
   The script's exit code is the source of truth; the post-hoc `grep -qE "DeployError|Error:|error:"` defensive check (lines 211–215) is removed because the SDK call returns a deterministic error rather than a TUI-formatted message.

2. **Replace the operator prompt (lines 218–228).** Replace the interactive `read -rp` block that prompts for `EDITOR_HARNESS_ARN` and `REVIEWER_HARNESS_ARN` with:
   ```bash
   EDITOR_HARNESS_ARN=$(jq -r '.editor.arn'   "$REPO_ROOT/.deployed-harnesses.json")
   REVIEWER_HARNESS_ARN=$(jq -r '.reviewer.arn' "$REPO_ROOT/.deployed-harnesses.json")
   ```
   followed by a guard that fails with a clear message if either ARN is empty. (Requirement 2.8.)

#### File: `scripts/setup.ps1` Step 4b (MODIFIED)

**Specific Changes:**

1. **Replace the `agentcore deploy` call (lines 234–250).** Replace the `Push-Location $RepoRoot` block with a single `npx ts-node scripts/deploy-harnesses.ts ...` invocation, using PowerShell's exit-code propagation rather than the `$deployOutput -match "DeployError|Error:|error:"` grep.

2. **Replace the operator prompt (lines 252–261).** Replace the `Read-Host` calls with `Get-Content $RepoRoot\.deployed-harnesses.json | ConvertFrom-Json` and read the `editor.arn` and `reviewer.arn` fields. Same empty-ARN guard as the bash script. (Requirement 2.8.)

#### File: `infrastructure/iam-stack.ts` (ALREADY MODIFIED — REFERENCE ONLY)

The trust-policy update is already applied. `EditorAgentRole` (lines 94–103) and `ReviewerAgentRole` (lines 282–290) both declare `assumedBy: new iam.CompositePrincipal(new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"), new iam.ServicePrincipal("bedrock.amazonaws.com"))`. This change is in scope of the bugfix because Requirement 2.5 calls for the trust policy that makes `CreateHarness` succeed; verifying it remains in place after the rest of the fix is part of the testing strategy. (Requirement 2.5.)

#### Files to Delete

The following four files become obsolete after the fix and MUST be removed (Requirement 2.9):
- `app/editor/harness.json`
- `app/reviewer/harness.json`
- `agentcore/agentcore.json`
- `agentcore/aws-targets.json`

The empty parent directories `app/editor/`, `app/reviewer/`, and `agentcore/` MUST also be removed if they become empty after the file deletions. **Edge case:** the `agentcore/.cli/logs/deploy/` directory contains historical CLI logs (`deploy-20260526-135157.log`, `deploy-20260526-135612.log`) and SHOULD be left in place — those are useful artefacts of the failed deploys and removing them is out of scope. The cleanup logic checks each parent directory for true emptiness via `fs.readdirSync(dir).length === 0` before removing it, so `agentcore/` will not be removed while `agentcore/.cli/` exists.

#### File: `.gitignore` (MODIFIED)

**Specific Changes:**

1. **Add `.deployed-harnesses.json` to the ignore list.** The file is per-developer / per-environment (it captures account-specific ARNs) and must not be committed. Place the entry near the top alongside `.setup-harness-arns.json` (the existing setup-script artefact entry):
   ```
   # Setup script temp files
   .setup-harness-arns.json
   .deployed-harnesses.json
   ```
   (Requirement 2.11.)

#### File: `docs/quickstart.md` (MODIFIED)

**Specific Changes:**

1. **Drop the `agentcore` CLI prerequisite.** Remove the `@aws/agentcore@preview` install line from the Prerequisites section.
2. **Rewrite Step 4b body (lines 136–196 of `docs/quickstart.md`).** Replace the description of `agentcore deploy` with a description of `npx ts-node scripts/deploy-harnesses.ts`, including the flag list, the `.deployed-harnesses.json` artefact, the idempotency contract, and the `--force-recreate` flag. Note that `.deployed-harnesses.json` is gitignored.
3. **Update the resume-from-step-4b note (line 91).** Replace the sentence about pausing for two harness ARNs with a sentence stating Step 4b runs unattended and writes `.deployed-harnesses.json`. (Requirement 2.10.)

#### File: `README.md` (MODIFIED)

**Specific Changes:**

1. **Remove references to `app/editor/harness.json`, `app/reviewer/harness.json`, and `agentcore/`.** Search-and-replace removes any path strings that point into those locations.
2. **Add a reference to `scripts/deploy-harnesses.ts`** in the section describing how the harnesses are deployed.
3. **Preserve the runtime/engineering split, the bounded-loop framing, the stop-conditions list, and the "Are you on AWS / CDK / AgentCore?" decision points.** Those sentences are unchanged. (Requirement 2.10.)

#### File: `post-draft.md` Section 4 (MODIFIED — DEPLOY MECHANISM PARAGRAPH ONLY)

**Specific Changes:**

1. **Replace the deploy-mechanism sentence at line 164.** The current text reads: *"In AgentCore Managed Harness terms, the editor is declared in a `harness.json` config file with a model (Claude Sonnet via Bedrock in the template's defaults), a system prompt that orients it to 'you maintain a CDK module,' and a tool catalogue."* Replace with: *"In AgentCore Managed Harness terms, the editor is declared via the `bedrock-agentcore-control:CreateHarness` API call from `scripts/deploy-harnesses.ts`, which reads the model id (Claude Sonnet via Bedrock in the template's defaults), the system prompt, and the tool definitions from the engineering harness layer (`agent-harness.config.json`, `agents/editor/system.md`, and the `ToolDefinition` exports in `agents/editor/tools/*.ts`)."*
2. **Update the matching reference at line 266** of the "What the template doesn't claim" list, which currently reads: *"The editor and reviewer agents are declared declaratively in `harness.json` config files and run inside AgentCore Managed Harness; the engineering-harness pieces would survive a swap to a different runtime harness with a day's adaptation."* Replace `harness.json` config files with `scripts/deploy-harnesses.ts` and the engineering harness layer.
3. **Leave every other paragraph in `post-draft.md` byte-identical.** The runtime/engineering split argument (Section 1), the bounded-loop argument (Section 2 and 3), the prerequisites for extending past the PR boundary (Section 3), the rest of Section 4, the self-audit (Section 5), and the closing notes (Section 6) all stay as written. The conceptual framing in Requirement 3.5 is preserved by this scoping. (Requirement 2.10.)

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on the unfixed pipeline (the `agentcore deploy` path), then verify that the fixed `scripts/deploy-harnesses.ts` produces `READY` harnesses with correct ARNs and that every preservation requirement is met. Because the bug fires against a real AWS API, the strategy combines mocked-SDK property-based tests for fast feedback with one end-to-end live-fire run to confirm the CreateHarness path actually completes.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm the root-cause analysis — the CLI cannot consume the hand-written configs, and `agentcore add tool` cannot register `inline_function` tools with custom JSON Schema. If either branch refutes, we re-hypothesize.

**Test Plan**: Reproduce the failure modes from `bugfix.md` Section 1 (Current Behavior, Defect) on the current `main` branch, before any code change in this fix lands. Capture exit codes, stdout/stderr, and CLI error messages. Confirm that `scripts/test-create-harness.ts` (the working reference) succeeds against the same account/region with the IAM trust update in place.

**Test Cases**:
1. **CLI rejects hand-written `agentcore.json`**: Run `agentcore deploy` from the repo root with the existing `agentcore/agentcore.json` and `app/<role>/harness.json` files in place. Capture the exit code and output. (Will fail on unfixed code — Requirement 1.1.)
2. **CLI rejects `agentcore validate`**: Run `agentcore validate agentcore/agentcore.json` and `agentcore validate agentcore/aws-targets.json`. Confirm both reject. (Will fail on unfixed code — Requirement 1.2.)
3. **CLI cannot register `inline_function` with JSON Schema**: Run `agentcore add tool --type inline_function --help` and inspect the flag list. Confirm no JSON-Schema-attachment flag exists. (Will fail on unfixed code — Requirement 1.3.)
4. **`CreateHarness` fails without `bedrock-agentcore.amazonaws.com` trust**: Temporarily revert `infrastructure/iam-stack.ts` lines 99–103 to `assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com")`, deploy the IAM stack, and run `scripts/test-create-harness.ts`. Confirm `CreateHarness` is rejected with an access-denied error. Restore the `CompositePrincipal`. (Will fail on unfixed IAM — Requirement 1.4.)
5. **Edge case — orchestrator step prompts operator**: Run `scripts/setup.sh --from-step 4b` against a fresh account where `agentcore deploy` has never succeeded. Confirm the script prompts for two ARNs that do not exist. (Will reach the prompt on unfixed code — Requirement 1.5.)
6. **Reference SDK path succeeds**: Run `scripts/test-create-harness.ts` against an account with the `CompositePrincipal` IAM trust in place. Confirm `CreateHarness` succeeds, `harnessArn` is returned, and `DeleteHarness` cleans up. (Confirms the fix path works end-to-end.)

**Expected Counterexamples**:
- `agentcore deploy` exits non-zero (or exits zero with a `DeployError` line) on every invocation against the current files.
- `agentcore validate` rejects both `agentcore.json` and `aws-targets.json`.
- The `agentcore add tool` help output has no JSON-Schema-attachment flag.
- `CreateHarness` against a `bedrock.amazonaws.com`-only role returns an access-denied error.
- Possible alternative causes ruled out by these tests: (a) network or credentials issues — refuted by `test-create-harness.ts` succeeding; (b) account-level service availability — refuted by the same; (c) tool-registration path other than `inline_function` — the hand-written configs already specify `inline_function`, so the bug is in the CLI's handling of that type, not in the type choice.

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed pipeline produces the expected behavior (Property 1).

**Pseudocode:**
```
FOR ALL X WHERE isBugCondition(X) DO
  // X' is the fixed pipeline running against the same logical inputs:
  //   - model ids from agent-harness.config.json
  //   - system prompts from agents/<role>/system.md
  //   - tool definitions from ToolDefinition exports
  //   - execution role with CompositePrincipal trust
  result := deployHarnesses_fixed(X')
  ASSERT result.editor.status   = "READY"
     AND result.reviewer.status = "READY"
     AND result.editor.arn   matches "arn:aws:bedrock-agentcore:.*:harness/.*"
     AND result.reviewer.arn matches "arn:aws:bedrock-agentcore:.*:harness/.*"
     AND fileExists(".deployed-harnesses.json")
     AND parseJson(".deployed-harnesses.json") has shape { editor: {harnessId, arn}, reviewer: {harnessId, arn} }
     AND no_obsolete_files_remain({
           "app/editor/harness.json",
           "app/reviewer/harness.json",
           "agentcore/agentcore.json",
           "agentcore/aws-targets.json"
         })
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed code produces the same observable result as the original code (Property 2).

**Pseudocode:**
```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT F(X) = F'(X)
  // Concretely:
  //   - InvokeHarness via ManagedHarness*Invocation: byte-identical call site
  //   - runLoop iteration cap, oscillation detection: unchanged
  //   - dispatch workflow, smoke test, post-deploy harness: unchanged
  //   - reference fanout module: unchanged
  //   - post-draft.md outside the deploy-mechanism paragraph and the line-266 reference: byte-identical
  //   - editor/reviewer IAM roles still trust bedrock.amazonaws.com via CompositePrincipal
  //   - tool names and schemas sourced from agents/editor/tools/*.ts and agents/reviewer/tools.ts
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain.
- It catches edge cases that manual unit tests might miss (e.g., a config-mutation property that perturbs `agent-harness.config.json` and asserts the existing parser behavior is unchanged).
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs — particularly for the `runLoop`, `InvokeHarness`, and dispatch paths, where small refactors could regress without an explicit guard.

**Test Plan**: Observe behavior on the unfixed code first for runtime invocations and unrelated subsystems (run the existing test suites and capture outputs), then write property-based tests capturing that behavior. Where existing tests already provide that coverage (`agents/editor/__tests__/`, `agents/reviewer/__tests__/`, `agents/shared/__tests__/`, the orchestrator `runLoop` tests, the smoke-test tests, the iam-stack snapshot test), assert they pass unmodified after the fix.

**Test Cases**:
1. **InvokeHarness path preservation**: Observe that `agents/editor/__tests__/managed-harness-invocation.test.ts` and the reviewer's equivalent pass on unfixed code, then assert they still pass after the fix without any modification to the test file. (Requirement 3.1.)
2. **runLoop semantics preservation**: Observe that the orchestrator `runLoop` test suite passes on unfixed code (iteration cap, oscillation detection, bounded-loop semantics), then assert it still passes after the fix. (Requirement 3.2.)
3. **Dispatch / smoke-test / post-deploy preservation**: Observe that the dispatch-workflow, smoke-test, and post-deploy harness tests pass on unfixed code, then assert they still pass. (Requirement 3.3.)
4. **Reference fanout module preservation**: Observe `cdk synth` and the module's test suite pass on unfixed code, then assert they still pass. (Requirement 3.4.)
5. **Post-draft framing preservation**: Generate a diff between `post-draft.md` pre-fix and post-fix; assert that the only changed lines are the deploy-mechanism sentence at line 164 and the matching reference at line 266. Every other line MUST be byte-identical. (Requirement 3.5.)
6. **IAM trust preservation**: Observe that `infrastructure/test/iam-stack.test.ts` asserts `bedrock.amazonaws.com` is in the assume-role policy on both editor and reviewer roles (lines 56–67 and 161–171). Assert these tests still pass — the `CompositePrincipal` change adds the agentcore principal without removing the bedrock principal. (Requirement 3.6.)
7. **Tool-source-of-truth preservation**: Run a static check that `scripts/deploy-harnesses.ts` imports `EDITOR_TOOL_NAMES`, `REVIEWER_TOOL_NAMES`, `reviewerToolCatalogue`, and the per-tool `ToolDefinition` exports rather than redeclaring any tool name or schema. Property-based test: for any mutation to `EDITOR_TOOL_NAMES` (rename a tool, add a tool, remove a tool), the deploy script's tool array reflects the mutation without further code change. (Requirement 3.7.)

### Unit Tests

- **`scripts/__tests__/deploy-harnesses.test.ts`**: Unit tests for the new script's pure functions:
  - `buildHarnessRequest(role, config, parsedPrompt, toolCatalogue)` — assert the assembled `CreateHarnessRequest` has the correct `harnessName`, `executionRoleArn`, `model.bedrockModelConfig.modelId`, `systemPrompt[0].text`, `tools[]` count and shape, and `maxIterations` / `maxTokens` / `timeoutSeconds`. Run for both editor and reviewer roles.
  - `mapLimits(config)` — assert `iterationCap` → `maxIterations`, `tokenSpendCapUSD` → `maxTokens` (with the documented placeholder ratio), `wallClockCapMinutes` → `timeoutSeconds`.
  - `mangleToolName(name)` — assert `"module.readFile"` → `"module_readFile"`, `"sensor.cdkNag"` → `"sensor_cdkNag"`, etc.
  - `pollUntilReady(client, harnessId, options)` — with a mocked `BedrockAgentCoreControlClient`, assert the function polls at the configured interval, returns when `status === "READY"`, throws on `FAILED` / `DELETING` / `DELETED`, and times out after the configured maximum.
  - `loadDeployedHarnessesFile()` and `writeDeployedHarnessesFile()` — assert atomic write (tmp + rename) and round-trip JSON shape.
- **Tool-array shape**: `expect(buildEditorToolArray(...)).toHaveLength(15)`; `expect(buildEditorToolArray(...).map(t => t.name)).toEqual(EDITOR_TOOL_NAMES.map(mangleToolName))`. Same for the reviewer with length 3.
- **Frontmatter parser reuse**: assert that calling `parseEditorSystemPromptFrontmatter` on a fixture system.md returns `{ version, body }` with the body free of frontmatter delimiters.
- **Idempotency**: with a mocked SDK whose `ListHarnesses` returns an existing entry matching the target name, assert `CreateHarness` is NOT called and the existing ARN is written through to `.deployed-harnesses.json`. With `--force-recreate`, assert `DeleteHarness({ harnessId })` is called (with the `harnessId`, NOT the ARN), the deletion is awaited, and then `CreateHarness` is called.

### Property-Based Tests

- **Tool-array tracks the source-of-truth catalogue**: generate an arbitrary mutation to `EDITOR_TOOL_NAMES` (insert, delete, or rename) and assert the deploy script's tool array reflects the mutation: same length, same set of mangled names, same set of `inputSchema` references. Implemented with `fast-check` against an injected stand-in for the editor catalogue. (Validates 2.3, 3.7.)
- **Reviewer tool-array tracks `reviewerToolCatalogue`**: same shape as the editor property, against a stand-in for `reviewerToolCatalogue`. (Validates 2.4, 3.7.)
- **Limit mapping is monotonic**: generate arbitrary `(iterationCap, tokenSpendCapUSD, wallClockCapMinutes)` tuples and assert `mapLimits` produces strictly positive `(maxIterations, maxTokens, timeoutSeconds)`, with `timeoutSeconds === wallClockCapMinutes * 60` and `maxIterations === iterationCap`. (Validates 2.2.)
- **Idempotency over run sequences**: generate arbitrary 3-step sequences of `[fresh-run, second-run, force-recreate-run]` against a mocked SDK that simulates `CreateHarness` / `ListHarnesses` / `DeleteHarness`. Assert: after step 1, both harnesses exist; after step 2 (no `--force-recreate`), `CreateHarness` is NOT called again and ARNs match step 1; after step 3 (with `--force-recreate`), `DeleteHarness` and `CreateHarness` are both called and the new ARNs may or may not equal the old ARNs (the API does not guarantee ARN stability across recreate). (Validates 2.7.)
- **Post-draft framing preservation**: generate the set of all lines in `post-draft.md` and assert that the post-fix file differs from the pre-fix file in exactly the deploy-mechanism sentence at line 164 and the matching reference at line 266; every other line is byte-identical. Implemented as a diff property over the file. (Validates 3.5.)

### Integration Tests

- **End-to-end live-fire deploy**: in a development AWS account with the `CompositePrincipal` IAM trust in place, run `npx ts-node scripts/deploy-harnesses.ts --account-id <id> --region us-east-1 --execution-role <editor-role-arn>` from a clean state (no harnesses with the target names exist). Assert: the script exits zero, both harnesses reach `READY` (visible via the AWS console), `.deployed-harnesses.json` is written with two ARNs, and `npx ts-node scripts/smoke-test.ts` (the existing smoke test) still passes against one of the deployed harnesses. (Validates Property 1 end-to-end.)
- **End-to-end live-fire idempotent rerun**: re-run the script with the same args. Assert: no `CreateHarness` calls are made, `.deployed-harnesses.json` is unchanged, the script exits zero. (Validates 2.7.)
- **End-to-end live-fire force-recreate**: run with `--force-recreate`. Assert: `DeleteHarness` is called for each existing harness, `CreateHarness` is called twice, both harnesses reach `READY`, and `.deployed-harnesses.json` is updated with the new ARNs. (Validates 2.7.)
- **Setup-script Step 4b integration**: run `scripts/setup.sh --from-step 4b` (and the PowerShell equivalent on Windows) against an account where `.deployed-harnesses.json` does NOT yet exist. Assert: the script invokes `deploy-harnesses.ts`, produces `.deployed-harnesses.json`, and the orchestrator-stack deploy reads the ARNs from the file without prompting the operator. (Validates 2.1, 2.8.)
- **Obsolete-files cleanup**: after running the fix once, assert via filesystem checks that `app/editor/harness.json`, `app/reviewer/harness.json`, `agentcore/agentcore.json`, and `agentcore/aws-targets.json` are absent and that `app/editor/`, `app/reviewer/`, and `agentcore/` parent directories are absent (or, in the case of `agentcore/`, present only because `agentcore/.cli/logs/` is preserved). (Validates 2.9.)
- **Documentation grep**: assert via `grep` that `docs/quickstart.md`, `README.md`, and `post-draft.md` no longer contain the strings `agentcore deploy`, `harness.json`, or `agentcore.json` (except as historical references inside the spec directory `.kiro/specs/`), and that `docs/quickstart.md` and `README.md` contain `scripts/deploy-harnesses.ts`. (Validates 2.10.)
- **`.gitignore` check**: assert that `.gitignore` contains a line matching `^\.deployed-harnesses\.json$` near the existing `.setup-harness-arns.json` entry. (Validates 2.11.)
- **IAM trust snapshot**: re-run `infrastructure/test/iam-stack.test.ts`. Assert all existing assertions pass — both editor and reviewer roles still have `bedrock.amazonaws.com` in their assume-role policy as part of the `CompositePrincipal`, alongside `bedrock-agentcore.amazonaws.com`. (Validates 2.5, 3.6.)
