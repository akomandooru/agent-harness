/**
 * Unit tests for the session-update logic.
 *
 * Covers the verification matrix called out in tasks.md task 7.1:
 *
 *   - append iteration adds to `iterations[]` with the correct index
 *   - terminate writes the termination record with the right reason and `endedAt`
 *   - redact: the trigger payload's `auth.githubInstallationToken` is
 *     `[REDACTED]` in the stored session
 *   - read-back roundtrip: write a session through `InMemorySessionStore`,
 *     read it back, confirm the structure matches
 *   - cost updates accumulate correctly
 *   - SessionUpdater implements `SessionSink`: tool records land in the
 *     current iteration
 *
 * Tests use deterministic timestamps via the updater's `now` injection so
 * snapshots and equality checks are stable.
 */

import type { ToolInvocationRecord } from "@agent-harness/shared";

import {
  AgentCoreSessionStore,
  InMemorySessionStore,
  SessionUpdater,
  createSessionFromTrigger,
  type Session,
  type SessionTrigger,
} from "../src/session";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = "2024-01-01T00:00:00.000Z";

/**
 * Build a fresh trigger payload for each test. The constants live in a
 * factory rather than a top-level so tests cannot mutate one another's
 * fixtures by accident (the trigger is a deeply nested object; a bare
 * shared instance would be fragile).
 */
function buildTrigger(overrides: Partial<SessionTrigger> = {}): SessionTrigger {
  return {
    schemaVersion: "1.0",
    triggerType: "feature-change",
    issue: {
      number: 42,
      title: "Add a dead-letter queue to the SQS subscriber",
      body: "Add a DLQ.",
      url: "https://github.com/example/repo/issues/42",
      openedBy: "alice",
    },
    module: {
      path: "modules/fanout",
      repository: "example/repo",
      ref: "main",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    },
    session: {
      id: "session-test-001",
      createdAt: "2024-01-01T00:00:00.000Z",
    },
    limits: {
      iterationCap: 5,
      wallClockCapMinutes: 60,
      tokenSpendCapUSD: 10.0,
    },
    auth: {
      githubInstallationToken: "ghs_supersecret_token_value_xyz",
    },
    ...overrides,
  };
}

/**
 * Build a tool invocation record matching the shape the wrapper would
 * produce. Tests mostly care about `iterationIndex` (so the updater
 * routes the record to the right iteration) and the `input` redaction.
 */
function buildToolRecord(
  overrides: Partial<ToolInvocationRecord> = {}
): ToolInvocationRecord {
  return {
    schemaVersion: "1.0",
    sessionId: "session-test-001",
    iterationIndex: 0,
    tool: "module.readFile",
    startedAt: "2024-01-01T00:00:01.000Z",
    endedAt: "2024-01-01T00:00:01.100Z",
    durationMs: 100,
    input: { path: "modules/fanout/lib/fanout-stack.ts" },
    output: { contents: "export class FanoutStack {}", sha: "abc" },
    outcome: "ok",
    ...overrides,
  };
}

/** Make a SessionUpdater wired to a fixed clock so timestamps are stable. */
function makeUpdater(trigger?: SessionTrigger): SessionUpdater {
  const session = createSessionFromTrigger(trigger ?? buildTrigger());
  return new SessionUpdater(session, { now: () => FIXED_NOW });
}

// ---------------------------------------------------------------------------
// createSessionFromTrigger + redaction
// ---------------------------------------------------------------------------

