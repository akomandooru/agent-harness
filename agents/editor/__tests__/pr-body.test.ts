/**
 * Snapshot tests for the editor's PR body renderers.
 *
 * Covers the verification matrix from tasks.md task 6.3:
 *
 *   - `renderSuccessPRBody` produces the success template's structure
 *     for a clean converged session.
 *   - `renderPartialPRBody` produces the partial template's structure
 *     for each non-success termination reason: iteration-cap,
 *     wall-clock-cap, token-cap, kill-switch, oscillation.
 *   - The renderers reject misuse (success renderer on partial session,
 *     partial renderer on success session, missing required fields).
 *
 * Snapshots are inline (`toMatchInlineSnapshot`) so the expected output
 * is visible at the call site. A reader reviewing this test sees the
 * exact markdown the renderers produce, which is the strongest form of
 * documentation for a contract whose primary consumer is humans (the
 * PR description on a GitHub PR is read by reviewers, not parsed by
 * machines).
 */

import {
  renderPartialPRBody,
  renderSuccessPRBody,
  type GapClosureView,
  type SessionView,
  type SessionViewFileChange,
  type SessionViewSensors,
  type TerminationReason,
} from "../pr-body";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * Build a synthetic `SessionView` keyed off a termination reason. The
 * default values are tuned so the success and partial fixtures can
 * share most of their shape: only the termination reason, the session
 * log presence (link vs. inline), and the sensor results vary.
 *
 * Tests override the fields they care about via the `overrides` object
 * so each fixture documents the smallest delta from the baseline.
 */
function makeSessionView(
  reason: TerminationReason,
  overrides: Partial<SessionView> = {},
): SessionView {
  const baseline: SessionView = {
    trigger: {
      issue: {
        number: 42,
        title: "Add a dead-letter queue to the SQS subscriber",
        url: "https://github.com/test-org/agent-harness/issues/42",
      },
      module: {
        path: "modules/fanout",
        commitSha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
      },
      session: { id: "session-test-abc" },
      limits: { iterationCap: 5 },
    },
    iterationCount: 3,
    summary:
      "Added a dead-letter queue to the SQS subscriber and wired it " +
      "into the existing queue policy. Quotes the AGENTS.md rule on " +
      "DLQ requirements for SQS subscribers.",
    fileChanges: [
      {
        path: "lib/fanout-stack.ts",
        additions: 18,
        deletions: 2,
        summary: "Add DLQ construct and wire onto SQS queue.",
      },
      {
        path: "test/fanout-stack.test.ts",
        additions: 12,
        deletions: 0,
        summary: "Assert DLQ construct exists with the expected encryption.",
      },
    ],
    sensors: makeAllPassedSensors(),
    postDeploy: {
      outcome: "pass",
      reportSummary:
        "API Gateway -> SNS -> SQS -> EgressFn flow completed in " +
        "1.4s with KMS encryption observed on the queue.",
    },
    previewLink:
      "https://us-east-1.console.aws.amazon.com/cloudformation/home" +
      "?region=us-east-1#/stacks?filteringText=session-test-abc",
    sessionLogLink:
      "https://github.com/test-org/agent-harness/blob/agent/" +
      "session-test-abc/.agent/session-test-abc.json",
    sessionLogText:
      "iteration 0: edit applied, sensors green, deploy ok, postDeploy fail\n" +
      "iteration 1: edit applied, sensors green, deploy ok, postDeploy fail\n" +
      "iteration 2: edit applied, sensors green, deploy ok, postDeploy fail",
    termination: { reason },
  };
  return { ...baseline, ...overrides };
}

/** Sensors fixture for a passing final iteration. */
function makeAllPassedSensors(): SessionViewSensors {
  return {
    tsc: { passed: true, errorCount: 0 },
    eslint: { passed: true, errorCount: 0, warningCount: 0 },
    unitTests: {
      passed: true,
      passCount: 12,
      failCount: 0,
      skipCount: 0,
    },
    cdkNag: { passed: true, errorCount: 0, warningCount: 0 },
    reviewer: {
      passed: true,
      findingCount: 0,
      severityCounts: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        info: 0,
      },
    },
  };
}

