/**
 * Unit tests for `adaptReviewerResultToReviewerResult`.
 *
 * Covers the verification matrix from tasks.md task 6.5:
 *   - Empty findings → `passed: true`, empty `severityCounts`.
 *   - Mixed-severity findings → `passed` is false when the threshold is
 *     breached, correct `severityCounts`.
 *   - Matches `agents/reviewer/agent.ts`'s validation logic (same severity
 *     order, same threshold comparison semantics).
 *
 * `adaptReviewerResultToReviewerResult` is a pure function: no I/O, no
 * side effects, deterministic output for any given input. All tests call
 * it directly without any stubs or mocks.
 *
 * Requirements: 4.3
 */

import {
  adaptReviewerResultToReviewerResult,
  type StandaloneReviewerResultInput,
} from "../index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal finding with the given severity. */
function makeFinding(
  severity: string,
  id = "WA-SEC-01",
): StandaloneReviewerResultInput["findings"][number] {
  return {
    id,
    pillar: "Security",
    severity,
    description: "A test finding.",
    suggestedFix: "Fix it.",
  };
}

/** Build a StandaloneReviewerResultInput with the given findings. */
function makeResult(
  findings: StandaloneReviewerResultInput["findings"],
): StandaloneReviewerResultInput {
  return {
    findings,
    tokenCostUSD: 0.01,
    modelVersion: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  };
}

// ---------------------------------------------------------------------------
// Empty findings
// ---------------------------------------------------------------------------

describe("adaptReviewerResultToReviewerResult — empty findings", () => {
  test("returns passed: true when there are no findings", () => {
    const result = adaptReviewerResultToReviewerResult(makeResult([]));
    expect(result.passed).toBe(true);
  });

  test("returns an empty severityCounts when there are no findings", () => {
    const result = adaptReviewerResultToReviewerResult(makeResult([]));
    expect(result.severityCounts).toEqual({});
  });

  test("returns the findings array unchanged (empty)", () => {
    const result = adaptReviewerResultToReviewerResult(makeResult([]));
    expect(result.findings).toEqual([]);
  });

  test("passed: true regardless of the threshold when findings is empty", () => {
    for (const threshold of ["info", "low", "medium", "high", "critical"]) {
      const result = adaptReviewerResultToReviewerResult(
        makeResult([]),
        threshold,
      );
      expect(result.passed).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// severityCounts computation
// ---------------------------------------------------------------------------

describe("adaptReviewerResultToReviewerResult — severityCounts", () => {
  test("counts a single finding by its severity", () => {
    const result = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("high")]),
    );
    expect(result.severityCounts).toEqual({ high: 1 });
  });

  test("counts multiple findings of the same severity", () => {
    const result = adaptReviewerResultToReviewerResult(
      makeResult([
        makeFinding("medium", "WA-SEC-01"),
        makeFinding("medium", "WA-SEC-02"),
        makeFinding("medium", "WA-SEC-03"),
      ]),
    );
    expect(result.severityCounts).toEqual({ medium: 3 });
  });

  test("counts findings across all five severity levels", () => {
    const result = adaptReviewerResultToReviewerResult(
      makeResult([
        makeFinding("info", "WA-A"),
        makeFinding("low", "WA-B"),
        makeFinding("medium", "WA-C"),
        makeFinding("high", "WA-D"),
        makeFinding("critical", "WA-E"),
      ]),
    );
    expect(result.severityCounts).toEqual({
      info: 1,
      low: 1,
      medium: 1,
      high: 1,
      critical: 1,
    });
  });

  test("counts mixed-severity findings correctly", () => {
    const result = adaptReviewerResultToReviewerResult(
      makeResult([
        makeFinding("high", "WA-A"),
        makeFinding("medium", "WA-B"),
        makeFinding("high", "WA-C"),
        makeFinding("low", "WA-D"),
        makeFinding("high", "WA-E"),
      ]),
    );
    expect(result.severityCounts).toEqual({ high: 3, medium: 1, low: 1 });
  });
});

// ---------------------------------------------------------------------------
// passed computation — default threshold (MEDIUM)
// ---------------------------------------------------------------------------

describe("adaptReviewerResultToReviewerResult — passed with default threshold (MEDIUM)", () => {
  test("passed: true when all findings are below MEDIUM (info only)", () => {
    const result = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("info")]),
    );
    expect(result.passed).toBe(true);
  });

  test("passed: true when all findings are below MEDIUM (low only)", () => {
    const result = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("low")]),
    );
    expect(result.passed).toBe(true);
  });

  test("passed: false when a finding is exactly at MEDIUM", () => {
    const result = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("medium")]),
    );
    expect(result.passed).toBe(false);
  });

  test("passed: false when a finding is above MEDIUM (high)", () => {
    const result = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("high")]),
    );
    expect(result.passed).toBe(false);
  });

  test("passed: false when a finding is above MEDIUM (critical)", () => {
    const result = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("critical")]),
    );
    expect(result.passed).toBe(false);
  });

  test("passed: false when mixed findings include one at MEDIUM", () => {
    const result = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("info"), makeFinding("low"), makeFinding("medium")]),
    );
    expect(result.passed).toBe(false);
  });

  test("passed: true when mixed findings are all below MEDIUM", () => {
    const result = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("info"), makeFinding("low")]),
    );
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// passed computation — explicit threshold variations
// ---------------------------------------------------------------------------

