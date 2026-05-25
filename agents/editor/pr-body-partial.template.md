<!--
  Partial PR body template (reference, not executed).

  This file documents the markdown the editor agent's partial paths
  render via `renderPartialPRBody(session)` in `agents/editor/pr-body.ts`.
  The renderer does not parse this file: it builds the body
  programmatically from a `SessionView`, so a forker who wants to change
  the format edits `pr-body.ts` and updates this file (and the snapshot
  tests in `__tests__/pr-body.test.ts`) to match.

  The placeholder vocabulary (`{{key}}` and `{{#each}}`) is illustrative.
  It mirrors the fields on `SessionView` so a reader cross-referencing
  `pr-body.ts` can match each placeholder to its source.

  Variant: partial.
  Used when: the loop terminated for any reason other than `success`:
  - `iteration-cap`  -> "did not converge"
  - `wall-clock-cap` -> "timed out"
  - `token-cap`      -> "cost cap reached"
  - `kill-switch`    -> "kill switch"
  - `oscillation`    -> "oscillation"
  The session log is embedded inline (not just linked) so a human
  reviewer can see the full per-iteration history without leaving the PR.
-->

> :warning: **Did not finish: {{terminationReasonLabel}}.** {{terminationReasonNarrative}}

## Trigger

- Issue: [#{{trigger.issue.number}}]({{trigger.issue.url}}) — {{trigger.issue.title}}
- Module: `{{trigger.module.path}}` (ref `{{trigger.module.commitSha}}`)
- Session: `{{trigger.session.id}}`
- Iterations: {{iterationCount}} of {{trigger.limits.iterationCap}}

## Summary of attempted changes

{{summary}}

## File changes

{{#each fileChanges}}
- `{{path}}` ({{additions}}/-{{deletions}}): {{summary}}
{{/each}}

## Sensor results (final iteration)

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

## Preview environment

- {{previewLink}}

## Recommended next step

{{recommendedNextStep}}

## Session log (embedded)

```
{{sessionLogText}}
```

---

_Opened by the agent harness editor agent on a partial termination. A human picks up from here._