/** Sensors fixture for a final iteration where things were still failing. */
function makeMixedSensors(): SessionViewSensors {
  return {
    tsc: { passed: true, errorCount: 0 },
    eslint: { passed: true, errorCount: 0, warningCount: 2 },
    unitTests: {
      passed: false,
      passCount: 10,
      failCount: 2,
      skipCount: 1,
    },
    cdkNag: { passed: false, errorCount: 1, warningCount: 3 },
    reviewer: {
      passed: false,
      findingCount: 2,
      severityCounts: {
        critical: 0,
        high: 1,
        medium: 1,
        low: 0,
        info: 0,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Success variant
// ---------------------------------------------------------------------------

describe("renderSuccessPRBody", () => {
  test("renders a clean converged session", () => {
    const view = makeSessionView("success");
    const body = renderSuccessPRBody(view);

    expect(body).toMatchInlineSnapshot(`
"## Trigger

- Issue: [#42](https://github.com/test-org/agent-harness/issues/42) — Add a dead-letter queue to the SQS subscriber
- Module: \`modules/fanout\` (ref \`ec26c3e57ca3a959ca5aad62de7213c562f8c821\`)
- Session: \`session-test-abc\`
- Iterations: 3 of 5

## Summary of changes

Added a dead-letter queue to the SQS subscriber and wired it into the existing queue policy. Quotes the AGENTS.md rule on DLQ requirements for SQS subscribers.

## File changes

- \`lib/fanout-stack.ts\` (+18/-2): Add DLQ construct and wire onto SQS queue.
- \`test/fanout-stack.test.ts\` (+12/-0): Assert DLQ construct exists with the expected encryption.

## Sensor results

| Sensor | Result | Findings |
| --- | --- | --- |
| \`sensor.tsc\` | :white_check_mark: pass | 0 error(s) |
| \`sensor.eslint\` | :white_check_mark: pass | 0 error(s), 0 warning(s) |
| \`sensor.unitTests\` | :white_check_mark: pass | 12 passed, 0 failed, 0 skipped |
| \`sensor.cdkNag\` | :white_check_mark: pass | 0 error(s), 0 warning(s) |
| \`reviewer.invoke\` | :white_check_mark: pass | 0 finding(s); severities: none |

## Post-deploy harness

- Outcome: **pass**
- Report: API Gateway -> SNS -> SQS -> EgressFn flow completed in 1.4s with KMS encryption observed on the queue.

## Preview environment

- https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks?filteringText=session-test-abc

## Session log

- https://github.com/test-org/agent-harness/blob/agent/session-test-abc/.agent/session-test-abc.json

---

_Opened by the agent harness editor agent. A human merges; the agent does not._
"
`);
  });

  test("renders zero file changes with a placeholder line", () => {
    // Edge case: a converged session that produced no file edits is
    // unusual but not impossible (the reference module already
    // satisfied the trigger; the agent's contribution was confirming
    // the deploy still worked). The renderer surfaces this rather
    // than producing an empty section.
    const view = makeSessionView("success", { fileChanges: [] });
    const body = renderSuccessPRBody(view);

    expect(body).toContain("## File changes\n\n_No file changes recorded._");
  });

  test("ends with exactly one trailing newline", () => {
    const view = makeSessionView("success");
    const body = renderSuccessPRBody(view);
    expect(body.endsWith("\n")).toBe(true);
    expect(body.endsWith("\n\n")).toBe(false);
  });

  test("rejects a non-success termination reason", () => {
    const view = makeSessionView("iteration-cap");
    expect(() => renderSuccessPRBody(view)).toThrow(/expected.*"success"/);
  });

  test("rejects a session view missing the session log link", () => {
    const view = makeSessionView("success", { sessionLogLink: undefined });
    expect(() => renderSuccessPRBody(view)).toThrow(/sessionLogLink/);
  });
});

// ---------------------------------------------------------------------------
// Partial variant
// ---------------------------------------------------------------------------

describe("renderPartialPRBody", () => {
  test("renders an iteration-cap termination", () => {
    const view = makeSessionView("iteration-cap", {
      iterationCount: 5,
      sensors: makeMixedSensors(),
      postDeploy: {
        outcome: "fail",
        reportSummary:
          "Synthetic request reached SNS; downstream EgressFn never " +
          "received the message within the 30s timeout.",
      },
    });
    const body = renderPartialPRBody(view);

    expect(body).toMatchInlineSnapshot(`
"> :warning: **Did not finish: did not converge.** The agent reached the iteration cap before the post-deploy harness passed.

## Trigger

- Issue: [#42](https://github.com/test-org/agent-harness/issues/42) — Add a dead-letter queue to the SQS subscriber
- Module: \`modules/fanout\` (ref \`ec26c3e57ca3a959ca5aad62de7213c562f8c821\`)
- Session: \`session-test-abc\`
- Iterations: 5 of 5

## Summary of attempted changes

Added a dead-letter queue to the SQS subscriber and wired it into the existing queue policy. Quotes the AGENTS.md rule on DLQ requirements for SQS subscribers.

## File changes

- \`lib/fanout-stack.ts\` (+18/-2): Add DLQ construct and wire onto SQS queue.
- \`test/fanout-stack.test.ts\` (+12/-0): Assert DLQ construct exists with the expected encryption.

## Sensor results (final iteration)

| Sensor | Result | Findings |
| --- | --- | --- |
| \`sensor.tsc\` | :white_check_mark: pass | 0 error(s) |
| \`sensor.eslint\` | :white_check_mark: pass | 0 error(s), 2 warning(s) |
| \`sensor.unitTests\` | :x: fail | 10 passed, 2 failed, 1 skipped |
| \`sensor.cdkNag\` | :x: fail | 1 error(s), 3 warning(s) |
| \`reviewer.invoke\` | :x: fail | 2 finding(s); severities: high: 1, medium: 1 |

## Post-deploy harness

- Outcome: **fail**
- Report: Synthetic request reached SNS; downstream EgressFn never received the message within the 30s timeout.

## Preview environment

- https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks?filteringText=session-test-abc

## Recommended next step

Review the embedded session log to see where the agent stalled. Either pick the iteration with the cleanest state and continue manually, or refine the issue and re-apply the \`agent-task\` label to start a fresh session.

## Session log (embedded)

\`\`\`
iteration 0: edit applied, sensors green, deploy ok, postDeploy fail
iteration 1: edit applied, sensors green, deploy ok, postDeploy fail
iteration 2: edit applied, sensors green, deploy ok, postDeploy fail
\`\`\`

---

_Opened by the agent harness editor agent on a partial termination. A human picks up from here._
"
`);
  });

  test("renders a kill-switch termination", () => {
    // Kill-switch differs from iteration-cap in three places: the
    // banner label and narrative, the recommended next step, and (in
    // practice) the iterationCount, which is wherever the loop was
    // when the human stopped it. Use a cleaner sensor state to
    // exercise that path through the table.
    const view = makeSessionView("kill-switch", {
      iterationCount: 2,
      sensors: makeAllPassedSensors(),
      postDeploy: {
        outcome: "pass",
        reportSummary:
          "Last completed iteration's post-deploy result before the " +
          "operator halted the loop.",
      },
      sessionLogText:
        "iteration 0: edit applied, sensors green, deploy ok, postDeploy pass\n" +
        "iteration 1: edit applied, sensors green, deploy ok, postDeploy pass\n" +
        "<halted by agent-stop label>",
    });
    const body = renderPartialPRBody(view);

    expect(body).toMatchInlineSnapshot(`
"> :warning: **Did not finish: kill switch.** A human applied the \`agent-stop\` label and the loop halted immediately.

## Trigger

- Issue: [#42](https://github.com/test-org/agent-harness/issues/42) — Add a dead-letter queue to the SQS subscriber
- Module: \`modules/fanout\` (ref \`ec26c3e57ca3a959ca5aad62de7213c562f8c821\`)
- Session: \`session-test-abc\`
- Iterations: 2 of 5

## Summary of attempted changes

Added a dead-letter queue to the SQS subscriber and wired it into the existing queue policy. Quotes the AGENTS.md rule on DLQ requirements for SQS subscribers.

## File changes

- \`lib/fanout-stack.ts\` (+18/-2): Add DLQ construct and wire onto SQS queue.
- \`test/fanout-stack.test.ts\` (+12/-0): Assert DLQ construct exists with the expected encryption.

## Sensor results (final iteration)

| Sensor | Result | Findings |
| --- | --- | --- |
| \`sensor.tsc\` | :white_check_mark: pass | 0 error(s) |
| \`sensor.eslint\` | :white_check_mark: pass | 0 error(s), 0 warning(s) |
| \`sensor.unitTests\` | :white_check_mark: pass | 12 passed, 0 failed, 0 skipped |
| \`sensor.cdkNag\` | :white_check_mark: pass | 0 error(s), 0 warning(s) |
| \`reviewer.invoke\` | :white_check_mark: pass | 0 finding(s); severities: none |

## Post-deploy harness

- Outcome: **pass**
- Report: Last completed iteration's post-deploy result before the operator halted the loop.

## Preview environment

- https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks?filteringText=session-test-abc

## Recommended next step

A human applied the \`agent-stop\` label. Resolve whatever prompted the kill switch (review the session log for the agent's last actions), then remove the \`agent-stop\` label and re-apply \`agent-task\` to retry.

## Session log (embedded)

\`\`\`
iteration 0: edit applied, sensors green, deploy ok, postDeploy pass
iteration 1: edit applied, sensors green, deploy ok, postDeploy pass
<halted by agent-stop label>
\`\`\`

---

_Opened by the agent harness editor agent on a partial termination. A human picks up from here._
"
`);
  });

  test("renders an oscillation termination", () => {
    // Oscillation produces a different banner narrative and a
    // different recommended next step: the suggested fix is to refine
    // the issue or steering, not to retry verbatim.
    const view = makeSessionView("oscillation", {
      iterationCount: 4,
      sensors: makeMixedSensors(),
      postDeploy: {
        outcome: "fail",
        reportSummary:
          "Same post-deploy failure observed on iterations 2 and 4 " +
          "with identical diffs.",
      },
      sessionLogText:
        "iteration 0: edit A, sensors green, postDeploy fail\n" +
        "iteration 1: edit B, sensors green, postDeploy fail\n" +
        "iteration 2: edit A, sensors green, postDeploy fail\n" +
        "iteration 3: edit B, sensors green, postDeploy fail\n" +
        "<oscillation detector tripped: alternation window=4>",
    });
    const body = renderPartialPRBody(view);

    expect(body).toMatchInlineSnapshot(`
"> :warning: **Did not finish: oscillation.** The oscillation detector tripped: the agent produced the same edit twice in three iterations or alternated between two states across four.

## Trigger

- Issue: [#42](https://github.com/test-org/agent-harness/issues/42) — Add a dead-letter queue to the SQS subscriber
- Module: \`modules/fanout\` (ref \`ec26c3e57ca3a959ca5aad62de7213c562f8c821\`)
- Session: \`session-test-abc\`
- Iterations: 4 of 5

## Summary of attempted changes

Added a dead-letter queue to the SQS subscriber and wired it into the existing queue policy. Quotes the AGENTS.md rule on DLQ requirements for SQS subscribers.

## File changes

- \`lib/fanout-stack.ts\` (+18/-2): Add DLQ construct and wire onto SQS queue.
- \`test/fanout-stack.test.ts\` (+12/-0): Assert DLQ construct exists with the expected encryption.

## Sensor results (final iteration)

| Sensor | Result | Findings |
| --- | --- | --- |
| \`sensor.tsc\` | :white_check_mark: pass | 0 error(s) |
| \`sensor.eslint\` | :white_check_mark: pass | 0 error(s), 2 warning(s) |
| \`sensor.unitTests\` | :x: fail | 10 passed, 2 failed, 1 skipped |
| \`sensor.cdkNag\` | :x: fail | 1 error(s), 3 warning(s) |
| \`reviewer.invoke\` | :x: fail | 2 finding(s); severities: high: 1, medium: 1 |

## Post-deploy harness

- Outcome: **fail**
- Report: Same post-deploy failure observed on iterations 2 and 4 with identical diffs.

## Preview environment

- https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks?filteringText=session-test-abc

## Recommended next step

The agent kept producing the same edit or alternating between two states. The trigger may be ambiguous or the module may need a steering-file update before the agent can converge. Review the embedded session log for the repeated edits, then refine the issue or \`AGENTS.md\` and start a fresh session.

## Session log (embedded)

\`\`\`
iteration 0: edit A, sensors green, postDeploy fail
iteration 1: edit B, sensors green, postDeploy fail
iteration 2: edit A, sensors green, postDeploy fail
iteration 3: edit B, sensors green, postDeploy fail
<oscillation detector tripped: alternation window=4>
\`\`\`

---

_Opened by the agent harness editor agent on a partial termination. A human picks up from here._
"
`);
  });

  test("renders a wall-clock-cap termination with the right banner", () => {
    const view = makeSessionView("wall-clock-cap");
    const body = renderPartialPRBody(view);
    expect(body).toContain("**Did not finish: timed out.**");
    expect(body).toContain(
      "The agent reached the wall-clock cap before the post-deploy harness passed.",
    );
    expect(body).toContain(
      "The agent ran out of wall-clock time. If the trigger is still relevant",
    );
  });

  test("renders a token-cap termination with the right banner", () => {
    const view = makeSessionView("token-cap");
    const body = renderPartialPRBody(view);
    expect(body).toContain("**Did not finish: cost cap reached.**");
    expect(body).toContain(
      "The agent reached the token-spend cap before the post-deploy harness passed.",
    );
    expect(body).toContain(
      "Review the embedded session log for cost breakdown",
    );
  });

  test("uses the orchestrator-supplied recommended next step when provided", () => {
    // The orchestrator can override the default by supplying
    // `recommendedNextStep`. The runbook will commonly want to do this
    // (reason-specific guidance is more useful than generic).
    const customStep =
      "See `docs/runbook.md#oscillation-on-fanout` for the team's " +
      "playbook; rerun against `main` rather than the iteration branch.";
    const view = makeSessionView("oscillation", {
      termination: {
        reason: "oscillation",
        recommendedNextStep: customStep,
      },
    });
    const body = renderPartialPRBody(view);
    expect(body).toContain(`## Recommended next step\n\n${customStep}`);
    // The default text for oscillation is NOT present.
    expect(body).not.toContain("The agent kept producing the same edit");
  });

  test("rejects a success termination", () => {
    const view = makeSessionView("success");
    expect(() => renderPartialPRBody(view)).toThrow(/'success'/);
  });

  test("rejects a session view missing the embedded session log text", () => {
    const view = makeSessionView("iteration-cap", {
      sessionLogText: undefined,
    });
    expect(() => renderPartialPRBody(view)).toThrow(/sessionLogText/);
  });

  test("ends with exactly one trailing newline", () => {
    const view = makeSessionView("iteration-cap");
    const body = renderPartialPRBody(view);
    expect(body.endsWith("\n")).toBe(true);
    expect(body.endsWith("\n\n")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sensor table
// ---------------------------------------------------------------------------

describe("sensor table formatting", () => {
  test("orders reviewer severities by severity (critical -> info), omits zero counts", () => {
    const view = makeSessionView("success", {
      sensors: {
        ...makeAllPassedSensors(),
        reviewer: {
          passed: false,
          findingCount: 4,
          severityCounts: {
            // Pass deliberately out of severity-priority order to make
            // sure the renderer sorts rather than echoing the input.
            info: 1,
            critical: 1,
            low: 0,
            high: 2,
            medium: 0,
          },
        },
      },
    });
    const body = renderSuccessPRBody(view);
    expect(body).toContain(
      "severities: critical: 1, high: 2, info: 1",
    );
    expect(body).not.toContain("low: 0");
    expect(body).not.toContain("medium: 0");
  });

  test("renders 'severities: none' when every count is zero", () => {
    const view = makeSessionView("success");
    const body = renderSuccessPRBody(view);
    expect(body).toContain("severities: none");
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("renderer determinism", () => {
  test("renderSuccessPRBody is pure: same view -> same string", () => {
    const view = makeSessionView("success");
    const a = renderSuccessPRBody(view);
    const b = renderSuccessPRBody(view);
    expect(a).toBe(b);
  });

  test("renderPartialPRBody is pure: same view -> same string", () => {
    const view = makeSessionView("iteration-cap");
    const a = renderPartialPRBody(view);
    const b = renderPartialPRBody(view);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Type-level smoke
// ---------------------------------------------------------------------------

describe("SessionViewFileChange typing", () => {
  // Type-only sanity: confirms the exported types are usable from
  // outside the module. A failure here is a build error, not a runtime
  // assertion, but having the test in the file documents the intent.
  test("file change shape compiles", () => {
    const change: SessionViewFileChange = {
      path: "lib/fanout-stack.ts",
      additions: 1,
      deletions: 1,
      summary: "irrelevant",
    };
    expect(change.path).toBe("lib/fanout-stack.ts");
  });
});

// ---------------------------------------------------------------------------
// Gap-closure section (Requirement 4.5)
// ---------------------------------------------------------------------------

/** Canonical gap-closure fixture for fitness-gap tests. */
function makeGapClosureView(): GapClosureView {
  return {
    originatingFinding: {
      id: "WA-SEC-02",
      description: "SNS topic does not enforce HTTPS-only",
      severity: "high",
      pillar: "Security",
    },
    gapId: "WA-SEC-02",
    probeMethod: "sns:GetTopicAttributes",
    evidenceSummary:
      "SNS topic policy contains Deny on aws:SecureTransport=false",
    previewEnvId: "preview-session-test-abc",
    verifiedAt: "2025-01-15T06:30:00Z",
  };
}

describe("gap-closure section in renderSuccessPRBody", () => {
  test("includes the gap-closure section when triggerType is fitness-gap and gapClosure is present", () => {
    const view = makeSessionView("success", {
      triggerType: "fitness-gap",
      gapClosure: makeGapClosureView(),
    });
    const body = renderSuccessPRBody(view);

    expect(body).toMatchInlineSnapshot(`
"## Trigger

- Issue: [#42](https://github.com/test-org/agent-harness/issues/42) — Add a dead-letter queue to the SQS subscriber
- Module: \`modules/fanout\` (ref \`ec26c3e57ca3a959ca5aad62de7213c562f8c821\`)
- Session: \`session-test-abc\`
- Iterations: 3 of 5

## Summary of changes

Added a dead-letter queue to the SQS subscriber and wired it into the existing queue policy. Quotes the AGENTS.md rule on DLQ requirements for SQS subscribers.

## File changes

- \`lib/fanout-stack.ts\` (+18/-2): Add DLQ construct and wire onto SQS queue.
- \`test/fanout-stack.test.ts\` (+12/-0): Assert DLQ construct exists with the expected encryption.

## Sensor results

| Sensor | Result | Findings |
| --- | --- | --- |
| \`sensor.tsc\` | :white_check_mark: pass | 0 error(s) |
| \`sensor.eslint\` | :white_check_mark: pass | 0 error(s), 0 warning(s) |
| \`sensor.unitTests\` | :white_check_mark: pass | 12 passed, 0 failed, 0 skipped |
| \`sensor.cdkNag\` | :white_check_mark: pass | 0 error(s), 0 warning(s) |
| \`reviewer.invoke\` | :white_check_mark: pass | 0 finding(s); severities: none |

## Post-deploy harness

- Outcome: **pass**
- Report: API Gateway -> SNS -> SQS -> EgressFn flow completed in 1.4s with KMS encryption observed on the queue.

## Gap closure

**Originating finding:** WA-SEC-02 — SNS topic does not enforce HTTPS-only
**Severity:** high
**Pillar:** Security

### Verification

The gap-closure check probed the deployed preview environment directly:

| Check | Method | Result |
|---|---|---|
| WA-SEC-02 | sns:GetTopicAttributes | ✅ Closed |

**Evidence:** SNS topic policy contains Deny on aws:SecureTransport=false

*Verified against preview environment \`preview-session-test-abc\` at 2025-01-15T06:30:00Z.*

## Preview environment

- https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks?filteringText=session-test-abc

## Session log

- https://github.com/test-org/agent-harness/blob/agent/session-test-abc/.agent/session-test-abc.json

---

_Opened by the agent harness editor agent. A human merges; the agent does not._
"
`);
  });

  test("omits the gap-closure section when triggerType is feature-change", () => {
    const view = makeSessionView("success", {
      triggerType: "feature-change",
      gapClosure: makeGapClosureView(),
    });
    const body = renderSuccessPRBody(view);
    expect(body).not.toContain("## Gap closure");
    expect(body).not.toContain("WA-SEC-02");
  });

  test("omits the gap-closure section when triggerType is absent", () => {
    const view = makeSessionView("success", {
      // triggerType intentionally omitted
      gapClosure: makeGapClosureView(),
    });
    const body = renderSuccessPRBody(view);
    expect(body).not.toContain("## Gap closure");
  });

  test("omits the gap-closure section when gapClosure is null", () => {
    const view = makeSessionView("success", {
      triggerType: "fitness-gap",
      gapClosure: null,
    });
    const body = renderSuccessPRBody(view);
    expect(body).not.toContain("## Gap closure");
  });

  test("omits the gap-closure section when gapClosure is undefined", () => {
    const view = makeSessionView("success", {
      triggerType: "fitness-gap",
      gapClosure: undefined,
    });
    const body = renderSuccessPRBody(view);
    expect(body).not.toContain("## Gap closure");
  });

  test("gap-closure section appears between post-deploy and preview sections", () => {
    const view = makeSessionView("success", {
      triggerType: "fitness-gap",
      gapClosure: makeGapClosureView(),
    });
    const body = renderSuccessPRBody(view);
    const postDeployPos = body.indexOf("## Post-deploy harness");
    const gapClosurePos = body.indexOf("## Gap closure");
    const previewPos = body.indexOf("## Preview environment");
    expect(postDeployPos).toBeLessThan(gapClosurePos);
    expect(gapClosurePos).toBeLessThan(previewPos);
  });
});
