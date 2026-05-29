# Design Document

## Overview

This design pins down the components, contracts, and lifecycles needed to satisfy the `feature-change-loop` requirements. The shape is two Strands agents (an editor and a reviewer) running on AgentCore Harness, wrapped by a GitHub-Action-driven trigger surface, supported by a CDK reference module, three computational sensors, an inferential reviewer, and a synthetic post-deploy harness. Every external surface the agent can reach is scoped by IAM or by tool catalogue; every trust gate the requirements call out maps to a specific component below.

The design assumes the Apache 2.0 template will be forked, so component boundaries prefer clarity and adaptability over cleverness. Where a simpler implementation costs little but loses extensibility, the more extensible option is chosen and called out.

## Architecture

### Component overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ GitHub repository                                                    │
│ ┌────────────────────┐  ┌────────────────────┐  ┌──────────────────┐ │
│ │ Issues + Labels    │  │ Issue templates    │  │ Pull requests    │ │
│ │ (agent-task,       │  │ (.github/          │  │ (agent-authored) │ │
│ │  agent-stop)       │  │  ISSUE_TEMPLATE/)  │  │                  │ │
│ └─────────┬──────────┘  └────────────────────┘  └──────────────────┘ │
│           │ on: issues.labeled                                       │
│           v                                                          │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ GitHub Action: dispatch-agent-task.yml                           │ │
│ │ - validates label, builds payload, calls AgentCore endpoint      │ │
│ │ - on failure, comments on issue and exits non-zero               │ │
│ └─────────┬────────────────────────────────────────────────────────┘ │
└───────────│──────────────────────────────────────────────────────────┘
            │ HTTPS POST (signed)
            v
┌──────────────────────────────────────────────────────────────────────┐
│ AWS account (template account)                                       │
│                                                                      │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ AgentCore Harness                                                │ │
│ │ ┌────────────────────────────────────────────────────────────┐   │ │
│ │ │ Session (one per trigger)                                  │   │ │
│ │ │ - trigger payload                                          │   │ │
│ │ │ - per-iteration: edit, sensor outputs, deploy result,      │   │ │
│ │ │   post-deploy result                                       │   │ │
│ │ │ - stop record on termination                               │   │ │
│ │ └────────────────────────────────────────────────────────────┘   │ │
│ │ ┌────────────────────────────────────────────────────────────┐   │ │
│ │ │ Editor agent (Strands Agent)                               │   │ │
│ │ │ - model: Claude Sonnet via Bedrock (configurable)          │   │ │
│ │ │ - system prompt: editor.system.md                          │   │ │
│ │ │ - tool catalogue (declared statically, see below)          │   │ │
│ │ └────────────────────────────────────────────────────────────┘   │ │
│ │ ┌────────────────────────────────────────────────────────────┐   │ │
│ │ │ Reviewer agent (separate Strands Agent invocation)         │   │ │
│ │ │ - model: same default, swappable                           │   │ │
│ │ │ - system prompt: reviewer.system.md                        │   │ │
│ │ │ - tool catalogue: read-only diff tools                     │   │ │
│ │ └────────────────────────────────────────────────────────────┘   │ │
│ └─────────┬───────────────────────┬────────────────────────────────┘ │
│           │                       │                                  │
│           │ tool calls            │ tool calls (diff-only)           │
│           v                       v                                  │
│ ┌────────────────────┐  ┌────────────────────┐                       │
│ │ Computational      │  │ Reviewer wrapper   │                       │
│ │ sensors            │  │ (invokes reviewer  │                       │
│ │ - cdk-nag          │  │  agent)            │                       │
│ │ - tsc --noEmit     │  └────────────────────┘                       │
│ │ - eslint           │                                               │
│ │ - assertions tests │                                               │
│ └────────────────────┘                                               │
│                                                                      │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ Preview environment (per trigger; tag-scoped)                    │ │
│ │ - reference CDK module deployed: API GW → Lambda → SNS → SQS →   │ │
│ │   Lambda                                                         │ │
│ │ - CloudWatch logs and metrics                                    │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ Synthetic post-deploy harness (separate test runner)             │ │
│ │ - drives traffic through API GW                                  │ │
│ │ - asserts on downstream Lambda receipt and properties            │ │
│ │ - distinguishes deploy-failure from post-deploy-check-failure    │ │
│ └──────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

