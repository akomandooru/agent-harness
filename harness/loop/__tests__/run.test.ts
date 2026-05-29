/**
 * Tests for the bounded loop body (`harness/loop/src/run.ts`).
 *
 * Covers tasks.md task 7.3 verification:
 *   - Property 1 (gate ordering): sensors always run before reviewer,
 *     reviewer before deploy, deploy before post-deploy.
 *   - Property 3 (iteration cap honesty): the loop never runs more
 *     iterations than `iterationCap`.
 *   - Success path: when all gates pass, the loop terminates with
 *     "success" and opens a PR.
 *   - Partial path: when the iteration cap is reached, the loop
 *     terminates with "iteration-cap" and opens a partial PR.
 *   - Stop-on-sensor-failure: when sensors fail and the stop condition
 *     fires, the loop terminates.
 *
 * Uses `fast-check` for the property tests.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4
 */

import * as fc from "fast-check";
import {
  runLoop,
  type LoopGates,
  type LoopOptions,
  type SensorResults,
  type ReviewerResult,
  type DeployResult,
  type PostDeployResult,
} from "../src/run";
import {
  InMemorySessionStore,
  createSessionFromTrigger,
  type Session,
  type SessionTrigger,
} from "../src/session";
import type { StopConditionConfig, KillSwitchPoll } from "../src/stop-conditions";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2024-01-01T00:00:00.000Z");
const noKillSwitch: KillSwitchPoll = {
  isAgentStopLabelApplied: async () => false,
};

