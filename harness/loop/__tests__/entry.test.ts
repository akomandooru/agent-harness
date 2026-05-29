/**
 * Integration tests for the loop entry point (`harness/loop/src/entry.ts`).
 *
 * Covers tasks.md task 7.4 verification:
 *
 *   - Happy path: a valid recorded payload produces a session record with
 *     the expected shape.
 *   - Invalid payload: missing required fields → throws with a descriptive
 *     error.
 *   - Invalid payload: wrong triggerType → throws.
 *   - The session record written to the store has `schemaVersion: "1.0"`,
 *     the correct `trigger.session.id`, and `termination` set after the
 *     loop completes.
 *   - The returned `sessionId` matches the trigger's `session.id`.
 *
 * Uses `InMemorySessionStore` and stub `LoopGates` following the patterns
 * established in `run.test.ts`.
 *
 * Requirements: 1.3, 9.5
 */

import {
  createLoopEntry,
  validateTriggerPayload,
  type LoopEntryOptions,
  type LoopEntryResult,
} from "../src/entry";
import { InMemorySessionStore } from "../src/session";
import type { LoopGates, SensorResults, ReviewerResult, DeployResult, PostDeployResult } from "../src/run";
import type { StopConditionConfig, KillSwitchPoll } from "../src/stop-conditions";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2024-06-01T12:00:00.000Z");

/** A valid, fully-populated trigger payload matching the design.md schema. */
const VALID_PAYLOAD = {
  schemaVersion: "1.0",
  triggerType: "feature-change",
  issue: {
    number: 42,
    title: "Add a dead-letter queue to the SQS subscriber",
    body: "Please add a DLQ to the fanout module.",
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
    id: "session-entry-test-001",
    createdAt: "2024-06-01T12:00:00.000Z",
  },
  limits: {
    iterationCap: 5,
    wallClockCapMinutes: 60,
    tokenSpendCapUSD: 10.0,
  },
  auth: {
    githubInstallationToken: "ghs_supersecret_token_value_xyz",
  },
};

const BASE_CONFIG: StopConditionConfig = {
  iterationCap: 5,
  wallClockCapMinutes: 60,
  tokenSpendCapUSD: 10.0,
  oscillation: { sameDiffWindow: 3, alternationWindow: 4 },
};

const noKillSwitch: KillSwitchPoll = {
  isAgentStopLabelApplied: async () => false,
};

const passingSensors: SensorResults = {
  cdkNag: { findings: [], passed: true },
  tsc: { errors: [], passed: true },
  eslint: { findings: [], passed: true },
  unitTests: { results: [], passed: true },
};

const passingReviewer: ReviewerResult = {
  findings: [],
  passed: true,
  severityCounts: {},
};

const passingDeploy: DeployResult = {
  outcome: "ok",
  logs: "Deploy succeeded",
  stackOutputs: { ApiEndpointUrl: "https://api.example.com" },
};

const passingPostDeploy: PostDeployResult = {
  outcome: "pass",
  report: { sessionId: "session-entry-test-001" },
};

let prCounter = 0;

/** Build a stub LoopGates that always passes all gates and opens a PR. */
function makePassingGates(): LoopGates {
  return {
    runEditor: async () => ({
      edits: [{ path: "modules/fanout/lib/fanout-stack.ts", diff: "+ // DLQ added" }],
    }),
    runSensors: async () => passingSensors,
    runReviewer: async () => passingReviewer,
    runDeploy: async () => passingDeploy,
    runPostDeploy: async () => passingPostDeploy,
    openPR: async (_body, _partial) => ({
      number: ++prCounter,
      url: `https://github.com/example/repo/pull/${prCounter}`,
    }),
  };
}