describe("createSessionFromTrigger", () => {
  it("builds a session with empty iterations, null termination, and zero costs", () => {
    const session = createSessionFromTrigger(buildTrigger());

    expect(session.schemaVersion).toBe("1.0");
    expect(session.iterations).toEqual([]);
    expect(session.termination).toBeNull();
    expect(session.costs).toEqual({
      editorTokensUSD: 0,
      reviewerTokensUSD: 0,
      previewInfraUSD: 0,
    });
  });

  it("preserves non-secret trigger fields verbatim", () => {
    const trigger = buildTrigger();
    const session = createSessionFromTrigger(trigger);

    expect(session.trigger.triggerType).toBe(trigger.triggerType);
    expect(session.trigger.issue).toEqual(trigger.issue);
    expect(session.trigger.module).toEqual(trigger.module);
    expect(session.trigger.session).toEqual(trigger.session);
    expect(session.trigger.limits).toEqual(trigger.limits);
  });

  it("redacts auth.githubInstallationToken to the [REDACTED] sentinel", () => {
    const trigger = buildTrigger();
    const session = createSessionFromTrigger(trigger);

    expect(session.trigger.auth.githubInstallationToken).toBe("[REDACTED]");
    // The original trigger object stays untouched (the redact helper
    // deep-clones rather than mutating in place).
    expect(trigger.auth.githubInstallationToken).toBe(
      "ghs_supersecret_token_value_xyz"
    );
  });

  it("does not store the literal token anywhere in the session record", () => {
    const trigger = buildTrigger();
    const session = createSessionFromTrigger(trigger);

    expect(JSON.stringify(session)).not.toContain(
      "ghs_supersecret_token_value_xyz"
    );
  });

  it("redacts arbitrary token-shaped fields a forker may add to auth", () => {
    const trigger = buildTrigger({
      auth: {
        githubInstallationToken: "primary",
        secondaryToken: "secondary-value",
        nonSecretFlag: true,
      },
    });
    const session = createSessionFromTrigger(trigger);

    expect(session.trigger.auth.githubInstallationToken).toBe("[REDACTED]");
    expect(session.trigger.auth.secondaryToken).toBe("[REDACTED]");
    // Non-secret fields pass through.
    expect(session.trigger.auth.nonSecretFlag).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SessionUpdater: appendIteration
// ---------------------------------------------------------------------------

describe("SessionUpdater.appendIteration", () => {
  it("appends a new iteration with index 0 on the first call", () => {
    const updater = makeUpdater();
    const iteration = updater.appendIteration();

    expect(iteration.index).toBe(0);
    expect(iteration.startedAt).toBe(FIXED_NOW);
    expect(iteration.endedAt).toBeNull();
    expect(iteration.edits).toEqual([]);
    expect(iteration.tools).toEqual([]);

    const session = updater.getSession();
    expect(session.iterations).toHaveLength(1);
    expect(session.iterations[0].index).toBe(0);
  });

  it("increments the index on subsequent appends", () => {
    const updater = makeUpdater();
    updater.appendIteration();
    updater.appendIteration();
    const third = updater.appendIteration();

    expect(third.index).toBe(2);
    expect(updater.getSession().iterations.map((it) => it.index)).toEqual([
      0, 1, 2,
    ]);
  });

  it("uses the provided startedAt when given", () => {
    const updater = makeUpdater();
    const iteration = updater.appendIteration({ startedAt: "2025-12-31T23:59:59.000Z" });

    expect(iteration.startedAt).toBe("2025-12-31T23:59:59.000Z");
  });

  it("throws if the session is already terminated", () => {
    const updater = makeUpdater();
    updater.terminate("kill-switch");

    expect(() => updater.appendIteration()).toThrow(/already terminated/);
  });
});

// ---------------------------------------------------------------------------
// SessionUpdater: terminate
// ---------------------------------------------------------------------------

describe("SessionUpdater.terminate", () => {
  it("writes the termination record with the given reason and endedAt", () => {
    const updater = makeUpdater();
    updater.terminate("success", 7);

    const session = updater.getSession();
    expect(session.termination).toEqual({
      reason: "success",
      endedAt: FIXED_NOW,
      prNumber: 7,
    });
  });

  it("defaults prNumber to null when omitted", () => {
    const updater = makeUpdater();
    updater.terminate("oscillation");

    expect(updater.getSession().termination?.prNumber).toBeNull();
  });

  it("supports each terminating reason", () => {
    const reasons: Array<
      | "success"
      | "iteration-cap"
      | "wall-clock-cap"
      | "token-cap"
      | "kill-switch"
      | "oscillation"
    > = [
      "success",
      "iteration-cap",
      "wall-clock-cap",
      "token-cap",
      "kill-switch",
      "oscillation",
    ];
    for (const reason of reasons) {
      const updater = makeUpdater();
      updater.terminate(reason);
      expect(updater.getSession().termination?.reason).toBe(reason);
    }
  });

  it("is idempotent for the same reason and prNumber", () => {
    const updater = makeUpdater();
    updater.terminate("success", 7);
    expect(() => updater.terminate("success", 7)).not.toThrow();
  });

  it("throws if a different termination is already recorded", () => {
    const updater = makeUpdater();
    updater.terminate("iteration-cap");
    expect(() => updater.terminate("success", 7)).toThrow(/already terminated/);
  });

  it("setTerminationPRNumber attaches a PR number after termination", () => {
    const updater = makeUpdater();
    updater.terminate("iteration-cap");
    updater.setTerminationPRNumber(99);

    expect(updater.getSession().termination?.prNumber).toBe(99);
  });

  it("setTerminationPRNumber refuses to overwrite an existing PR number", () => {
    const updater = makeUpdater();
    updater.terminate("success", 7);
    expect(() => updater.setTerminationPRNumber(99)).toThrow(/already set/);
  });

  it("setTerminationPRNumber throws if the session has not terminated yet", () => {
    const updater = makeUpdater();
    expect(() => updater.setTerminationPRNumber(99)).toThrow(/not terminated/);
  });
});

// ---------------------------------------------------------------------------
// SessionUpdater: SessionSink (tool records)
// ---------------------------------------------------------------------------

describe("SessionUpdater as SessionSink", () => {
  it("appends tool records to the current iteration", async () => {
    const updater = makeUpdater();
    updater.appendIteration();
    await updater.appendToolRecord(buildToolRecord({ tool: "module.readFile" }));
    await updater.appendToolRecord(buildToolRecord({ tool: "module.writeFile" }));

    const session = updater.getSession();
    expect(session.iterations[0].tools.map((t) => t.tool)).toEqual([
      "module.readFile",
      "module.writeFile",
    ]);
  });

  it("routes records to the right iteration based on iterationIndex", async () => {
    const updater = makeUpdater();
    updater.appendIteration();
    await updater.appendToolRecord(buildToolRecord({ iterationIndex: 0, tool: "module.readFile" }));
    updater.appendIteration();
    await updater.appendToolRecord(buildToolRecord({ iterationIndex: 1, tool: "cdk.deploy" }));

    const session = updater.getSession();
    expect(session.iterations[0].tools.map((t) => t.tool)).toEqual([
      "module.readFile",
    ]);
    expect(session.iterations[1].tools.map((t) => t.tool)).toEqual([
      "cdk.deploy",
    ]);
  });

  it("rejects records whose iterationIndex does not match the current iteration", async () => {
    const updater = makeUpdater();
    updater.appendIteration();
    updater.appendIteration();
    // Current iteration is index 1 but the record claims index 0.
    await expect(
      updater.appendToolRecord(buildToolRecord({ iterationIndex: 0 }))
    ).rejects.toThrow(/does not match current/);
  });

  it("throws if no iteration has been appended yet", async () => {
    const updater = makeUpdater();
    await expect(
      updater.appendToolRecord(buildToolRecord())
    ).rejects.toThrow(/no iterations yet/);
  });

  it("redacts secrets in tool record inputs and outputs as defence in depth", async () => {
    const updater = makeUpdater();
    updater.appendIteration();
    // Simulate a buggy caller that bypassed the wrapper and pushed
    // un-redacted secrets through to the sink.
    await updater.appendToolRecord(
      buildToolRecord({
        input: {
          path: "modules/fanout/lib/x.ts",
          githubInstallationToken: "ghs_LEAKED",
        },
        output: {
          contents: "ok",
          sessionToken: "should-not-leak",
        },
      })
    );

    const stored = updater.getSession().iterations[0].tools[0];
    expect(stored.input).toMatchObject({
      githubInstallationToken: "[REDACTED]",
    });
    expect(stored.output).toMatchObject({
      sessionToken: "[REDACTED]",
    });
    expect(JSON.stringify(stored)).not.toContain("ghs_LEAKED");
    expect(JSON.stringify(stored)).not.toContain("should-not-leak");
  });
});

// ---------------------------------------------------------------------------
// SessionUpdater: CostCounter
// ---------------------------------------------------------------------------

describe("SessionUpdater as CostCounter", () => {
  it("accumulates editor token usage", () => {
    const updater = makeUpdater();
    updater.recordTokenUsage(1.25);
    updater.recordTokenUsage(0.75);

    expect(updater.getSession().costs.editorTokensUSD).toBeCloseTo(2.0);
  });

  it("accumulates reviewer token usage separately", () => {
    const updater = makeUpdater();
    updater.recordReviewerTokens(0.5);
    updater.recordReviewerTokens(0.25);

    const costs = updater.getSession().costs;
    expect(costs.reviewerTokensUSD).toBeCloseTo(0.75);
    expect(costs.editorTokensUSD).toBe(0);
  });

  it("accumulates deploy / preview infra cost", () => {
    const updater = makeUpdater();
    updater.recordDeployCost(3);
    updater.recordDeployCost(2);

    expect(updater.getSession().costs.previewInfraUSD).toBeCloseTo(5.0);
  });

  it("rejects negative or non-finite usd values", () => {
    const updater = makeUpdater();
    expect(() => updater.recordTokenUsage(-1)).toThrow();
    expect(() => updater.recordReviewerTokens(NaN)).toThrow();
    expect(() => updater.recordDeployCost(Infinity)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SessionUpdater: per-iteration recorders
// ---------------------------------------------------------------------------

describe("SessionUpdater per-iteration recorders", () => {
  it("recordEdit appends an entry to the current iteration's edits", () => {
    const updater = makeUpdater();
    updater.appendIteration();
    updater.recordEdit({ path: "modules/fanout/lib/x.ts", diff: "+ added" });

    expect(updater.getSession().iterations[0].edits).toEqual([
      { path: "modules/fanout/lib/x.ts", diff: "+ added" },
    ]);
  });

  it("recordComputational sets one of the four sensors", () => {
    const updater = makeUpdater();
    updater.appendIteration();
    updater.recordComputational("tsc", { errors: [], passed: true });
    updater.recordComputational("eslint", {
      findings: [{ ruleId: "no-any" }],
      passed: false,
    });

    const computational = updater.getSession().iterations[0].computational;
    expect(computational.tsc).toEqual({ errors: [], passed: true });
    expect(computational.eslint).toEqual({
      findings: [{ ruleId: "no-any" }],
      passed: false,
    });
    // Untouched sensors stay null.
    expect(computational.cdkNag).toBeNull();
    expect(computational.unitTests).toBeNull();
  });

  it("recordReviewer, recordDeploy, recordPostDeploy each set their slot", () => {
    const updater = makeUpdater();
    updater.appendIteration();
    updater.recordReviewer({ findings: [], passed: true, severityCounts: {} });
    updater.recordDeploy({ outcome: "ok", logs: "deploy ok" });
    updater.recordPostDeploy({ outcome: "pass", report: { sessionId: "s" } });

    const it = updater.getSession().iterations[0];
    expect(it.reviewer).toEqual({ findings: [], passed: true, severityCounts: {} });
    expect(it.deploy).toEqual({ outcome: "ok", logs: "deploy ok" });
    expect(it.postDeploy).toEqual({ outcome: "pass", report: { sessionId: "s" } });
  });

  it("completeIteration sets endedAt on the current iteration", () => {
    const updater = makeUpdater();
    updater.appendIteration();
    updater.completeIteration();

    expect(updater.getSession().iterations[0].endedAt).toBe(FIXED_NOW);
  });

  it("throws if a recorder is called before any iteration is appended", () => {
    const updater = makeUpdater();
    expect(() => updater.recordEdit({ path: "x", diff: "y" })).toThrow(
      /no iterations yet/
    );
    expect(() =>
      updater.recordComputational("tsc", { errors: [], passed: true })
    ).toThrow(/no iterations yet/);
  });
});

// ---------------------------------------------------------------------------
// InMemorySessionStore: roundtrip
// ---------------------------------------------------------------------------

describe("InMemorySessionStore", () => {
  it("returns a session that matches what was written", async () => {
    const store = new InMemorySessionStore();
    const updater = makeUpdater();
    updater.appendIteration();
    await updater.appendToolRecord(buildToolRecord({ tool: "module.readFile" }));
    updater.recordEdit({ path: "modules/fanout/lib/x.ts", diff: "+ added" });
    updater.recordComputational("tsc", { errors: [], passed: true });
    updater.completeIteration();
    updater.terminate("success", 42);
    const written = updater.getSession();

    await store.write(written);
    const readBack = await store.read("session-test-001");

    expect(readBack).toEqual(written);
  });

  it("isolates stored sessions from later updater mutations", async () => {
    const store = new InMemorySessionStore();
    const updater = makeUpdater();
    updater.appendIteration();
    await store.write(updater.getSession());

    // Mutate after the write.
    updater.terminate("success", 1);

    // The stored copy still reflects the pre-terminate state.
    const stored = await store.read("session-test-001");
    expect(stored.termination).toBeNull();
    expect(stored.iterations).toHaveLength(1);
  });

  it("isolates returned sessions from later store overwrites", async () => {
    const store = new InMemorySessionStore();
    const updater = makeUpdater();
    updater.appendIteration();
    await store.write(updater.getSession());

    const firstRead = await store.read("session-test-001");

    // Overwrite the stored session with a terminated version.
    updater.terminate("success", 1);
    await store.write(updater.getSession());

    // The earlier read is unaffected by the overwrite.
    expect(firstRead.termination).toBeNull();
  });

  it("throws when reading an unknown session id", async () => {
    const store = new InMemorySessionStore();
    await expect(store.read("does-not-exist")).rejects.toThrow(
      /session not found/
    );
  });

  it("preserves redaction across write and read", async () => {
    const store = new InMemorySessionStore();
    const trigger = buildTrigger();
    const updater = new SessionUpdater(createSessionFromTrigger(trigger), {
      now: () => FIXED_NOW,
    });
    await store.write(updater.getSession());

    const readBack = await store.read("session-test-001");
    expect(readBack.trigger.auth.githubInstallationToken).toBe("[REDACTED]");
    expect(JSON.stringify(readBack)).not.toContain(
      "ghs_supersecret_token_value_xyz"
    );
  });
});

// ---------------------------------------------------------------------------
// AgentCoreSessionStore: stub
// ---------------------------------------------------------------------------

describe("AgentCoreSessionStore", () => {
  it("throws on construction so accidental production use is loud", () => {
    expect(() => new AgentCoreSessionStore()).toThrow(/not yet implemented/);
  });
});

// ---------------------------------------------------------------------------
// Full-session structural snapshot
// ---------------------------------------------------------------------------

describe("Session contract shape", () => {
  it("conforms to the design.md Session contract structure after a happy path", async () => {
    const updater = makeUpdater();
    const iter = updater.appendIteration();
    expect(iter.index).toBe(0);

    await updater.appendToolRecord(buildToolRecord({ tool: "module.readFile" }));
    updater.recordEdit({ path: "modules/fanout/lib/x.ts", diff: "+ added" });
    updater.recordComputational("cdkNag", { findings: [], passed: true });
    updater.recordComputational("tsc", { errors: [], passed: true });
    updater.recordComputational("eslint", { findings: [], passed: true });
    updater.recordComputational("unitTests", { results: [], passed: true });
    updater.recordReviewer({ findings: [], passed: true, severityCounts: {} });
    updater.recordDeploy({ outcome: "ok", logs: "deploy ok" });
    updater.recordPostDeploy({ outcome: "pass", report: {} });
    updater.recordTokenUsage(1.0);
    updater.recordReviewerTokens(0.5);
    updater.recordDeployCost(2.0);
    updater.completeIteration();
    updater.terminate("success", 42);

    const session: Session = updater.getSession();
    expect(session).toMatchObject({
      schemaVersion: "1.0",
      trigger: expect.objectContaining({
        triggerType: "feature-change",
        issue: expect.objectContaining({ number: 42 }),
      }),
      iterations: [
        expect.objectContaining({
          index: 0,
          startedAt: FIXED_NOW,
          endedAt: FIXED_NOW,
          computational: {
            cdkNag: { findings: [], passed: true },
            tsc: { errors: [], passed: true },
            eslint: { findings: [], passed: true },
            unitTests: { results: [], passed: true },
          },
          reviewer: { findings: [], passed: true, severityCounts: {} },
          deploy: { outcome: "ok", logs: "deploy ok" },
          postDeploy: { outcome: "pass", report: {} },
        }),
      ],
      termination: {
        reason: "success",
        endedAt: FIXED_NOW,
        prNumber: 42,
      },
      costs: {
        editorTokensUSD: 1.0,
        reviewerTokensUSD: 0.5,
        previewInfraUSD: 2.0,
      },
    });
  });
});