The flow proceeds left to right: GitHub triggers AgentCore, AgentCore drives the editor agent, the editor agent invokes sensors and the reviewer as tools, deploy lands in the preview, the post-deploy harness exercises it, results come back into the session as context for the next iteration, and on success the editor opens a PR via a final tool call. The agent never reaches anything outside the boxes shown.

### Component responsibilities

- **GitHub Action `dispatch-agent-task.yml`.** The single entry point from a labelled issue to AgentCore. Validates the label, validates the issue template fields, builds the payload, signs the request, calls the AgentCore endpoint, and comments on failures. No retry on its own; failure must be human-visible.
- **AgentCore session.** The durable record of one trigger's lifetime. The editor reads from it on every turn; the harness writes to it after every tool call and at termination.
- **Editor agent.** The planner and executor. Reads context, plans an edit, applies it, runs sensors, decides whether to iterate or deploy, fires the post-deploy harness, decides whether to iterate or stop, opens the PR.
- **Reviewer agent.** A second Strands `Agent` invoked as a tool by the editor. Reads the diff and a static reference (Well-Architected Security and Reliability checklists), produces a structured checklist. No edit or deploy tools; the wrapper enforces invocation parameters.
- **Computational sensors.** Four standalone runners: `cdk-nag` (during `cdk synth` of the module), `tsc --noEmit`, `eslint`, and an `aws-cdk-lib/assertions` test suite. Each is a separate tool with a structured output contract.
- **Preview environment.** A tagged, per-trigger AWS environment created by `cdk deploy --context env=preview-<session-id>`. IAM scopes constrain the agent to this environment by tag and account. Teardown happens on PR close or by the scheduled sweep.
- **Synthetic post-deploy harness.** A separate test runner (TypeScript, runs in the GitHub Actions runner or in a Lambda the harness invokes) that exercises the deployed preview and writes a structured pass/fail/partial result.

### Layering

The architecture splits along the two-layer line the post argues for:

- *Runtime harness layer:* AgentCore (sessions, orchestration, sandbox, tool registration, IAM-bound credentials), and the static tool catalogue declarations.
- *Engineering harness layer:* the steering file `AGENTS.md`, the four computational sensors, the reviewer agent and its checklist, the post-deploy harness, the GitHub-side wiring (issue templates, labels, the dispatch Action), and the operational contract pieces (kill switch, teardown, cost guards).

The IAM model and the tool catalogue declarations are the seam between the two: AgentCore enforces them, but their *content* is engineering-harness work because it encodes what this team allows.

## Components and Interfaces

### Trigger payload (Requirement 1)

The GitHub Action posts the following JSON to the AgentCore endpoint. Keys are stable across both spec 1 and spec 2; spec 2's `fitness-gap` trigger reuses the same shape with a different `triggerType` and an additional `originatingFinding` object (defined in spec 2).

```jsonc
{
  "schemaVersion": "1.0",
  "triggerType": "feature-change",        // or "fitness-gap" in spec 2
  "issue": {
    "number": 42,
    "title": "Add a dead-letter queue to the SQS subscriber",
    "body": "<rendered issue body, structured fields preserved>",
    "url": "https://github.com/<org>/<repo>/issues/42",
    "openedBy": "<github-handle>"
  },
  "module": {
    "path": "modules/fanout",             // from issue template
    "repository": "<org>/<repo>",
    "ref": "main",                        // commit SHA pinned by Action
    "commitSha": "<sha>"
  },
  "session": {
    "id": "session-<uuid>",               // generated by Action
    "createdAt": "<iso-8601>"
  },
  "limits": {                             // pulled from repo config
    "iterationCap": 5,
    "wallClockCapMinutes": 60,
    "tokenSpendCapUSD": 10.0
  },
  "auth": {
    "githubInstallationToken": "<scoped, short-lived>"
  }
}
```

