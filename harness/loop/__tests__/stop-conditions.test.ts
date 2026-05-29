/**
 * Tests for the stop-condition checker.
 *
 * Covers tasks.md task 7.2 verification:
 *   - Each stop condition individually (unit tests)
 *   - Priority ordering (unit tests)
 *   - `detectOscillation` unit tests
 *   - Property test: only one termination reason fires per session trace
 *     (correctness Property 2)
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
 */

import * as fc from "fast-check";
import {
  evaluateStopConditions,
  detectOscillation,
  type KillSwitchPoll,
  type StopConditionConfig,
} from "../src/stop-conditions";
import type { Session, IterationRecord } from "../src/session";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG: StopConditionConfig = {
  iterationCap: 5,
  wallClockCapMinutes: 60,
  tokenSpendCapUSD: 10.0,
  oscillation: { sameDiffWindow: 3, alternationWindow: 4 },
};

/** A kill-switch poll that always returns false (no stop label). */
const noKillSwitch: KillSwitchPoll = {
  isAgentStopLabelApplied: async () => false,
};

/** A kill-switch poll that always returns true (stop label applied). */
const yesKillSwitch: KillSwitchPoll = {
  isAgentStopLabelApplied: async () => true,
};

/**
 * Build a minimal Session fixture. Only the fields the stop-condition
 * checker reads are populated; everything else is left at safe defaults.
 */
function buildSession(overrides: {
  iterations?: Partial<IterationRecord>[];
  editorTokensUSD?: number;
  reviewerTokensUSD?: number;
} = {}): Session {
  const iterations: IterationRecord[] = (overrides.iterations ?? []).map(
    (partial, i) => ({
      index: i,
      startedAt: "2024-01-01T00:00:00.000Z",
      endedAt: null,
      edits: [],
      computational: { cdkNag: null, tsc: null, eslint: null, unitTests: null },
      reviewer: null,
      deploy: null,
      postDeploy: null,
      tools: [],
      ...partial,
    })
  );

  return {
    schemaVersion: "1.0",
    trigger: {
      schemaVersion: "1.0",
      triggerType: "feature-change",
      issue: {
        number: 1,
        title: "test",
        body: "",
        url: "https://github.com/example/repo/issues/1",
        openedBy: "alice",
      },
      module: {
        path: "modules/fanout",
        repository: "example/repo",
        ref: "main",
        commitSha: "abc",
      },
      session: { id: "session-test", createdAt: "2024-01-01T00:00:00.000Z" },
      limits: {
        iterationCap: 5,
        wallClockCapMinutes: 60,
        tokenSpendCapUSD: 10.0,
      },
      auth: { githubInstallationToken: "[REDACTED]" },
    },
    iterations,
    termination: null,
    costs: {
      editorTokensUSD: overrides.editorTokensUSD ?? 0,
      reviewerTokensUSD: overrides.reviewerTokensUSD ?? 0,
      previewInfraUSD: 0,
    },
  };
}

/** Build an IterationRecord with a specific diff string. */
function iterWithDiff(diff: string): Partial<IterationRecord> {
  return { edits: [{ path: "modules/fanout/lib/x.ts", diff }] };
}

/** Build an IterationRecord with a specific gate-state hash. */
function iterWithGate(passed: boolean, label: string): Partial<IterationRecord> {
  return {
    computational: {
      cdkNag: { findings: [{ label }], passed },
      tsc: null,
      eslint: null,
      unitTests: null,
    },
    reviewer: null,
  };
}

// ---------------------------------------------------------------------------
// Unit tests: each stop condition individually
// ---------------------------------------------------------------------------

