<!--
  Success PR body template (reference, not executed).

  This file documents the markdown the editor agent's success path renders
  via `renderSuccessPRBody(session)` in `agents/editor/pr-body.ts`. The
  renderer does not parse this file: it builds the body programmatically
  from a `SessionView`, so a forker who wants to change the format edits
  `pr-body.ts` and updates this file (and the snapshot tests in
  `__tests__/pr-body.test.ts`) to match.

  The placeholder vocabulary (`{{key}}` and `{{#each}}`) is illustrative.
  It mirrors the fields on `SessionView` so a reader cross-referencing
  `pr-body.ts` can match each placeholder to its source.

  Variant: success.
  Used when: the post-deploy harness returned `pass` and the editor
  agent opened the PR via `pr.open` with `termination.reason: "success"`.
  See the partial variant in `pr-body-partial.template.md` for the
  did-not-converge / timed-out / cost-cap / kill-switch / oscillation
  paths.
-->

## Trigger

- Issue: [#{{trigger.issue.number}}]({{trigger.issue.url}}) — {{trigger.issue.title}}
- Module: `{{trigger.module.path}}` (ref `{{trigger.module.commitSha}}`)
- Session: `{{trigger.session.id}}`
- Iterations: {{iterationCount}} of {{trigger.limits.iterationCap}}

## Summary of changes

{{summary}}

## File changes

{{#each fileChanges}}
- `{{path}}` ({{additions}}/-{{deletions}}): {{summary}}
{{/each}}

## Sensor results

| Sensor | Result | Findings |
| --- | --- | --- |
| `sensor.tsc` | {{sensorResultLabel tsc}} | {{tsc.errorCount}} error(s) |
| `sensor.eslint` | {{sensorResultLabel eslint}} | {{eslint.errorCount}} error(s), {{eslint.warningCount}} warning(s) |
| `sensor.unitTests` | {{sensorResultLabel unitTests}} | {{unitTests.passCount}} passed, {{unitTests.failCount}} failed, {{unitTests.skipCount}} skipped |
| `sensor.cdkNag` | {{sensorResultLabel cdkNag}} | {{cdkNag.errorCount}} error(s), {{cdkNag.warningCount}} warning(s) |
| `reviewer.invoke` | {{sensorResultLabel reviewer}} | {{reviewer.findingCount}} finding(s); severities: {{reviewer.severityCountsLine}} |

## Post-deploy harness

- Outcome: **{{postDeploy.outcome}}**
- Report: {{postDeploy.reportSummary}}

<!--
  Gap-closure section — present only for `fitness-gap` triggers.
  Omitted entirely for `feature-change` triggers.
  The renderer (`pr-body.ts` → `pushGapClosureSection`) checks
  `session.trigger.triggerType` and skips this section when the
  trigger type is `feature-change`.
-->
## Gap closure

**Originating finding:** {{originatingFinding.id}} — {{originatingFinding.description}}
**Severity:** {{originatingFinding.severity}}
**Pillar:** {{originatingFinding.pillar}}

### Verification

The gap-closure check probed the deployed preview environment directly:

| Check | Method | Result |
| --- | --- | --- |
| {{gapClosure.gapId}} | {{gapClosure.probeMethod}} | ✅ Closed |

**Evidence:** {{gapClosure.evidenceSummary}}

*Verified against preview environment `{{stackOutputs.previewEnvId}}` at {{gapClosure.verifiedAt}}.*

## Preview environment

- {{previewLink}}

## Session log

- {{sessionLogLink}}

---

_Opened by the agent harness editor agent. A human merges; the agent does not._