Notes on the contract:

- `schemaVersion` exists so we can evolve the payload without breaking deployed Actions.
- `auth.githubInstallationToken` is short-lived and minted by the Action; the agent uses it for PR creation only and the token expires before the loop times out.
- All concrete defaults live in repository configuration (a single `agent-harness.config.json` file at the repo root) that the Action reads.

### Tool catalogue: editor agent (Requirement 2)

Declared statically in `agents/editor/tools.ts`. The agent cannot extend the catalogue at runtime. Each tool has an explicit JSON schema for inputs and outputs.

| Tool | Direction | Input | Output |
|---|---|---|---|
| `module.readFile` | read | `{path}` (must start with `module.path`) | `{contents, sha}` |
| `module.writeFile` | write | `{path, contents}` (must start with `module.path`) | `{written: true, newSha}` |
| `module.listFiles` | read | `{glob}` (scoped to `module.path`) | `{paths[]}` |
| `module.diff` | read | `{}` | `{diff}` (text diff vs. base ref) |
| `cdk.diff` | read | `{}` | `{diff}` (cdk diff against preview) |
| `cdk.deploy` | execute | `{}` | `{outcome: "ok" | "deploy-error", logs, stackOutputs?}` |
| `sensor.cdkNag` | read | `{}` | `{findings[], passed}` |
| `sensor.tsc` | read | `{}` | `{errors[], passed}` |
| `sensor.eslint` | read | `{}` | `{findings[], passed}` |
| `sensor.unitTests` | read | `{}` | `{results[], passed}` |
| `reviewer.invoke` | tool-as-agent | `{diff}` | `{findings[], passed, severityCounts}` |
| `preview.cwLogs` | read | `{logGroup, since}` | `{events[]}` |
| `preview.cwMetrics` | read | `{metric, since, dimensions}` | `{points[]}` |
| `postDeploy.invoke` | execute | `{}` | `{outcome: "pass" | "fail" | "partial" | "deploy-failure", report}` |
| `pr.open` | execute | `{title, body, branch, baseRef}` | `{number, url}` |

Forbidden by design (Requirement 2.3):

- No tool to merge a PR. PR merge is a human-only GitHub UI action; the IAM and the GitHub installation scope deny it.
- No tool to deploy outside the preview. `cdk.deploy` is hard-coded to the preview context.
- No tool to modify repository settings, branch protection, secrets, or webhooks.
- No tool to read or write outside `module.path`. Path checks happen in the tool wrapper, not just by convention.

### Tool catalogue: reviewer agent (Requirement 5)

Declared statically in `agents/reviewer/tools.ts`. Strict subset of the editor's catalogue.

| Tool | Direction | Input | Output |
|---|---|---|---|
| `module.readFile` | read | `{path}` | `{contents, sha}` |
| `module.diff` | read | `{}` | `{diff}` |
| `reference.checklist` | read | `{pillar}` | `{items[]}` |

