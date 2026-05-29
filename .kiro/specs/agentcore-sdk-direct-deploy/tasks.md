# Implementation Plan

## Overview

Replace the broken `agentcore` CLI-based deploy step with a TypeScript script (`scripts/deploy-harnesses.ts`) that calls `bedrock-agentcore-control:CreateHarness` directly. The fix follows the exploratory bugfix workflow: surface counterexamples that prove the CLI path is broken, establish a preservation baseline for all non-deploy behavior, implement the SDK-direct script and all supporting changes, then validate both the fix and the preservation guarantees.

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1", "2"] },
    { "wave": 2, "tasks": ["3"] },
    { "wave": 3, "tasks": ["4"] },
    { "wave": 4, "tasks": ["5"] }
  ]
}
```

## Tasks

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - CLI Deploy Fails Against Hand-Written Config Files
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the CLI cannot consume the hand-written config files and cannot register `inline_function` tools with custom JSON Schema
  - **Scoped PBT Approach**: For deterministic bugs, scope the property to the concrete failing cases to ensure reproducibility
  - Test case 1 — CLI rejects hand-written `agentcore.json`: run `agentcore deploy` from the repo root with `agentcore/agentcore.json` and `app/<role>/harness.json` in place; assert exit code is non-zero OR stdout contains `DeployError|Error:` (from `isBugCondition` where `deployTool = "agentcore CLI"` and `configFiles` includes `agentcore/agentcore.json`)
  - Test case 2 — CLI rejects `agentcore validate`: run `agentcore validate agentcore/agentcore.json` and `agentcore validate agentcore/aws-targets.json`; assert both reject
  - Test case 3 — CLI cannot register `inline_function` with JSON Schema: run `agentcore add tool --type inline_function --help`; assert the flag list contains no JSON-Schema-attachment flag
  - Test case 4 — `CreateHarness` fails without `bedrock-agentcore.amazonaws.com` trust: temporarily revert `infrastructure/iam-stack.ts` lines 99–103 to `assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com")`, deploy the IAM stack, run `scripts/test-create-harness.ts`; assert `CreateHarness` is rejected with an access-denied error; restore the `CompositePrincipal`
  - Test case 5 — orchestrator step prompts operator: run `scripts/setup.sh --from-step 4b` against a fresh account; assert the script prompts for two ARNs that were never produced
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests FAIL (this is correct — it proves the bug exists)
  - Document counterexamples found (e.g., "`agentcore deploy` exits non-zero on every invocation against the current files", "`agentcore validate` rejects both `agentcore.json` and `aws-targets.json`", "no JSON-Schema-attachment flag in `agentcore add tool --help`", "`CreateHarness` returns access-denied against `bedrock.amazonaws.com`-only role")
  - Mark task complete when tests are written, run, and failures are documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Runtime Behavior and Conceptual Framing Unchanged
  - **IMPORTANT**: Follow observation-first methodology — observe behavior on UNFIXED code for non-buggy inputs first, then write tests capturing that behavior
  - Observe: `agents/editor/__tests__/managed-harness-invocation.test.ts` and the reviewer's equivalent pass on unfixed code — `InvokeHarness` paths through `ManagedHarnessEditorInvocation` and `ManagedHarnessReviewerInvocation` are unchanged (Requirement 3.1)
  - Observe: the orchestrator `runLoop` test suite passes on unfixed code — iteration cap, oscillation detection, and bounded-loop semantics are unchanged (Requirement 3.2)
  - Observe: dispatch-workflow, smoke-test, and post-deploy harness tests pass on unfixed code (Requirement 3.3)
  - Observe: `cdk synth` and the reference fanout module's test suite pass on unfixed code (Requirement 3.4)
  - Observe: `post-draft.md` content outside the deploy-mechanism paragraph at line 164 and the matching reference at line 266 is byte-identical to the pre-fix version (Requirement 3.5)
  - Observe: `infrastructure/test/iam-stack.test.ts` asserts `bedrock.amazonaws.com` is in the assume-role policy on both editor and reviewer roles (lines 56–67 and 161–171) (Requirement 3.6)
  - Observe: `EDITOR_TOOL_NAMES` and `REVIEWER_TOOL_NAMES` are the sole source of truth for tool names and schemas in `agents/editor/tools/*.ts` and `agents/reviewer/tools.ts` (Requirement 3.7)
  - Write property-based test (fast-check): for any mutation to `EDITOR_TOOL_NAMES` (insert, delete, or rename), assert the deploy script's tool array reflects the mutation — same length, same set of mangled names, same set of `inputSchema` references
  - Write property-based test (fast-check): same shape for `reviewerToolCatalogue`
  - Write property-based test (fast-check): generate arbitrary `(iterationCap, tokenSpendCapUSD, wallClockCapMinutes)` tuples and assert `mapLimits` produces strictly positive `(maxIterations, maxTokens, timeoutSeconds)` with `timeoutSeconds === wallClockCapMinutes * 60` and `maxIterations === iterationCap`
  - Write property-based test (fast-check): generate arbitrary 3-step sequences of `[fresh-run, second-run, force-recreate-run]` against a mocked SDK; assert idempotency and recreate semantics
  - Write diff property: generate the set of all lines in `post-draft.md` and assert the post-fix file differs from the pre-fix file in exactly the deploy-mechanism sentence at line 164 and the matching reference at line 266; every other line is byte-identical
  - Run all tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [x] 3. Fix: replace CLI deploy with direct SDK script and clean up obsolete artifacts

  - [x] 3.1 Create `scripts/deploy-harnesses.ts`
    - Model the script on `scripts/test-create-harness.ts` (the proven SDK-direct reference)
    - Accept CLI flags: `--account-id`, `--region`, `--execution-role` (editor role ARN), `--reviewer-execution-role` (optional; defaults to deriving from `--execution-role` by replacing `agent-harness-editor` with `agent-harness-reviewer`), `--force-recreate` (boolean); exit non-zero with usage message if any required flag is missing
    - Load model ids from `agent-harness.config.json` (`models.editor`, `models.reviewer`); load system prompts from `agents/editor/system.md` and `agents/reviewer/system.md` with frontmatter stripped by reusing `parseEditorSystemPromptFrontmatter` from `agents/editor/agent.ts` (and the reviewer-side equivalent) — do NOT duplicate the parser
    - Import `EDITOR_TOOL_NAMES` from `agents/editor/agent.ts` and `reviewerToolCatalogue` / `REVIEWER_TOOL_NAMES` from `agents/reviewer/tools.ts`; build the tool array by importing each tool's `ToolDefinition` directly from `agents/editor/tools/*.ts` and `agents/reviewer/tools.ts`; emit `HarnessTool` entries with `type: "inline_function"`, `name: tool.name.replace(/\./g, "_")`, and `config.inlineFunction.inputSchema: tool.inputSchema` (no Zod conversion — `inputSchema` is already a JSON Schema literal); total: 15 tools for the editor, 3 for the reviewer
    - Export `mapLimits(config)`: `iterationCap` → `maxIterations`, `tokenSpendCapUSD` → `maxTokens` (multiply by 1,000,000 tokens/USD placeholder, documented inline), `wallClockCapMinutes` → `timeoutSeconds` (multiply by 60)
    - Implement existence check: paginate `ListHarnesses`, look for a matching `harnessName`; if found and `--force-recreate` is not set, reuse the existing ARN and `harnessId`; if found and `--force-recreate` is set, call `DeleteHarness({ harnessId })`, poll `GetHarness` until not-found, then call `CreateHarness`; if not found, call `CreateHarness` directly
    - Export `pollUntilReady(client, harnessId, options)`: poll `GetHarness` every 5 seconds; return when `status === "READY"`; throw on `FAILED` / `DELETING` / `DELETED`; hard timeout of 10 minutes per harness
    - Write `.deployed-harnesses.json` atomically (write to `.deployed-harnesses.json.tmp` then rename) with shape `{ editor: { harnessId, arn }, reviewer: { harnessId, arn } }`; export `writeDeployedHarnessesFile()` and `loadDeployedHarnessesFile()` for unit tests
    - Log each step (`existence check`, `creating`, `polling status`, `READY`, `wrote artifact`) with the harness name as a prefix
    - _Bug_Condition: isBugCondition(X) where X.deployTool = "agentcore CLI" AND X.configFiles includes any of the four hand-written config files_
    - _Expected_Behavior: result.editor.status = "READY" AND result.reviewer.status = "READY" AND both ARNs match "arn:aws:bedrock-agentcore:.*:harness/.*" AND fileExists(".deployed-harnesses.json") AND no obsolete files remain_
    - _Preservation: script imports EDITOR_TOOL_NAMES, REVIEWER_TOOL_NAMES, and per-tool ToolDefinition exports rather than redeclaring any tool name or schema; does not touch InvokeHarness paths, runLoop, dispatch workflow, smoke test, post-deploy harness, or reference fanout module_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 2.7, 2.8, 3.7_

  - [x] 3.2 Write unit tests in `scripts/__tests__/deploy-harnesses.test.ts`
    - `buildHarnessRequest(role, config, parsedPrompt, toolCatalogue)` — assert correct `harnessName`, `executionRoleArn`, `model.bedrockModelConfig.modelId`, `systemPrompt[0].text`, `tools[]` count and shape, and `maxIterations` / `maxTokens` / `timeoutSeconds` for both editor and reviewer roles
    - `mapLimits(config)` — assert `iterationCap` → `maxIterations`, `tokenSpendCapUSD` → `maxTokens` (with placeholder ratio), `wallClockCapMinutes` → `timeoutSeconds`
    - `mangleToolName(name)` — assert `"module.readFile"` → `"module_readFile"`, `"sensor.cdkNag"` → `"sensor_cdkNag"`, etc.
    - `pollUntilReady` — with a mocked `BedrockAgentCoreControlClient`, assert polling at configured interval, returns on `READY`, throws on `FAILED` / `DELETING` / `DELETED`, times out after configured maximum
    - `loadDeployedHarnessesFile()` and `writeDeployedHarnessesFile()` — assert atomic write (tmp + rename) and round-trip JSON shape
    - Tool-array shape: `expect(buildEditorToolArray(...)).toHaveLength(15)`; `expect(buildEditorToolArray(...).map(t => t.name)).toEqual(EDITOR_TOOL_NAMES.map(mangleToolName))`; same for reviewer with length 3
    - Frontmatter parser reuse: assert `parseEditorSystemPromptFrontmatter` on a fixture `system.md` returns `{ version, body }` with body free of frontmatter delimiters
    - Idempotency: with mocked `ListHarnesses` returning an existing entry matching the target name, assert `CreateHarness` is NOT called and the existing ARN is written through; with `--force-recreate`, assert `DeleteHarness({ harnessId })` is called (NOT the ARN), deletion is awaited, then `CreateHarness` is called
    - _Requirements: 2.2, 2.3, 2.4, 2.6, 2.7_

  - [x] 3.3 Update `scripts/setup.sh` Step 4b
    - Replace the `pushd "$REPO_ROOT"` block running `agentcore deploy` (lines 199–215) with a single `npx ts-node scripts/deploy-harnesses.ts --account-id "$ACCOUNT_ID" --region "$REGION" --execution-role "$EDITOR_EXECUTION_ROLE_ARN"` invocation; remove the post-hoc `grep -qE "DeployError|Error:|error:"` defensive check (lines 211–215)
    - Replace the interactive `read -rp` block (lines 218–228) that prompts for `EDITOR_HARNESS_ARN` and `REVIEWER_HARNESS_ARN` with `jq -r '.editor.arn'` and `jq -r '.reviewer.arn'` reads from `"$REPO_ROOT/.deployed-harnesses.json"`; add a guard that fails with a clear message if either ARN is empty
    - _Requirements: 2.1, 2.8_

  - [x] 3.4 Update `scripts/setup.ps1` Step 4b
    - Replace the `Push-Location $RepoRoot` block running `agentcore deploy` (lines 234–250) with a single `npx ts-node scripts/deploy-harnesses.ts ...` invocation using PowerShell exit-code propagation; remove the `$deployOutput -match "DeployError|Error:|error:"` grep
    - Replace the `Read-Host` calls (lines 252–261) with `Get-Content $RepoRoot\.deployed-harnesses.json | ConvertFrom-Json` and read `editor.arn` and `reviewer.arn`; add the same empty-ARN guard as the bash script
    - _Requirements: 2.1, 2.8_

  - [x] 3.5 Verify IAM trust policy in `infrastructure/iam-stack.ts` (reference only — already implemented)
    - Confirm `EditorAgentRole` (lines 94–103) declares `assumedBy: new iam.CompositePrincipal(new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"), new iam.ServicePrincipal("bedrock.amazonaws.com"))`
    - Confirm `ReviewerAgentRole` (lines 282–290) declares the same `CompositePrincipal` shape
    - Run `infrastructure/test/iam-stack.test.ts` and assert all existing assertions pass — both roles still trust `bedrock.amazonaws.com` alongside `bedrock-agentcore.amazonaws.com`
    - Do NOT re-implement; reference and verify only
    - _Requirements: 2.5, 3.6_

  - [x] 3.6 Delete obsolete files and clean up empty directories
    - Delete `app/editor/harness.json`, `app/reviewer/harness.json`, `agentcore/agentcore.json`, `agentcore/aws-targets.json`
    - Remove `app/editor/`, `app/reviewer/`, and `agentcore/` parent directories if they become empty after the deletions (check via `fs.readdirSync(dir).length === 0`); do NOT remove `agentcore/` if `agentcore/.cli/` still exists (the historical CLI logs in `agentcore/.cli/logs/deploy/` are preserved as useful failure artefacts)
    - _Requirements: 2.9_

  - [x] 3.7 Update `.gitignore`
    - Add `.deployed-harnesses.json` to the ignore list near the existing `.setup-harness-arns.json` entry under the `# Setup script temp files` comment
    - _Requirements: 2.11_

  - [x] 3.8 Update `docs/quickstart.md`
    - Remove the `@aws/agentcore@preview` install line from the Prerequisites section
    - Rewrite Step 4b body (lines 136–196) to describe `npx ts-node scripts/deploy-harnesses.ts`, including the flag list, the `.deployed-harnesses.json` artefact, the idempotency contract, and the `--force-recreate` flag; note that `.deployed-harnesses.json` is gitignored
    - Update the resume-from-step-4b note (line 91) to state Step 4b runs unattended and writes `.deployed-harnesses.json`
    - _Requirements: 2.10_

  - [x] 3.9 Update `README.md`
    - Remove all references to `app/editor/harness.json`, `app/reviewer/harness.json`, and `agentcore/` path strings
    - Add a reference to `scripts/deploy-harnesses.ts` in the section describing how the harnesses are deployed
    - Preserve the runtime/engineering split, the bounded-loop framing, the stop-conditions list, and the "Are you on AWS / CDK / AgentCore?" decision points unchanged
    - _Requirements: 2.10, 3.5_

  - [x] 3.10 Update `post-draft.md` Section 4 (deploy-mechanism paragraph only)
    - Replace the deploy-mechanism sentence at line 164 with: *"In AgentCore Managed Harness terms, the editor is declared via the `bedrock-agentcore-control:CreateHarness` API call from `scripts/deploy-harnesses.ts`, which reads the model id (Claude Sonnet via Bedrock in the template's defaults), the system prompt, and the tool definitions from the engineering harness layer (`agent-harness.config.json`, `agents/editor/system.md`, and the `ToolDefinition` exports in `agents/editor/tools/*.ts`)."*
    - Update the matching reference at line 266 to replace `harness.json config files` with `scripts/deploy-harnesses.ts` and the engineering harness layer
    - Leave every other paragraph in `post-draft.md` byte-identical — the runtime/engineering split argument (Section 1), the bounded-loop argument (Sections 2 and 3), the prerequisites for extending past the PR boundary (Section 3), the rest of Section 4, the self-audit (Section 5), and the closing notes (Section 6) all stay as written
    - _Requirements: 2.10, 3.5_

  - [x] 3.11 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Direct SDK Deploy Succeeds Where CLI Deploy Fails
    - **IMPORTANT**: Re-run the SAME tests from task 1 — do NOT write new tests
    - The tests from task 1 encode the expected behavior; when they pass, it confirms the expected behavior is satisfied
    - Run the bug condition exploration tests from step 1 against the fixed code
    - **EXPECTED OUTCOME**: Tests PASS (confirms bug is fixed — CLI path is gone, SDK path succeeds)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11_

  - [x] 3.12 Verify preservation tests still pass
    - **Property 2: Preservation** - Runtime Behavior and Conceptual Framing Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run all preservation property tests from step 2 against the fixed code
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix — `managed-harness-invocation.test.ts`, `runLoop` tests, dispatch/smoke-test/post-deploy tests, fanout module tests, `iam-stack.test.ts`, post-draft diff property, tool-source-of-truth property