describe("adaptReviewerResultToReviewerResult — passed with explicit thresholds", () => {
  test("threshold=info: passed: false for any finding (info is at threshold)", () => {
    const result = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("info")]),
      "info",
    );
    expect(result.passed).toBe(false);
  });

  test("threshold=low: passed: true for info-only findings", () => {
    const result = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("info")]),
      "low",
    );
    expect(result.passed).toBe(true);
  });

  test("threshold=low: passed: false for a low-severity finding", () => {
    const result = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("low")]),
      "low",
    );
    expect(result.passed).toBe(false);
  });

  test("threshold=high: passed: true for medium findings", () => {
    const result = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("medium")]),
      "high",
    );
    expect(result.passed).toBe(true);
  });

  test("threshold=high: passed: false for a high-severity finding", () => {
    const result = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("high")]),
      "high",
    );
    expect(result.passed).toBe(false);
  });

  test("threshold=critical: passed: true for high findings", () => {
    const result = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("high")]),
      "critical",
    );
    expect(result.passed).toBe(true);
  });

  test("threshold=critical: passed: false for a critical finding", () => {
    const result = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("critical")]),
      "critical",
    );
    expect(result.passed).toBe(false);
  });

  test("threshold is compared case-insensitively (MEDIUM vs medium)", () => {
    const lower = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("medium")]),
      "medium",
    );
    const upper = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("medium")]),
      "MEDIUM",
    );
    expect(lower.passed).toBe(upper.passed);
    expect(lower.passed).toBe(false);
  });

  test("threshold is compared case-insensitively (HIGH vs high)", () => {
    const lower = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("high")]),
      "high",
    );
    const upper = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("high")]),
      "HIGH",
    );
    expect(lower.passed).toBe(upper.passed);
    expect(lower.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unknown severity values
// ---------------------------------------------------------------------------

describe("adaptReviewerResultToReviewerResult — unknown severity values", () => {
  test("unknown finding severity is treated as below threshold (does not block)", () => {
    // An unknown severity in a finding should not cause the adapter to
    // block the loop — it is treated as below the threshold.
    const result = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("blocker")]),
      "medium",
    );
    expect(result.passed).toBe(true);
  });

  test("unknown threshold with no findings → passed: true (fail-closed only when findings exist)", () => {
    // When the threshold is unknown and there are no findings, passed is true.
    const result = adaptReviewerResultToReviewerResult(
      makeResult([]),
      "unknown-threshold",
    );
    expect(result.passed).toBe(true);
  });

  test("unknown threshold with findings → passed: false (fail-closed)", () => {
    // When the threshold is unknown and there are findings, the adapter
    // fails closed: passed = false.
    const result = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("info")]),
      "unknown-threshold",
    );
    expect(result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

describe("adaptReviewerResultToReviewerResult — output shape", () => {
  test("passes the findings array through unchanged", () => {
    const findings = [makeFinding("high", "WA-SEC-01")];
    const result = adaptReviewerResultToReviewerResult(makeResult(findings));
    expect(result.findings).toBe(findings);
  });

  test("does not include tokenCostUSD in the output", () => {
    const result = adaptReviewerResultToReviewerResult(makeResult([]));
    expect(result).not.toHaveProperty("tokenCostUSD");
  });

  test("does not include modelVersion in the output", () => {
    const result = adaptReviewerResultToReviewerResult(makeResult([]));
    expect(result).not.toHaveProperty("modelVersion");
  });

  test("output has exactly the three expected keys", () => {
    const result = adaptReviewerResultToReviewerResult(makeResult([]));
    expect(Object.keys(result).sort()).toEqual(
      ["findings", "passed", "severityCounts"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Matches agents/reviewer/agent.ts validation logic
// ---------------------------------------------------------------------------

describe("adaptReviewerResultToReviewerResult — matches reviewer agent validation logic", () => {
  /**
   * The reviewer agent's output schema (in agents/reviewer/agent.ts) uses
   * the severity enum: ["info", "low", "medium", "high", "critical"].
   * The adapter must use the same order for threshold comparisons.
   *
   * These tests verify the severity ordering is consistent with the
   * reviewer's declared severity vocabulary.
   */
  const SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"] as const;

  test("each severity level blocks when used as both finding and threshold", () => {
    for (const sev of SEVERITY_ORDER) {
      const result = adaptReviewerResultToReviewerResult(
        makeResult([makeFinding(sev)]),
        sev,
      );
      expect(result.passed).toBe(false);
    }
  });

  test("a finding below the threshold does not block", () => {
    // For each adjacent pair (lower, upper), a finding at `lower` with
    // threshold `upper` should pass.
    for (let i = 0; i < SEVERITY_ORDER.length - 1; i++) {
      const findingSev = SEVERITY_ORDER[i];
      const threshold = SEVERITY_ORDER[i + 1];
      const result = adaptReviewerResultToReviewerResult(
        makeResult([makeFinding(findingSev)]),
        threshold,
      );
      expect(result.passed).toBe(true);
    }
  });

  test("a finding above the threshold blocks", () => {
    // For each adjacent pair (lower, upper), a finding at `upper` with
    // threshold `lower` should fail.
    for (let i = 0; i < SEVERITY_ORDER.length - 1; i++) {
      const threshold = SEVERITY_ORDER[i];
      const findingSev = SEVERITY_ORDER[i + 1];
      const result = adaptReviewerResultToReviewerResult(
        makeResult([makeFinding(findingSev)]),
        threshold,
      );
      expect(result.passed).toBe(false);
    }
  });

  test("a mix of below-threshold and at-threshold findings blocks (any finding at or above threshold fails)", () => {
    // info + medium with threshold=medium → fails because medium >= medium
    const result = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("info"), makeFinding("medium")]),
      "medium",
    );
    expect(result.passed).toBe(false);
  });

  test("all findings strictly below threshold → passes", () => {
    // info + low with threshold=medium → passes
    const result = adaptReviewerResultToReviewerResult(
      makeResult([makeFinding("info"), makeFinding("low")]),
      "medium",
    );
    expect(result.passed).toBe(true);
  });
});