The reviewer cannot write, deploy, observe, or invoke other tools. The wrapper that invokes the reviewer (called by the editor's `reviewer.invoke`) prevents the editor from passing arbitrary inputs through to the reviewer's prompt.

### System prompts

- **`agents/editor/system.md`.** Orients the editor: "you maintain the CDK module at `<module.path>`; you must read `AGENTS.md` before any change; you may only use tools in your catalogue; you must call `postDeploy.invoke` after every successful `cdk.deploy`; you stop only when post-deploy passes or a stop condition is reached."
- **`agents/reviewer/system.md`.** Orients the reviewer: "you produce a Well-Architected review against Security and Reliability pillars by default; you must produce structured output matching the schema; you must not propose edits."

Both prompts are versioned in the repo and referenced by version in the agent definitions.

### Session contract (Requirement 9.5, plus general Requirement 7 support)

Every session is a single AgentCore session, scoped by `session.id` from the payload. Structure:

```jsonc
{
  "schemaVersion": "1.0",
  "trigger": { /* original payload */ },
  "iterations": [
    {
      "index": 0,
      "startedAt": "<iso>",
      "edits": [ { "path": "...", "diff": "..." } ],
      "computational": {
        "cdkNag": { "findings": [], "passed": true },
        "tsc":    { "errors": [],   "passed": true },
        "eslint": { "findings": [], "passed": true },
        "unitTests": { "results": [], "passed": true }
      },
      "reviewer": { "findings": [], "passed": true, "severityCounts": {} },
      "deploy":   { "outcome": "ok", "logs": "..." } | null,
      "postDeploy": { "outcome": "pass", "report": {} } | null,
      "endedAt": "<iso>"
    }
  ],
  "termination": {
    "reason": "success" | "iteration-cap" | "wall-clock-cap" |
              "token-cap" | "kill-switch" | "oscillation",
    "endedAt": "<iso>",
    "prNumber": <int> | null
  },
  "costs": {
    "editorTokensUSD": 0.00,
    "reviewerTokensUSD": 0.00,
    "previewInfraUSD": 0.00
  }
}
```

The harness writes; the editor reads. The editor's `module.diff` and `module.listFiles` reflect the *current* state of the workspace (not the session record), but the session record gives the editor the history of what's been tried.

### IAM model (Requirement 9)

Three principals:

1. **Editor agent role.** Granted by AgentCore. Permissions: `cdk diff`, `cdk deploy`, CloudWatch read, on resources tagged `agent-harness/session = <session.id>` *and* `agent-harness/env = preview` in the template account only. No GitHub write permissions; PR creation goes through the short-lived installation token in the payload.
2. **Reviewer agent role.** Granted by AgentCore. Permissions: `s3:GetObject` on the static checklist bucket (or local file read in the runtime), and nothing else. No CDK, no CloudWatch, no GitHub.
3. **GitHub Action runner.** A GitHub-managed identity with permission to call the AgentCore endpoint and to comment on issues. Cannot deploy or read AWS resources directly.

The IAM policies are defined in CDK alongside the reference module so that the runtime harness boundary is itself code-reviewable. Operators auditing trust can read one CDK file to see what the agent can reach.

### Tool wrappers

Every tool runs through a wrapper that:

1. Validates inputs against the JSON schema and rejects malformed calls.
2. Enforces path scoping for file tools (anything outside `module.path` rejected before execution).
3. Captures structured output and writes it to the session.
4. Updates cost counters where applicable.

Wrappers are the only place where AgentCore-side enforcement and engineering-harness logic mix; everything else stays cleanly in one layer. This is deliberate: when something goes wrong in production, the wrapper layer is the natural place to log, retry, or reject.

## Behavioural design

### The bounded loop, expanded

The 12-step loop in the requirements is the *control* flow. The actual behaviour per iteration is:

```
LOOP:
  iteration_n = session.appendIteration()

  // 1. Read context
  context = {
    trigger: session.trigger,
    steering: read("AGENTS.md"),
    moduleSnapshot: module.listFiles({ glob: "**/*.ts" }) + module.readFile(...),
    history: session.iterations[:-1]
  }

  // 2. Plan and edit
  editor.run(context)            // edits land via module.writeFile
  iteration_n.edits = recordedEdits()

  // 3. Computational sensors
  iteration_n.computational = {
    cdkNag: sensor.cdkNag(),
    tsc:    sensor.tsc(),
    eslint: sensor.eslint(),
    unitTests: sensor.unitTests()
  }
  if (anyFailed(iteration_n.computational)):
    if (stopConditionTripped()): break
    continue LOOP                // step 6 from the requirement

  // 4. Inferential reviewer
  iteration_n.reviewer = reviewer.invoke({ diff: module.diff() })
  if (severityAboveThreshold(iteration_n.reviewer)):
    if (stopConditionTripped()): break
    continue LOOP                // step 6 from the requirement

  // 5. Deploy
  iteration_n.deploy = cdk.deploy()
  if (iteration_n.deploy.outcome != "ok"):
    if (stopConditionTripped()): break
    continue LOOP                // step 11 from the requirement

  // 6. Post-deploy harness
  iteration_n.postDeploy = postDeploy.invoke()
  if (iteration_n.postDeploy.outcome != "pass"):
    if (stopConditionTripped()): break
    continue LOOP                // step 11 from the requirement

  // 7. Success
  pr = pr.open(buildSuccessPRBody(session))
  session.terminate({ reason: "success", prNumber: pr.number })
  break

END LOOP

// Failure or non-success exits land here
if (session.termination.reason != "success"):
  pr = pr.open(buildPartialPRBody(session))
  session.termination.prNumber = pr.number
```

Pseudo-code only; the real implementation is TypeScript and structured into `runIteration` / `evaluateGate` / `tryDeploy` functions for testability.

### Stop conditions (Requirement 8)

`stopConditionTripped()` checks, in order:

1. `agent-stop` label present on issue or PR (polled before each iteration; fast path).
2. Iteration index ≥ `limits.iterationCap`.
3. Now − `session.startedAt` ≥ `limits.wallClockCapMinutes` minutes.
4. `session.costs.editorTokensUSD + session.costs.reviewerTokensUSD ≥ limits.tokenSpendCapUSD`.
5. Oscillation: same diff produced twice in the last three iterations, or computational+reviewer results alternating between the same two states across the last four iterations.

When tripped, the loop exits, the session terminates with the matching reason, and a partial PR opens with the session log embedded.

The token-spend cap default the requirements deferred: `10 USD per trigger`. This is conservative for a Sonnet-class model on a sub-500-line module across five iterations, with reviewer overhead included. It will be measured during template-build verification (Requirement 10.3) and revisited.

### PR body

The editor builds the PR body from a template. Two variants:

- **Success PR.** Sections: trigger, summary of changes (one paragraph), file diff highlights, sensor results table (per-sensor pass/fail + finding counts), post-deploy harness summary, link to preview environment, link to session log.
- **Partial PR.** Same structure plus a top banner naming the termination reason ("did not converge" / "timed out" / "cost cap reached" / "kill switch" / "oscillation"), the session log embedded inline (not just linked), and a recommended next-step note for the human reviewer.

Both variants are templated at `agents/editor/pr-body.template.md` so a forker can adapt the format without changing agent code.

## Data Models

### `agent-harness.config.json` (repo root)

Single source of truth for configurable values. Read by the GitHub Action and by the agents.

```jsonc
{
  "module": {
    "path": "modules/fanout",
    "stackName": "FanoutPreview"
  },
  "agentcore": {
    "endpoint": "https://<agentcore-endpoint>",
    "regionalRouting": "us-east-1"
  },
  "models": {
    "editor": "anthropic.claude-sonnet-<version>",
    "reviewer": "anthropic.claude-sonnet-<version>"
  },
  "limits": {
    "iterationCap": 5,
    "wallClockCapMinutes": 60,
    "tokenSpendCapUSD": 10.0
  },
  "sensors": {
    "cdkNagRulePack": "AwsSolutions",
    "reviewerSeverityThreshold": "MEDIUM",
    "reviewerPillars": ["Security", "Reliability"]
  },
  "preview": {
    "tagKey": "agent-harness/session",
    "envTagKey": "agent-harness/env",
    "sweepIntervalHours": 6,
    "sweepMaxAgeHours": 24
  },
  "oscillation": {
    "sameDiffWindow": 3,
    "alternationWindow": 4
  }
}
```

Versioned alongside the spec; a CI check fails if a field is added without a corresponding spec or design update.

### Sensor output contracts

Every sensor returns the same shape (`{passed: bool, ...details}`) so the loop's gate logic is uniform. Sensor-specific fields:

```ts
type CdkNagOutput   = { passed: boolean; findings: Array<{ resourceId: string; ruleId: string; message: string; severity: "error"|"warning" }> }
type TscOutput      = { passed: boolean; errors:   Array<{ file: string; line: number; col: number; message: string }> }
type EslintOutput   = { passed: boolean; findings: Array<{ file: string; line: number; ruleId: string; message: string; severity: "error"|"warning" }> }
type UnitTestsOutput= { passed: boolean; results:  Array<{ name: string; status: "pass"|"fail"|"skip"; durationMs: number; failureMessage?: string }> }
type ReviewerOutput = { passed: boolean; findings: Array<{ id: string; pillar: string; severity: "info"|"low"|"medium"|"high"|"critical"; file?: string; line?: number; description: string; suggestedFix: string }>; severityCounts: Record<string, number> }
type PostDeployOutput = { outcome: "pass" | "fail" | "partial" | "deploy-failure"; report: Record<string, unknown>; logs?: Record<string, string>; deployLogs?: string }
```

Strict TypeScript types; runtime validators reject deviations. The agent reads these as structured data, not as free text.

### CDK reference module

Single stack `FanoutStack` in `modules/fanout/`. Resources:

- `RestApi` (`apigateway.RestApi`).
- `IngressFn` (`lambda.Function`, NodeJS 20.x). Reads request, publishes to SNS.
- `Topic` (`sns.Topic`).
- `Subscription` to `Queue` from `Topic`, with optional filter policy slot.
- `Queue` (`sqs.Queue`, KMS-encrypted).
- `EgressFn` (`lambda.Function`, NodeJS 20.x). Reads from queue, writes to CloudWatch.
- IAM roles least-scoped per function.
- Tags: `agent-harness/session`, `agent-harness/env=preview`, plus team-defined tags.

The stack reads its environment context from `cdk.context.json` to support per-trigger preview deploys.

## Error Handling

Distinguishing failures matters because the agent reacts differently to each.

### Trigger-time failures (before AgentCore is reached)

| Failure | Detection | Response |
|---|---|---|
| Issue lacks `agent-task` label | Action's label filter | Action no-op |
| Issue template fields missing | Action validator | Action comments on issue with what's missing; exit non-zero |
| AgentCore endpoint unreachable | Action HTTP failure | Action comments on issue with the error and exits non-zero (Requirement 1.4) |
| Repository config missing or invalid | Action validator on `agent-harness.config.json` | Same as above |

### Iteration-time failures

| Failure | Detection | Response |
|---|---|---|
| Computational sensor fails | Sensor wrapper returns `passed: false` | Continue loop with output as context |
| Reviewer above severity threshold | Reviewer wrapper checks `severityCounts` | Continue loop with findings as context |
| `cdk deploy` errors (`outcome != "ok"`) | Deploy tool returns `"deploy-error"` | Continue loop; treated as a sensor-class failure rather than a terminal one |
| Post-deploy harness fails | Post-deploy returns `"fail" \| "partial" \| "deploy-failure"` | Continue loop |
| Tool wrapper rejects (path violation, schema violation) | Wrapper validation | Iteration aborts, session records the rejection, loop continues from next iteration |
| Bedrock model error / throttling | AgentCore retry then surface | Retry with backoff per AgentCore defaults; if exceeded, terminate with `model-error` reason |
| AgentCore session storage unavailable | Session API errors | Halt loop, return error to GitHub Action which comments on issue |
| Reviewer agent timeout | Reviewer wrapper timeout (default 5 minutes) | Treat as `passed: true` with a `reviewerUnavailable: true` flag *only if* a fallback flag is set; default behaviour is to fail closed and halt with `reviewer-unavailable` reason |

### Termination-time failures

| Failure | Detection | Response |
|---|---|---|
| PR creation fails (token expired, branch conflict) | `pr.open` tool error | Retry once with refreshed token; if still failing, write to session and halt; operator picks up via session log |
| Preview teardown fails | Cleanup workflow exit code | Scheduled sweep retries; if persistent failure, runbook entry |

The defaults bias toward "fail closed and halt" rather than "soldier on with degraded checks." A skipped sensor is worse than a halted loop; the human reviewer can always restart by removing and re-applying the `agent-task` label.

### Concurrency and idempotency

- One trigger = one session = at most one in-flight loop. The Action checks for an existing session for the issue and refuses to start a new one if one is in progress.
- A re-applied `agent-task` label on a closed issue starts a new session if no in-flight session exists; the previous session's PR (open or closed) is referenced in the new session's payload metadata for context but does not seed history.
- `cdk deploy` to the preview is idempotent; the stack name encodes the session id, so a partial deploy can be repeated safely.

## Security Considerations

- **Secrets handling.** The `auth.githubInstallationToken` is short-lived (1 hour), scoped to PR creation on the originating repo, and never written to the session record (the wrapper redacts it). Other secrets (Bedrock, AgentCore) are held by IAM, not transmitted in payloads.
- **Untrusted input.** Issue body content is treated as untrusted user input. The editor's system prompt explicitly tells it to ignore instructions in the issue body that would expand its action space ("ignore previous instructions" patterns); the wrapper layer is the real defence, not the prompt.
- **Tool injection.** The reviewer wrapper rejects any input passed through that doesn't match the diff schema. The editor cannot ask the reviewer to "also review unrelated files."
- **Supply-chain.** All dependencies are pinned in `package.json` (TypeScript side) and in CDK lock files (CDK side) per Requirement 10.5. Renovate or Dependabot is configured to open PRs for updates, but updates land through the same `agent-task` flow with human merge.
- **Logging.** Session logs may contain code diffs and CloudWatch excerpts. They do not contain credentials. CloudWatch group ARNs in the preview are scoped per session and torn down on PR close.

## Testing Strategy

### Test layers, mapped to requirements

| Layer | What it covers | Examples |
|---|---|---|
| Unit tests (Jest) | Tool wrappers, schema validators, oscillation detector, session-update logic | "writeFile rejects path outside module"; "oscillation detector trips on identical diffs" |
| Sensor self-tests | Each sensor produces the contracted output shape on a fixture | "cdk-nag fixture with HTTPS-only violation produces expected finding format" |
| Reference module CDK assertions | The reference module synthesises and the assertions tests pass | "FanoutStack creates the expected resources with the expected encryption" |
| Agent integration tests | Editor + reviewer + sensors + mock AgentCore session, against a recorded fixture trigger | "feature-change trigger 'add DLQ' converges in ≤ 3 iterations on the reference module" |
| Live-fire smoke tests | Real AgentCore, real preview environment, scripted trigger | One per release; documented in runbook |

The agent integration tests use a recorded-trace harness so the loop can be replayed without burning model tokens on every CI run. Live-fire is gated and runs nightly with cost alarms.

### Coverage targets

- 100 percent of tool wrappers under unit tests (the wrappers are the security and correctness boundary).
- 100 percent of stop conditions exercised by tests.
- ≥ 80 percent line coverage on agent and harness code overall, excluding generated code and the CDK module itself (which is exercised by the integration tests instead).

### Acceptance gating

Before a release tag, all of the following must be green:

1. Unit and property-based tests pass.
2. Sensor self-tests pass on the reference fixtures.
3. Reference module synthesises and `cdk-nag` produces the expected baseline findings.
4. Agent integration tests converge on the recorded fixture triggers within their iteration caps.
5. One live-fire smoke test of each trigger type (Task 1 only here; Task 2's added in `fitness-gap-loop`) opens a successful PR end-to-end against a clean preview environment.

### Decisions deliberately deferred

A few design choices the requirements name but the design intentionally leaves to implementation, with rationale:

- **Action implementation language.** TypeScript or Bash is fine. Implementation pick happens in `tasks.md`.
- **Reviewer reference checklist storage.** S3 vs. embedded in repo. Lean toward embedded for forkability; revisited if checklist content grows.
- **Cost-counter granularity.** Per-tool-call vs. per-iteration aggregation. Per-iteration is sufficient for the cap check; per-call is nicer for runbook diagnostics. Implementation choice.
- **Live-fire smoke-test schedule.** Nightly vs. weekly vs. release-only. To be set after first measurement of cost envelope.

## Correctness Properties

The bounded loop's correctness depends on a small number of invariants that must hold across all sensor and trigger inputs. These are encoded as property-based tests so they fail loudly when violated, regardless of which iteration or stop condition they appear in.

### Property 1: Trust gate ordering

**Validates: Requirements 7.1, 7.2**

For any sequence of sensor outputs in a session trace, the loop visits gates in the order: computational sensors → inferential reviewer → cdk deploy → post-deploy harness. The agent cannot reach a later gate without passing the earlier ones in the same iteration.

Statement: `forall sensorOutputs. gateSequence(loopRun(sensorOutputs)).isOrdered([computational, reviewer, deploy, postDeploy])`.

Why it matters: if a forker accidentally rewires the loop and the reviewer runs after deploy, the trust-gate guarantees in Requirement 7 are silently broken. Encoding the order as a property makes that breakage detectable.

### Property 2: Stop-condition exclusivity

**Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6**

For any session trace, exactly one termination reason fires. The agent cannot terminate as both `success` and `iteration-cap`, or any other combination.

Statement: `forall sensorOutputs. count(loopRun(sensorOutputs).termination.reasons) == 1`.

Why it matters: stop conditions in Requirement 8 are mutually exclusive by intent; the property test prevents an implementation drift where, say, a success path and an iteration-cap path both fire and the PR description becomes incoherent.

### Property 3: Iteration cap honesty

**Validates: Requirements 8.2**

The loop never exceeds `limits.iterationCap` iterations regardless of sensor outputs.

Statement: `forall sensorOutputs. length(loopRun(sensorOutputs).iterations) <= limits.iterationCap`.

Why it matters: the iteration cap is the simplest backstop against a runaway loop. If the cap can be silently bypassed (e.g., by a sensor failure that resets a counter), every other operational guarantee in Requirement 8 weakens.

### Property 4: Path scoping

**Validates: Requirements 2.3, 9.1, 9.2**

No `module.writeFile` call lands a write outside `module.path`, regardless of input.

Statement: `forall pathArg. writeFile(pathArg).effect == none if not pathArg.startsWith(module.path)`.

Why it matters: the editor's tool catalogue restricts writes to the module path (Requirement 2.3). Encoding path scoping as a property catches the case where a forker adds a tool that bypasses the wrapper, or where a clever input pattern (relative paths, `..`, symlinks) sneaks past the validator.

### Property 5: No autonomous merge

**Validates: Requirements 2.3, 7.4, 9.3**

For any session trace, no PR is merged by the agent. PR merge is reachable only via the human GitHub UI action.

Statement: `forall sensorOutputs. loopRun(sensorOutputs).prMergeEvents.fromAgent.length == 0`.

Why it matters: this is the post's load-bearing trust claim about the bounded loop. If a future tool or a future Bedrock action grants the agent merge capability, the property test fails before the regression ships.

These five properties cover the trust gates the requirements name. Additional properties may emerge as the implementation lands and edge cases surface; the test harness is designed to grow.