- [x] 4. Run end-to-end integration validation
  - Run live-fire deploy: `npx ts-node scripts/deploy-harnesses.ts --account-id <id> --region us-east-1 --execution-role <editor-role-arn>` from a clean state; assert script exits zero, both harnesses reach `READY`, `.deployed-harnesses.json` is written with two ARNs, and `npx ts-node scripts/smoke-test.ts` still passes
  - Run idempotent rerun: re-run the script with the same args; assert no `CreateHarness` calls are made, `.deployed-harnesses.json` is unchanged, script exits zero
  - Run force-recreate: run with `--force-recreate`; assert `DeleteHarness` is called for each existing harness, `CreateHarness` is called twice, both harnesses reach `READY`, `.deployed-harnesses.json` is updated
  - Run setup-script Step 4b integration: run `scripts/setup.sh --from-step 4b` (and PowerShell equivalent) against an account where `.deployed-harnesses.json` does not yet exist; assert the script invokes `deploy-harnesses.ts`, produces `.deployed-harnesses.json`, and the orchestrator-stack deploy reads the ARNs without prompting the operator
  - Assert via filesystem checks that `app/editor/harness.json`, `app/reviewer/harness.json`, `agentcore/agentcore.json`, and `agentcore/aws-targets.json` are absent; assert `app/editor/`, `app/reviewer/` are absent; assert `agentcore/` is present only because `agentcore/.cli/` exists
  - Assert via `grep` that `docs/quickstart.md`, `README.md`, and `post-draft.md` no longer contain `agentcore deploy`, `harness.json`, or `agentcore.json` (except inside `.kiro/specs/`), and that `docs/quickstart.md` and `README.md` contain `scripts/deploy-harnesses.ts`
  - Assert `.gitignore` contains a line matching `^\.deployed-harnesses\.json$`
  - Re-run `infrastructure/test/iam-stack.test.ts`; assert all existing assertions pass