/** Build a LoopEntryOptions with injectable store and gates. */
function buildOptions(
  overrides: Partial<LoopEntryOptions> = {}
): LoopEntryOptions {
  return {
    store: new InMemorySessionStore(),
    config: BASE_CONFIG,
    killSwitchPoll: noKillSwitch,
    gates: makePassingGates(),
    clock: () => FIXED_NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateTriggerPayload
// ---------------------------------------------------------------------------

describe("validateTriggerPayload", () => {
  it("accepts a valid payload and returns it typed as SessionTrigger", () => {
    const result = validateTriggerPayload(VALID_PAYLOAD);

    expect(result.schemaVersion).toBe("1.0");
    expect(result.triggerType).toBe("feature-change");
    expect(result.session.id).toBe("session-entry-test-001");
    expect(result.issue.number).toBe(42);
  });

  it("throws a descriptive error when triggerType is wrong", () => {
    const bad = { ...VALID_PAYLOAD, triggerType: "unknown-type" };

    expect(() => validateTriggerPayload(bad)).toThrow(/Invalid trigger payload/);
    expect(() => validateTriggerPayload(bad)).toThrow(/triggerType/);
  });

  it("throws when schemaVersion is missing", () => {
    const { schemaVersion: _omit, ...bad } = VALID_PAYLOAD;

    expect(() => validateTriggerPayload(bad)).toThrow(/Invalid trigger payload/);
    expect(() => validateTriggerPayload(bad)).toThrow(/schemaVersion/);
  });

  it("throws when issue is missing", () => {
    const { issue: _omit, ...bad } = VALID_PAYLOAD;

    expect(() => validateTriggerPayload(bad)).toThrow(/Invalid trigger payload/);
    expect(() => validateTriggerPayload(bad)).toThrow(/issue/);
  });

  it("throws when issue.number is missing", () => {
    const bad = {
      ...VALID_PAYLOAD,
      issue: { title: "t", body: "b", url: "u", openedBy: "o" },
    };

    expect(() => validateTriggerPayload(bad)).toThrow(/Invalid trigger payload/);
  });

  it("throws when module is missing", () => {
    const { module: _omit, ...bad } = VALID_PAYLOAD;

    expect(() => validateTriggerPayload(bad)).toThrow(/Invalid trigger payload/);
    expect(() => validateTriggerPayload(bad)).toThrow(/module/);
  });

  it("throws when session is missing", () => {
    const { session: _omit, ...bad } = VALID_PAYLOAD;

    expect(() => validateTriggerPayload(bad)).toThrow(/Invalid trigger payload/);
    expect(() => validateTriggerPayload(bad)).toThrow(/session/);
  });

  it("throws when limits is missing", () => {
    const { limits: _omit, ...bad } = VALID_PAYLOAD;

    expect(() => validateTriggerPayload(bad)).toThrow(/Invalid trigger payload/);
    expect(() => validateTriggerPayload(bad)).toThrow(/limits/);
  });

  it("throws when auth is missing", () => {
    const { auth: _omit, ...bad } = VALID_PAYLOAD;

    expect(() => validateTriggerPayload(bad)).toThrow(/Invalid trigger payload/);
    expect(() => validateTriggerPayload(bad)).toThrow(/auth/);
  });

  it("throws when auth.githubInstallationToken is missing", () => {
    const bad = { ...VALID_PAYLOAD, auth: {} };

    expect(() => validateTriggerPayload(bad)).toThrow(/Invalid trigger payload/);
  });

  it("throws when the payload is not an object", () => {
    expect(() => validateTriggerPayload(null)).toThrow(/Invalid trigger payload/);
    expect(() => validateTriggerPayload("string")).toThrow(/Invalid trigger payload/);
    expect(() => validateTriggerPayload(42)).toThrow(/Invalid trigger payload/);
  });

  it("allows additional top-level properties (extension slot)", () => {
    const extended = {
      ...VALID_PAYLOAD,
      originatingFinding: { id: "finding-001", severity: "high" },
    };

    expect(() => validateTriggerPayload(extended)).not.toThrow();
  });

  it("allows additional auth properties (forker extension)", () => {
    const extended = {
      ...VALID_PAYLOAD,
      auth: {
        githubInstallationToken: "ghs_token",
        secondaryToken: "secondary",
      },
    };

    expect(() => validateTriggerPayload(extended)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createLoopEntry — happy path
// ---------------------------------------------------------------------------

describe("createLoopEntry — happy path", () => {
  beforeEach(() => {
    prCounter = 0;
  });

  it("returns a handler function", () => {
    const handler = createLoopEntry(buildOptions());
    expect(typeof handler).toBe("function");
  });

  it("returns sessionId matching the trigger's session.id", async () => {
    const handler = createLoopEntry(buildOptions());
    const result = await handler(VALID_PAYLOAD);

    expect(result.sessionId).toBe("session-entry-test-001");
  });

  it("returns a prNumber greater than 0 on success", async () => {
    const handler = createLoopEntry(buildOptions());
    const result = await handler(VALID_PAYLOAD);

    expect(result.prNumber).toBeGreaterThan(0);
  });

  it("returns terminationReason 'success' when all gates pass", async () => {
    const handler = createLoopEntry(buildOptions());
    const result = await handler(VALID_PAYLOAD);

    expect(result.terminationReason).toBe("success");
  });

  it("result shape matches LoopEntryResult contract", async () => {
    const handler = createLoopEntry(buildOptions());
    const result: LoopEntryResult = await handler(VALID_PAYLOAD);

    expect(typeof result.sessionId).toBe("string");
    expect(result.prNumber === null || typeof result.prNumber === "number").toBe(true);
    expect(typeof result.terminationReason).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// createLoopEntry — session record shape
// ---------------------------------------------------------------------------

describe("createLoopEntry — session record shape", () => {
  beforeEach(() => {
    prCounter = 0;
  });

  it("writes a session record with schemaVersion '1.0'", async () => {
    const store = new InMemorySessionStore();
    const handler = createLoopEntry(buildOptions({ store }));
    await handler(VALID_PAYLOAD);

    const stored = await store.read("session-entry-test-001");
    expect(stored.schemaVersion).toBe("1.0");
  });

  it("writes a session record with the correct trigger.session.id", async () => {
    const store = new InMemorySessionStore();
    const handler = createLoopEntry(buildOptions({ store }));
    await handler(VALID_PAYLOAD);

    const stored = await store.read("session-entry-test-001");
    expect(stored.trigger.session.id).toBe("session-entry-test-001");
  });

  it("writes a session record with termination set after the loop completes", async () => {
    const store = new InMemorySessionStore();
    const handler = createLoopEntry(buildOptions({ store }));
    await handler(VALID_PAYLOAD);

    const stored = await store.read("session-entry-test-001");
    expect(stored.termination).not.toBeNull();
    expect(stored.termination?.reason).toBe("success");
    expect(stored.termination?.prNumber).toBeGreaterThan(0);
  });

  it("redacts auth.githubInstallationToken in the stored session", async () => {
    const store = new InMemorySessionStore();
    const handler = createLoopEntry(buildOptions({ store }));
    await handler(VALID_PAYLOAD);

    const stored = await store.read("session-entry-test-001");
    expect(stored.trigger.auth.githubInstallationToken).toBe("[REDACTED]");
    expect(JSON.stringify(stored)).not.toContain("ghs_supersecret_token_value_xyz");
  });

  it("records at least one iteration in the session", async () => {
    const store = new InMemorySessionStore();
    const handler = createLoopEntry(buildOptions({ store }));
    await handler(VALID_PAYLOAD);

    const stored = await store.read("session-entry-test-001");
    expect(stored.iterations.length).toBeGreaterThanOrEqual(1);
  });

  it("session record has the correct trigger.issue.number", async () => {
    const store = new InMemorySessionStore();
    const handler = createLoopEntry(buildOptions({ store }));
    await handler(VALID_PAYLOAD);

    const stored = await store.read("session-entry-test-001");
    expect(stored.trigger.issue.number).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// createLoopEntry — invalid payload rejection
// ---------------------------------------------------------------------------

describe("createLoopEntry — invalid payload rejection", () => {
  beforeEach(() => {
    prCounter = 0;
  });

  it("throws a descriptive error when required fields are missing", async () => {
    const handler = createLoopEntry(buildOptions());
    const bad = { triggerType: "feature-change" }; // missing most fields

    await expect(handler(bad)).rejects.toThrow(/Invalid trigger payload/);
  });

  it("throws when triggerType is wrong", async () => {
    const handler = createLoopEntry(buildOptions());
    const bad = { ...VALID_PAYLOAD, triggerType: "not-a-valid-type" };

    await expect(handler(bad)).rejects.toThrow(/Invalid trigger payload/);
  });

  it("throws when the payload is null", async () => {
    const handler = createLoopEntry(buildOptions());

    await expect(handler(null)).rejects.toThrow(/Invalid trigger payload/);
  });

  it("does not write to the store when the payload is invalid", async () => {
    const store = new InMemorySessionStore();
    const handler = createLoopEntry(buildOptions({ store }));
    const bad = { ...VALID_PAYLOAD, triggerType: "bad-type" };

    await expect(handler(bad)).rejects.toThrow();

    // The store should have no session for the id in the bad payload.
    await expect(store.read("session-entry-test-001")).rejects.toThrow(
      /session not found/
    );
  });
});

// ---------------------------------------------------------------------------
// createLoopEntry — iteration-cap termination
// ---------------------------------------------------------------------------

describe("createLoopEntry — iteration-cap termination", () => {
  beforeEach(() => {
    prCounter = 0;
  });

  it("terminates with 'iteration-cap' when sensors always fail and cap is reached", async () => {
    const store = new InMemorySessionStore();
    const config: StopConditionConfig = {
      ...BASE_CONFIG,
      iterationCap: 2,
      oscillation: { sameDiffWindow: 0, alternationWindow: 0 },
    };
    let iterNum = 0;
    const gates: LoopGates = {
      runEditor: async () => ({
        edits: [{ path: "modules/fanout/lib/x.ts", diff: `diff-${iterNum++}` }],
      }),
      runSensors: async () => ({
        cdkNag: { findings: [], passed: true },
        tsc: { errors: [{ message: "Type error" }], passed: false },
        eslint: { findings: [], passed: true },
        unitTests: { results: [], passed: true },
      }),
      runReviewer: async () => passingReviewer,
      runDeploy: async () => passingDeploy,
      runPostDeploy: async () => passingPostDeploy,
      openPR: async () => ({ number: ++prCounter, url: `https://github.com/example/repo/pull/${prCounter}` }),
    };

    const handler = createLoopEntry(buildOptions({ store, config, gates }));
    const result = await handler(VALID_PAYLOAD);

    expect(result.terminationReason).toBe("iteration-cap");
    expect(result.sessionId).toBe("session-entry-test-001");

    const stored = await store.read("session-entry-test-001");
    expect(stored.termination?.reason).toBe("iteration-cap");
    expect(stored.iterations.length).toBe(2);
  });
});