describe("evaluateStopConditions — individual conditions", () => {
  // Use a NOW that is only 30 minutes after the default startedAt
  // ("2024-01-01T00:00:00.000Z") so the wall-clock cap (60 min) does not
  // fire unless a test explicitly wants it to.
  const NOW = new Date("2024-01-01T00:30:00.000Z");

  it("returns kill-switch when the poll returns true", async () => {
    const session = buildSession();
    const result = await evaluateStopConditions(
      session,
      BASE_CONFIG,
      yesKillSwitch,
      NOW
    );
    expect(result).toEqual({ reason: "kill-switch" });
  });

  it("returns null when the poll returns false and no other condition fires", async () => {
    const session = buildSession({ iterations: [{}] });
    const result = await evaluateStopConditions(
      session,
      BASE_CONFIG,
      noKillSwitch,
      NOW
    );
    expect(result).toBeNull();
  });

  it("returns iteration-cap when iterations.length >= iterationCap", async () => {
    const session = buildSession({
      iterations: [{}, {}, {}, {}, {}], // 5 iterations, cap is 5
    });
    const result = await evaluateStopConditions(
      session,
      BASE_CONFIG,
      noKillSwitch,
      NOW
    );
    expect(result).toEqual({ reason: "iteration-cap" });
  });

  it("does not return iteration-cap when iterations.length < iterationCap", async () => {
    // 3 iterations < cap of 5. Use distinct diffs so oscillation doesn't fire.
    const session = buildSession({
      iterations: [
        iterWithDiff("diff-A"),
        iterWithDiff("diff-B"),
        iterWithDiff("diff-C"),
      ],
    });
    const result = await evaluateStopConditions(
      session,
      BASE_CONFIG,
      noKillSwitch,
      NOW
    );
    expect(result).toBeNull();
  });

  it("returns wall-clock-cap when elapsed time >= cap", async () => {
    // First iteration started at T=0; now is T+61 minutes → over the 60-min cap.
    const session = buildSession({
      iterations: [{ startedAt: "2024-01-01T00:00:00.000Z" }],
    });
    const nowOver = new Date("2024-01-01T01:01:00.000Z"); // 61 minutes later
    const result = await evaluateStopConditions(
      session,
      BASE_CONFIG,
      noKillSwitch,
      nowOver
    );
    expect(result).toEqual({ reason: "wall-clock-cap" });
  });

  it("does not return wall-clock-cap when elapsed time < cap", async () => {
    const session = buildSession({
      iterations: [{ startedAt: "2024-01-01T00:00:00.000Z" }],
    });
    const nowUnder = new Date("2024-01-01T00:30:00.000Z"); // 30 minutes later
    const result = await evaluateStopConditions(
      session,
      BASE_CONFIG,
      noKillSwitch,
      nowUnder
    );
    expect(result).toBeNull();
  });

  it("does not return wall-clock-cap when there are no iterations yet", async () => {
    const session = buildSession(); // no iterations
    const nowWayLater = new Date("2024-12-31T23:59:59.000Z");
    const result = await evaluateStopConditions(
      session,
      BASE_CONFIG,
      noKillSwitch,
      nowWayLater
    );
    expect(result).toBeNull();
  });

  it("returns token-cap when editorTokensUSD + reviewerTokensUSD >= cap", async () => {
    const session = buildSession({
      iterations: [{}],
      editorTokensUSD: 7.0,
      reviewerTokensUSD: 3.0, // total = 10.0 = cap
    });
    const result = await evaluateStopConditions(
      session,
      BASE_CONFIG,
      noKillSwitch,
      NOW
    );
    expect(result).toEqual({ reason: "token-cap" });
  });

  it("returns token-cap when total exceeds cap", async () => {
    const session = buildSession({
      iterations: [{}],
      editorTokensUSD: 8.0,
      reviewerTokensUSD: 5.0, // total = 13.0 > 10.0
    });
    const result = await evaluateStopConditions(
      session,
      BASE_CONFIG,
      noKillSwitch,
      NOW
    );
    expect(result).toEqual({ reason: "token-cap" });
  });

  it("does not return token-cap when total is below cap", async () => {
    const session = buildSession({
      iterations: [{}],
      editorTokensUSD: 3.0,
      reviewerTokensUSD: 2.0, // total = 5.0 < 10.0
    });
    const result = await evaluateStopConditions(
      session,
      BASE_CONFIG,
      noKillSwitch,
      NOW
    );
    expect(result).toBeNull();
  });

  it("returns oscillation when the same diff appears twice in the window (same-diff heuristic)", async () => {
    // Window of 3: last 3 iterations have diffs A, B, A → A appears twice.
    const session = buildSession({
      iterations: [
        iterWithDiff("diff-A"),
        iterWithDiff("diff-B"),
        iterWithDiff("diff-A"),
      ],
    });
    const result = await evaluateStopConditions(
      session,
      BASE_CONFIG,
      noKillSwitch,
      NOW
    );
    expect(result).toEqual({ reason: "oscillation" });
  });

  it("returns oscillation when gate results alternate A,B,A,B (alternation heuristic)", async () => {
    // Window of 4: last 4 iterations alternate between two distinct gate states.
    const session = buildSession({
      iterations: [
        iterWithGate(true, "state-A"),
        iterWithGate(false, "state-B"),
        iterWithGate(true, "state-A"),
        iterWithGate(false, "state-B"),
      ],
    });
    const result = await evaluateStopConditions(
      session,
      BASE_CONFIG,
      noKillSwitch,
      NOW
    );
    expect(result).toEqual({ reason: "oscillation" });
  });

  it("returns null when no condition fires", async () => {
    const session = buildSession({
      iterations: [iterWithDiff("diff-A"), iterWithDiff("diff-B")],
    });
    const result = await evaluateStopConditions(
      session,
      BASE_CONFIG,
      noKillSwitch,
      NOW
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit tests: priority ordering
// ---------------------------------------------------------------------------

describe("evaluateStopConditions — priority ordering", () => {
  const NOW = new Date("2024-01-01T01:01:00.000Z"); // 61 min after epoch start

  it("kill-switch wins over iteration-cap when both fire", async () => {
    // 5 iterations (hits cap) AND kill-switch is applied.
    const session = buildSession({
      iterations: [
        { startedAt: "2024-01-01T00:00:00.000Z" },
        {},
        {},
        {},
        {},
      ],
    });
    const result = await evaluateStopConditions(
      session,
      BASE_CONFIG,
      yesKillSwitch,
      NOW
    );
    expect(result).toEqual({ reason: "kill-switch" });
  });

  it("kill-switch wins over wall-clock-cap when both fire", async () => {
    const session = buildSession({
      iterations: [{ startedAt: "2024-01-01T00:00:00.000Z" }],
    });
    const result = await evaluateStopConditions(
      session,
      BASE_CONFIG,
      yesKillSwitch,
      NOW // 61 min later → wall-clock would fire
    );
    expect(result).toEqual({ reason: "kill-switch" });
  });

  it("iteration-cap wins over wall-clock-cap when both fire", async () => {
    // 5 iterations (hits cap) AND elapsed time > 60 min.
    const session = buildSession({
      iterations: [
        { startedAt: "2024-01-01T00:00:00.000Z" },
        {},
        {},
        {},
        {},
      ],
    });
    const result = await evaluateStopConditions(
      session,
      BASE_CONFIG,
      noKillSwitch,
      NOW // 61 min later
    );
    expect(result).toEqual({ reason: "iteration-cap" });
  });

  it("wall-clock-cap wins over token-cap when both fire", async () => {
    const session = buildSession({
      iterations: [{ startedAt: "2024-01-01T00:00:00.000Z" }],
      editorTokensUSD: 10.0, // hits token cap
      reviewerTokensUSD: 0,
    });
    const result = await evaluateStopConditions(
      session,
      BASE_CONFIG,
      noKillSwitch,
      NOW // 61 min later → wall-clock fires first
    );
    expect(result).toEqual({ reason: "wall-clock-cap" });
  });
});

// ---------------------------------------------------------------------------
// Unit tests: detectOscillation
// ---------------------------------------------------------------------------

describe("detectOscillation", () => {
  it("returns true when the same diff appears twice in a window of 3", () => {
    const iterations = [
      buildIteration(iterWithDiff("diff-A")),
      buildIteration(iterWithDiff("diff-B")),
      buildIteration(iterWithDiff("diff-A")), // repeat of A
    ];
    expect(detectOscillation(iterations, 3, 4)).toBe(true);
  });

  it("returns true when gate results alternate A,B,A,B in a window of 4", () => {
    const iterations = [
      buildIteration(iterWithGate(true, "state-A")),
      buildIteration(iterWithGate(false, "state-B")),
      buildIteration(iterWithGate(true, "state-A")),
      buildIteration(iterWithGate(false, "state-B")),
    ];
    expect(detectOscillation(iterations, 3, 4)).toBe(true);
  });

  it("returns false when there are not enough iterations to fill the window", () => {
    // Only 2 iterations but sameDiffWindow is 3.
    const iterations = [
      buildIteration(iterWithDiff("diff-A")),
      buildIteration(iterWithDiff("diff-A")), // same diff, but window not full
    ];
    expect(detectOscillation(iterations, 3, 4)).toBe(false);
  });

  it("returns false when sameDiffWindow is 0 (heuristic disabled)", () => {
    // Even with a repeated diff, window=0 disables the heuristic.
    const iterations = [
      buildIteration(iterWithDiff("diff-A")),
      buildIteration(iterWithDiff("diff-A")),
      buildIteration(iterWithDiff("diff-A")),
    ];
    expect(detectOscillation(iterations, 0, 4)).toBe(false);
  });

  it("returns false when alternationWindow is 0 (heuristic disabled)", () => {
    // alternationWindow=0 disables the alternation heuristic. Use distinct
    // diffs so the same-diff heuristic (sameDiffWindow=3) does not fire.
    const iterations = [
      buildIteration({ ...iterWithGate(true, "state-A"), edits: [{ path: "x.ts", diff: "diff-1" }] }),
      buildIteration({ ...iterWithGate(false, "state-B"), edits: [{ path: "x.ts", diff: "diff-2" }] }),
      buildIteration({ ...iterWithGate(true, "state-A"), edits: [{ path: "x.ts", diff: "diff-3" }] }),
      buildIteration({ ...iterWithGate(false, "state-B"), edits: [{ path: "x.ts", diff: "diff-4" }] }),
    ];
    expect(detectOscillation(iterations, 3, 0)).toBe(false);
  });

  it("returns false when diffs are all distinct within the window", () => {
    const iterations = [
      buildIteration(iterWithDiff("diff-A")),
      buildIteration(iterWithDiff("diff-B")),
      buildIteration(iterWithDiff("diff-C")),
    ];
    expect(detectOscillation(iterations, 3, 4)).toBe(false);
  });

  it("returns false when gate results do not alternate (all same state)", () => {
    const iterations = [
      buildIteration(iterWithGate(true, "state-A")),
      buildIteration(iterWithGate(true, "state-A")),
      buildIteration(iterWithGate(true, "state-A")),
      buildIteration(iterWithGate(true, "state-A")),
    ];
    // All same → not alternating (but same-diff heuristic would fire here
    // since the gate hash repeats; use distinct diffs to isolate the test).
    const iterationsDistinctDiffs = iterations.map((it, i) => ({
      ...it,
      edits: [{ path: "x.ts", diff: `diff-${i}` }],
    }));
    // Alternation requires exactly two distinct states alternating; all-same
    // has only one distinct state, so alternation heuristic should not fire.
    expect(detectOscillation(iterationsDistinctDiffs, 0, 4)).toBe(false);
  });
});

/** Helper: materialise a full IterationRecord from a partial override. */
function buildIteration(partial: Partial<IterationRecord> = {}): IterationRecord {
  return {
    index: 0,
    startedAt: "2024-01-01T00:00:00.000Z",
    endedAt: null,
    edits: [],
    computational: { cdkNag: null, tsc: null, eslint: null, unitTests: null },
    reviewer: null,
    deploy: null,
    postDeploy: null,
    tools: [],
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Property test: correctness Property 2
// Only one termination reason fires per session trace.
//
// **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6**
// ---------------------------------------------------------------------------

describe("evaluateStopConditions — property: at most one reason fires (Property 2)", () => {
  /**
   * Arbitrary for a single IterationRecord. Generates minimal records with
   * random diffs and gate states so the oscillation detector has realistic
   * inputs.
   */
  const arbIteration = fc.record({
    diff: fc.string({ minLength: 0, maxLength: 20 }),
    gatePassed: fc.boolean(),
    gateLabel: fc.string({ minLength: 1, maxLength: 5 }),
  }).map((v: { diff: string; gatePassed: boolean; gateLabel: string }) =>
    buildIteration({
      edits: v.diff.length > 0 ? [{ path: "modules/fanout/lib/x.ts", diff: v.diff }] : [],
      computational: {
        cdkNag: { findings: [{ label: v.gateLabel }], passed: v.gatePassed },
        tsc: null,
        eslint: null,
        unitTests: null,
      },
    })
  );

  /**
   * Arbitrary for a session state. Generates random iteration counts (0–6),
   * random token spend, and a random first-iteration start time so the
   * wall-clock check gets varied inputs.
   */
  const arbSession = fc.record({
    iterationCount: fc.integer({ min: 0, max: 6 }),
    editorTokensUSD: fc.float({ min: 0, max: 15, noNaN: true }),
    reviewerTokensUSD: fc.float({ min: 0, max: 5, noNaN: true }),
    startedAtOffsetMs: fc.integer({ min: 0, max: 7_200_000 }), // 0–2 hours
  }).chain((v: { iterationCount: number; editorTokensUSD: number; reviewerTokensUSD: number; startedAtOffsetMs: number }) =>
    fc.array(arbIteration, { minLength: v.iterationCount, maxLength: v.iterationCount })
      .map((iterations: IterationRecord[]) => {
        const baseTime = new Date("2024-01-01T00:00:00.000Z").getTime();
        const startedAt = new Date(baseTime - v.startedAtOffsetMs).toISOString();
        const patchedIterations = iterations.map((it: IterationRecord, i: number) => ({
          ...it,
          index: i,
          startedAt: i === 0 ? startedAt : it.startedAt,
        }));
        return buildSession({
          iterations: patchedIterations,
          editorTokensUSD: v.editorTokensUSD,
          reviewerTokensUSD: v.reviewerTokensUSD,
        });
      })
  );

  /**
   * Arbitrary for a StopConditionConfig with valid (non-negative) values.
   */
  const arbConfig = fc.record({
    iterationCap: fc.integer({ min: 0, max: 8 }),
    wallClockCapMinutes: fc.float({ min: 0, max: 120, noNaN: true }),
    tokenSpendCapUSD: fc.float({ min: 0, max: 20, noNaN: true }),
    sameDiffWindow: fc.integer({ min: 0, max: 5 }),
    alternationWindow: fc.integer({ min: 0, max: 6 }),
  }).map((v: { iterationCap: number; wallClockCapMinutes: number; tokenSpendCapUSD: number; sameDiffWindow: number; alternationWindow: number }): StopConditionConfig => ({
    iterationCap: v.iterationCap,
    wallClockCapMinutes: v.wallClockCapMinutes,
    tokenSpendCapUSD: v.tokenSpendCapUSD,
    oscillation: { sameDiffWindow: v.sameDiffWindow, alternationWindow: v.alternationWindow },
  }));

  it("returns either null or exactly one reason — never two reasons simultaneously", async () => {
    await fc.assert(
      fc.asyncProperty(arbSession, arbConfig, async (session: Session, config: StopConditionConfig) => {
        const now = new Date("2024-01-01T01:00:00.000Z");
        const result = await evaluateStopConditions(
          session,
          config,
          noKillSwitch,
          now
        );

        // The result is either null (keep going) or an object with exactly
        // one `reason` field. It must never be an array, never have multiple
        // reason fields, and never be an unexpected shape.
        if (result === null) {
          return true; // null is valid
        }

        // Must have exactly one key: `reason`.
        const keys = Object.keys(result);
        if (keys.length !== 1 || keys[0] !== "reason") {
          return false;
        }

        // The reason must be one of the known termination reasons.
        const validReasons = new Set([
          "kill-switch",
          "iteration-cap",
          "wall-clock-cap",
          "token-cap",
          "oscillation",
        ]);
        return validReasons.has(result.reason);
      }),
      { numRuns: 500 }
    );
  });

  it("kill-switch always wins when the poll returns true, regardless of other state", async () => {
    await fc.assert(
      fc.asyncProperty(arbSession, arbConfig, async (session: Session, config: StopConditionConfig) => {
        const now = new Date("2024-01-01T01:00:00.000Z");
        const result = await evaluateStopConditions(
          session,
          config,
          yesKillSwitch,
          now
        );
        // When kill-switch fires, the reason must always be "kill-switch".
        return result !== null && result.reason === "kill-switch";
      }),
      { numRuns: 200 }
    );
  });
});