- [x] 5. Checkpoint — Ensure all tests pass
  - Ensure all tests pass; ask the user if questions arise
  - Confirm: unit tests in `scripts/__tests__/deploy-harnesses.test.ts` pass
  - Confirm: property-based tests (tool-array tracking, limit mapping, idempotency, post-draft diff) pass
  - Confirm: existing test suites (`agents/editor/__tests__/`, `agents/reviewer/__tests__/`, `agents/shared/__tests__/`, `infrastructure/test/iam-stack.test.ts`) pass unmodified
  - Confirm: end-to-end live-fire deploy succeeds and `.deployed-harnesses.json` is written
  - Confirm: no obsolete files remain on disk
  - Confirm: documentation no longer references the broken CLI path

## Notes

- Tasks 1 and 2 MUST be completed before any implementation work in task 3 begins. Task 1 is expected to fail on unfixed code — that failure is the proof the bug exists. Task 2 is expected to pass on unfixed code — those passing tests define the preservation baseline.
- The IAM trust policy (`CompositePrincipal` with both `bedrock.amazonaws.com` and `bedrock-agentcore.amazonaws.com`) is already implemented in `infrastructure/iam-stack.ts` lines 99–103 (editor) and 286–290 (reviewer). Task 3.5 is reference-and-verify only; do not re-implement.
- The `agentcore/.cli/logs/deploy/` directory contains historical CLI failure logs (`deploy-20260526-135157.log`, `deploy-20260526-135612.log`) and MUST be preserved. The cleanup in task 3.6 checks each parent directory for true emptiness before removing it.
- `scripts/deploy-harnesses.ts` imports `ToolDefinition.inputSchema` directly — no Zod conversion is required. Every `ToolDefinition` in the codebase already authors `inputSchema` as a JSON Schema literal (confirmed by zero matches for `from "zod"` in `agents/`).
- The `tokenSpendCapUSD` → `maxTokens` conversion uses a conservative placeholder of 1,000,000 tokens per USD, documented inline in the script. A follow-up issue tracks pinning the ratio to a live-fire measurement.
- Sub-tasks 3.11 and 3.12 re-run the SAME tests written in tasks 1 and 2 respectively — they do not introduce new tests.