function buildTrigger(overrides: Partial<SessionTrigger> = {}): SessionTrigger {
  return {
    schemaVersion: "1.0",
    triggerType: "feature-change",
    issue: {
      number: 42,
      title: "Add a dead-letter queue",
      body: "Add a DLQ.",
      url: "https://github.com/example/repo/issues/42",
      openedBy: "alice",
    },
    module: {
      path: "modules/fanout",
      repository: "example/repo",
      ref: "main",
      commitSha: "abc123",
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
    auth: { githubInstallationToken: "[REDACTED]" },
    ...overrides,
  };
}

const BASE_CONFIG: StopConditionConfig = {
  iterationCap: 5,
  wallClockCapMinutes: 60,
  tokenSpendCapUSD: 10.0,
  oscillation: { sameDiffWindow: 3, alternationWindow: 4 },
};

function buildSession(trigger?: SessionTrigger): Session {
  return createSessionFromTrigger(trigger ?? buildTrigger());
}

/** Passing sensor results — all four sensors pass. */
const passingSensors: SensorResults = {
  cdkNag: { findings: [], passed: true },
  tsc: { errors: [], passed: true },
  eslint: { findings: [], passed: true },
  unitTests: { results: [], passed: true },
};

/** Failing sensor results — tsc fails. */
const failingSensors: SensorResults = {
  cdkNag: { findings: [], passed: true },
  tsc: { errors: [{ message: "Type error" }], passed: false },
  eslint: { findings: [], passed: true },
  unitTests: { results: [], passed: true },
};

const passingReviewer: ReviewerResult = {
  findings: [],
  passed: true,
  severityCounts: {},
};

const failingReviewer: ReviewerResult = {
  findings: [{ id: "SEC-1", severity: "high", description: "Missing HTTPS" }],
  passed: false,
  severityCounts: { high: 1 },
};

const passingDeploy: DeployResult = {
  outcome: "ok",
  logs: "Deploy succeeded",
  stackOutputs: { ApiEndpointUrl: "https://api.example.com" },
};

const failingDeploy: DeployResult = {
  outcome: "deploy-error",
  logs: "Deploy failed",
};

const passingPostDeploy: PostDeployResult = {
  outcome: "pass",
  report: { sessionId: "session-test-001" },
};

const failingPostDeploy: PostDeployResult = {
  outcome: "fail",
  report: { sessionId: "session-test-001", error: "Timeout" },
};

let prCounter = 0;
function makePROpener(partial: boolean[] = []): (body: string, isPartial: boolean) => Promise<{ number: number; url: string }> {
  return async (_body, isPartial) => {
    partial.push(isPartial);
    return { number: ++prCounter, url: `https://github.com/example/repo/pull/${prCounter}` };
  };
}

/** Build a LoopOptions with injectable gates and a fixed clock. */
function buildOptions(
  gates: LoopGates,
  overrides: Partial<LoopOptions> = {}
): LoopOptions {
  return {
    session: buildSession(),
    store: new InMemorySessionStore(),
    config: BASE_CONFIG,
    killSwitchPoll: noKillSwitch,
    clock: () => FIXED_NOW,
    gates,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe("runLoop — success path", () => {
  beforeEach(() => { prCounter = 0; });

  it("terminates with 'success' when all gates pass on the first iteration", async () => {
    const gates: LoopGates = {
      runEditor: async () => ({ edits: [{ path: "modules/fanout/lib/x.ts", diff: "+ added" }] }),
      runSensors: async () => passingSensors,
      runReviewer: async () => passingReviewer,
      runDeploy: async () => passingDeploy,
      runPostDeploy: async () => passingPostDeploy,
      openPR: makePROpener(),
    };

    const result = await runLoop(buildOptions(gates));

    expect(result.terminationReason).toBe("success");
    expect(result.prNumber).toBeGreaterThan(0);
  });

  it("opens a non-partial PR on success", async () => {
    const partialFlags: boolean[] = [];
    const gates: LoopGates = {
      runEditor: async () => ({ edits: [] }),
      runSensors: async () => passingSensors,
      runReviewer: async () => passingReviewer,
      runDeploy: async () => passingDeploy,
      runPostDeploy: async () => passingPostDeploy,
      openPR: makePROpener(partialFlags),
    };

    await runLoop(buildOptions(gates));

    expect(partialFlags).toEqual([false]);
  });

  it("persists the session to the store with termination reason 'success'", async () => {
    const store = new InMemorySessionStore();
    const gates: LoopGates = {
      runEditor: async () => ({ edits: [] }),
      runSensors: async () => passingSensors,
      runReviewer: async () => passingReviewer,
      runDeploy: async () => passingDeploy,
      runPostDeploy: async () => passingPostDeploy,
      openPR: makePROpener(),
    };

    await runLoop(buildOptions(gates, { store }));

    const stored = await store.read("session-test-001");
    expect(stored.termination?.reason).toBe("success");
    expect(stored.termination?.prNumber).toBeGreaterThan(0);
  });

  it("records edits, sensors, reviewer, deploy, and post-deploy in the iteration", async () => {
    const store = new InMemorySessionStore();
    const gates: LoopGates = {
      runEditor: async () => ({ edits: [{ path: "modules/fanout/lib/x.ts", diff: "+ added" }] }),
      runSensors: async () => passingSensors,
      runReviewer: async () => passingReviewer,
      runDeploy: async () => passingDeploy,
      runPostDeploy: async () => passingPostDeploy,
      openPR: makePROpener(),
    };

    await runLoop(buildOptions(gates, { store }));

    const stored = await store.read("session-test-001");
    expect(stored.iterations).toHaveLength(1);
    const it = stored.iterations[0];
    expect(it.edits).toHaveLength(1);
    expect(it.computational.tsc?.passed).toBe(true);
    expect(it.reviewer?.passed).toBe(true);
    expect(it.deploy?.outcome).toBe("ok");
    expect(it.postDeploy?.outcome).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// Partial path (iteration cap)
// ---------------------------------------------------------------------------

describe("runLoop — partial path (iteration cap)", () => {
  beforeEach(() => { prCounter = 0; });

  it("terminates with 'iteration-cap' when the cap is reached", async () => {
    const config: StopConditionConfig = {
      ...BASE_CONFIG,
      iterationCap: 2,
    };
    const gates: LoopGates = {
      runEditor: async () => ({ edits: [{ path: "x.ts", diff: `diff-${Math.random()}` }] }),
      runSensors: async () => failingSensors,
      runReviewer: async () => passingReviewer,
      runDeploy: async () => passingDeploy,
      runPostDeploy: async () => passingPostDeploy,
      openPR: makePROpener(),
    };

    const result = await runLoop(buildOptions(gates, { config }));

    expect(result.terminationReason).toBe("iteration-cap");
    expect(result.prNumber).toBeGreaterThan(0);
  });

  it("opens a partial PR when the iteration cap is reached", async () => {
    const partialFlags: boolean[] = [];
    const config: StopConditionConfig = { ...BASE_CONFIG, iterationCap: 1 };
    const gates: LoopGates = {
      runEditor: async () => ({ edits: [] }),
      runSensors: async () => failingSensors,
      runReviewer: async () => passingReviewer,
      runDeploy: async () => passingDeploy,
      runPostDeploy: async () => passingPostDeploy,
      openPR: makePROpener(partialFlags),
    };

    await runLoop(buildOptions(gates, { config }));

    expect(partialFlags).toEqual([true]);
  });

  it("terminates immediately when iterationCap is 0 (no iterations run)", async () => {
    const config: StopConditionConfig = { ...BASE_CONFIG, iterationCap: 0 };
    let editorCalled = false;
    const gates: LoopGates = {
      runEditor: async () => { editorCalled = true; return { edits: [] }; },
      runSensors: async () => passingSensors,
      runReviewer: async () => passingReviewer,
      runDeploy: async () => passingDeploy,
      runPostDeploy: async () => passingPostDeploy,
      openPR: makePROpener(),
    };

    const result = await runLoop(buildOptions(gates, { config }));

    expect(result.terminationReason).toBe("iteration-cap");
    expect(editorCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stop-on-sensor-failure
// ---------------------------------------------------------------------------

describe("runLoop — stop-on-sensor-failure", () => {
  beforeEach(() => { prCounter = 0; });

  it("terminates with 'iteration-cap' when sensors fail and cap is reached", async () => {
    const config: StopConditionConfig = { ...BASE_CONFIG, iterationCap: 1 };
    const gates: LoopGates = {
      runEditor: async () => ({ edits: [{ path: "x.ts", diff: "diff-A" }] }),
      runSensors: async () => failingSensors,
      runReviewer: async () => passingReviewer,
      runDeploy: async () => passingDeploy,
      runPostDeploy: async () => passingPostDeploy,
      openPR: makePROpener(),
    };

    const result = await runLoop(buildOptions(gates, { config }));

    expect(result.terminationReason).toBe("iteration-cap");
  });

  it("does not call reviewer when sensors fail", async () => {
    const config: StopConditionConfig = { ...BASE_CONFIG, iterationCap: 1 };
    let reviewerCalled = false;
    const gates: LoopGates = {
      runEditor: async () => ({ edits: [] }),
      runSensors: async () => failingSensors,
      runReviewer: async () => { reviewerCalled = true; return passingReviewer; },
      runDeploy: async () => passingDeploy,
      runPostDeploy: async () => passingPostDeploy,
      openPR: makePROpener(),
    };

    await runLoop(buildOptions(gates, { config }));

    expect(reviewerCalled).toBe(false);
  });

  it("does not call deploy when sensors fail", async () => {
    const config: StopConditionConfig = { ...BASE_CONFIG, iterationCap: 1 };
    let deployCalled = false;
    const gates: LoopGates = {
      runEditor: async () => ({ edits: [] }),
      runSensors: async () => failingSensors,
      runReviewer: async () => passingReviewer,
      runDeploy: async () => { deployCalled = true; return passingDeploy; },
      runPostDeploy: async () => passingPostDeploy,
      openPR: makePROpener(),
    };

    await runLoop(buildOptions(gates, { config }));

    expect(deployCalled).toBe(false);
  });

  it("does not call deploy when reviewer fails", async () => {
    const config: StopConditionConfig = { ...BASE_CONFIG, iterationCap: 1 };
    let deployCalled = false;
    const gates: LoopGates = {
      runEditor: async () => ({ edits: [] }),
      runSensors: async () => passingSensors,
      runReviewer: async () => failingReviewer,
      runDeploy: async () => { deployCalled = true; return passingDeploy; },
      runPostDeploy: async () => passingPostDeploy,
      openPR: makePROpener(),
    };

    await runLoop(buildOptions(gates, { config }));

    expect(deployCalled).toBe(false);
  });

  it("does not call post-deploy when deploy fails", async () => {
    const config: StopConditionConfig = { ...BASE_CONFIG, iterationCap: 1 };
    let postDeployCalled = false;
    const gates: LoopGates = {
      runEditor: async () => ({ edits: [] }),
      runSensors: async () => passingSensors,
      runReviewer: async () => passingReviewer,
      runDeploy: async () => failingDeploy,
      runPostDeploy: async () => { postDeployCalled = true; return passingPostDeploy; },
      openPR: makePROpener(),
    };

    await runLoop(buildOptions(gates, { config }));

    expect(postDeployCalled).toBe(false);
  });

  it("terminates with 'kill-switch' when kill switch fires after sensor failure", async () => {
    let callCount = 0;
    const killSwitchPoll: KillSwitchPoll = {
      // First call (pre-iteration): no stop. Second call (after sensor fail): stop.
      isAgentStopLabelApplied: async () => { callCount++; return callCount >= 2; },
    };
    const gates: LoopGates = {
      runEditor: async () => ({ edits: [] }),
      runSensors: async () => failingSensors,
      runReviewer: async () => passingReviewer,
      runDeploy: async () => passingDeploy,
      runPostDeploy: async () => passingPostDeploy,
      openPR: makePROpener(),
    };

    const result = await runLoop(buildOptions(gates, { killSwitchPoll }));

    expect(result.terminationReason).toBe("kill-switch");
  });
});

// ---------------------------------------------------------------------------
// Property 1: Gate ordering
// Sensors always run before reviewer, reviewer before deploy, deploy before
// post-deploy.
//
// **Validates: Requirements 7.1, 7.2, 7.3**
// ---------------------------------------------------------------------------

describe("runLoop — Property 1: gate ordering", () => {
  beforeEach(() => { prCounter = 0; });

  /**
   * Build a LoopGates stub that records the order in which gates are called.
   * The stub always passes all gates so the loop reaches the success path
   * and we can observe the full call sequence.
   */
  function makeOrderRecordingGates(callOrder: string[]): LoopGates {
    return {
      runEditor: async () => {
        callOrder.push("editor");
        return { edits: [{ path: "x.ts", diff: "diff-A" }] };
      },
      runSensors: async () => {
        callOrder.push("sensors");
        return passingSensors;
      },
      runReviewer: async () => {
        callOrder.push("reviewer");
        return passingReviewer;
      },
      runDeploy: async () => {
        callOrder.push("deploy");
        return passingDeploy;
      },
      runPostDeploy: async () => {
        callOrder.push("postDeploy");
        return passingPostDeploy;
      },
      openPR: makePROpener(),
    };
  }

  it("calls gates in order: editor → sensors → reviewer → deploy → postDeploy", async () => {
    const callOrder: string[] = [];
    const gates = makeOrderRecordingGates(callOrder);

    await runLoop(buildOptions(gates));

    // Find the indices of each gate in the call order.
    const editorIdx = callOrder.indexOf("editor");
    const sensorsIdx = callOrder.indexOf("sensors");
    const reviewerIdx = callOrder.indexOf("reviewer");
    const deployIdx = callOrder.indexOf("deploy");
    const postDeployIdx = callOrder.indexOf("postDeploy");

    expect(editorIdx).toBeLessThan(sensorsIdx);
    expect(sensorsIdx).toBeLessThan(reviewerIdx);
    expect(reviewerIdx).toBeLessThan(deployIdx);
    expect(deployIdx).toBeLessThan(postDeployIdx);
  });

  it("property: sensors always precede reviewer in every iteration (fast-check)", async () => {
    /**
     * **Validates: Requirements 7.1, 7.2, 7.3**
     *
     * For any number of iterations (1–4) where sensors pass and reviewer
     * passes, the call order within each iteration must be:
     * sensors < reviewer < deploy < postDeploy.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        async (iterationCount) => {
          prCounter = 0;
          const callOrder: string[] = [];
          // Use a counter to make each iteration's diff unique (avoid oscillation).
          let iterNum = 0;
          const gates: LoopGates = {
            runEditor: async () => {
              callOrder.push("editor");
              return { edits: [{ path: "x.ts", diff: `diff-${iterNum++}` }] };
            },
            runSensors: async () => {
              callOrder.push("sensors");
              return passingSensors;
            },
            runReviewer: async () => {
              callOrder.push("reviewer");
              return passingReviewer;
            },
            runDeploy: async () => {
              callOrder.push("deploy");
              return passingDeploy;
            },
            runPostDeploy: async () => {
              callOrder.push("postDeploy");
              return passingPostDeploy;
            },
            openPR: makePROpener(),
          };

          // Run with a cap high enough to allow iterationCount iterations.
          const config: StopConditionConfig = {
            ...BASE_CONFIG,
            iterationCap: iterationCount + 1,
          };

          await runLoop(buildOptions(gates, { config }));

          // Verify ordering within each iteration's slice of callOrder.
          // Each iteration produces: editor, sensors, reviewer, deploy, postDeploy.
          // The loop succeeds on the first iteration where all gates pass.
          // Since all gates always pass here, it succeeds on iteration 1.
          const sensorsIdx = callOrder.indexOf("sensors");
          const reviewerIdx = callOrder.indexOf("reviewer");
          const deployIdx = callOrder.indexOf("deploy");
          const postDeployIdx = callOrder.indexOf("postDeploy");

          return (
            sensorsIdx < reviewerIdx &&
            reviewerIdx < deployIdx &&
            deployIdx < postDeployIdx
          );
        }
      ),
      { numRuns: 50 }
    );
  });

  it("property: sensors precede reviewer even when sensors fail (fast-check)", async () => {
    /**
     * **Validates: Requirements 7.1, 7.2**
     *
     * When sensors fail, the reviewer must NOT be called. This is the
     * gate-ordering invariant: sensors gate the reviewer.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        async (cap) => {
          prCounter = 0;
          let reviewerCalled = false;
          let sensorsCalledCount = 0;
          let iterNum = 0;
          const gates: LoopGates = {
            runEditor: async () => ({
              edits: [{ path: "x.ts", diff: `diff-${iterNum++}` }],
            }),
            runSensors: async () => {
              sensorsCalledCount++;
              return failingSensors;
            },
            runReviewer: async () => {
              reviewerCalled = true;
              return passingReviewer;
            },
            runDeploy: async () => passingDeploy,
            runPostDeploy: async () => passingPostDeploy,
            openPR: makePROpener(),
          };

          const config: StopConditionConfig = { ...BASE_CONFIG, iterationCap: cap };
          await runLoop(buildOptions(gates, { config }));

          // Sensors must have been called at least once, reviewer never.
          return sensorsCalledCount >= 1 && !reviewerCalled;
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Iteration cap honesty
// The loop never runs more iterations than `iterationCap`.
//
// **Validates: Requirements 8.2**
// ---------------------------------------------------------------------------

describe("runLoop — Property 3: iteration cap honesty", () => {
  beforeEach(() => { prCounter = 0; });

  it("never exceeds the iteration cap when sensors always fail (fast-check)", async () => {
    /**
     * **Validates: Requirements 8.2**
     *
     * For any iterationCap in [0, 6], a loop where sensors always fail
     * must terminate with at most `iterationCap` iterations recorded in
     * the session.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 6 }),
        async (iterationCap) => {
          prCounter = 0;
          const store = new InMemorySessionStore();
          let iterNum = 0;
          const gates: LoopGates = {
            runEditor: async () => ({
              edits: [{ path: "x.ts", diff: `diff-${iterNum++}` }],
            }),
            runSensors: async () => failingSensors,
            runReviewer: async () => passingReviewer,
            runDeploy: async () => passingDeploy,
            runPostDeploy: async () => passingPostDeploy,
            openPR: makePROpener(),
          };

          const config: StopConditionConfig = {
            ...BASE_CONFIG,
            iterationCap,
            // Disable oscillation so only the cap fires.
            oscillation: { sameDiffWindow: 0, alternationWindow: 0 },
          };

          const result = await runLoop(buildOptions(gates, { store, config }));

          const stored = await store.read("session-test-001");
          return (
            stored.iterations.length <= iterationCap &&
            result.terminationReason === "iteration-cap"
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it("never exceeds the iteration cap when all gates pass (fast-check)", async () => {
    /**
     * **Validates: Requirements 8.2**
     *
     * When all gates pass, the loop succeeds on the first iteration.
     * The number of iterations recorded must be exactly 1, regardless
     * of the cap (as long as cap >= 1).
     */
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        async (iterationCap) => {
          prCounter = 0;
          const store = new InMemorySessionStore();
          const gates: LoopGates = {
            runEditor: async () => ({ edits: [] }),
            runSensors: async () => passingSensors,
            runReviewer: async () => passingReviewer,
            runDeploy: async () => passingDeploy,
            runPostDeploy: async () => passingPostDeploy,
            openPR: makePROpener(),
          };

          const config: StopConditionConfig = { ...BASE_CONFIG, iterationCap };
          const result = await runLoop(buildOptions(gates, { store, config }));

          const stored = await store.read("session-test-001");
          return (
            stored.iterations.length === 1 &&
            result.terminationReason === "success"
          );
        }
      ),
      { numRuns: 50 }
    );
  });

  it("terminates with exactly iterationCap iterations when sensors always fail", async () => {
    const iterationCap = 3;
    const store = new InMemorySessionStore();
    let iterNum = 0;
    const gates: LoopGates = {
      runEditor: async () => ({
        edits: [{ path: "x.ts", diff: `diff-${iterNum++}` }],
      }),
      runSensors: async () => failingSensors,
      runReviewer: async () => passingReviewer,
      runDeploy: async () => passingDeploy,
      runPostDeploy: async () => passingPostDeploy,
      openPR: makePROpener(),
    };

    const config: StopConditionConfig = {
      ...BASE_CONFIG,
      iterationCap,
      oscillation: { sameDiffWindow: 0, alternationWindow: 0 },
    };

    const result = await runLoop(buildOptions(gates, { store, config }));

    const stored = await store.read("session-test-001");
    expect(stored.iterations.length).toBe(iterationCap);
    expect(result.terminationReason).toBe("iteration-cap");
  });
});

// ---------------------------------------------------------------------------
// Multi-iteration convergence
// ---------------------------------------------------------------------------

describe("runLoop — multi-iteration convergence", () => {
  beforeEach(() => { prCounter = 0; });

  it("succeeds on the second iteration when sensors fail on the first", async () => {
    let callCount = 0;
    const gates: LoopGates = {
      runEditor: async () => ({
        edits: [{ path: "x.ts", diff: `diff-${callCount}` }],
      }),
      runSensors: async () => {
        callCount++;
        return callCount === 1 ? failingSensors : passingSensors;
      },
      runReviewer: async () => passingReviewer,
      runDeploy: async () => passingDeploy,
      runPostDeploy: async () => passingPostDeploy,
      openPR: makePROpener(),
    };

    const result = await runLoop(buildOptions(gates));

    expect(result.terminationReason).toBe("success");
  });

  it("succeeds on the second iteration when reviewer fails on the first", async () => {
    let callCount = 0;
    const gates: LoopGates = {
      runEditor: async () => ({
        edits: [{ path: "x.ts", diff: `diff-${callCount}` }],
      }),
      runSensors: async () => passingSensors,
      runReviewer: async () => {
        callCount++;
        return callCount === 1 ? failingReviewer : passingReviewer;
      },
      runDeploy: async () => passingDeploy,
      runPostDeploy: async () => passingPostDeploy,
      openPR: makePROpener(),
    };

    const result = await runLoop(buildOptions(gates));

    expect(result.terminationReason).toBe("success");
  });

  it("succeeds on the second iteration when deploy fails on the first", async () => {
    let callCount = 0;
    const gates: LoopGates = {
      runEditor: async () => ({
        edits: [{ path: "x.ts", diff: `diff-${callCount}` }],
      }),
      runSensors: async () => passingSensors,
      runReviewer: async () => passingReviewer,
      runDeploy: async () => {
        callCount++;
        return callCount === 1 ? failingDeploy : passingDeploy;
      },
      runPostDeploy: async () => passingPostDeploy,
      openPR: makePROpener(),
    };

    const result = await runLoop(buildOptions(gates));

    expect(result.terminationReason).toBe("success");
  });

  it("succeeds on the second iteration when post-deploy fails on the first", async () => {
    let callCount = 0;
    const gates: LoopGates = {
      runEditor: async () => ({
        edits: [{ path: "x.ts", diff: `diff-${callCount}` }],
      }),
      runSensors: async () => passingSensors,
      runReviewer: async () => passingReviewer,
      runDeploy: async () => passingDeploy,
      runPostDeploy: async () => {
        callCount++;
        return callCount === 1 ? failingPostDeploy : passingPostDeploy;
      },
      openPR: makePROpener(),
    };

    const result = await runLoop(buildOptions(gates));

    expect(result.terminationReason).toBe("success");
  });

  it("passes stack outputs from deploy to post-deploy", async () => {
    let receivedStackOutputs: Record<string, string> | undefined;
    const gates: LoopGates = {
      runEditor: async () => ({ edits: [] }),
      runSensors: async () => passingSensors,
      runReviewer: async () => passingReviewer,
      runDeploy: async () => ({
        outcome: "ok",
        logs: "ok",
        stackOutputs: { ApiEndpointUrl: "https://api.example.com", QueueUrl: "https://sqs.example.com/queue" },
      }),
      runPostDeploy: async (stackOutputs) => {
        receivedStackOutputs = stackOutputs;
        return passingPostDeploy;
      },
      openPR: makePROpener(),
    };

    await runLoop(buildOptions(gates));

    expect(receivedStackOutputs).toEqual({
      ApiEndpointUrl: "https://api.example.com",
      QueueUrl: "https://sqs.example.com/queue",
    });
  });
});
