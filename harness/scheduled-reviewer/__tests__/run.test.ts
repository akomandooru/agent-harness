/**
 * Unit tests for `harness/scheduled-reviewer/src/run.ts`.
 *
 * Covers:
 *   - `parseScheduledReviewerConfig`: valid config, missing fields, malformed JSON
 *   - `buildRunId`: pure function
 *   - `countFindingsBySeverity`: pure function
 *   - `runScheduledReviewer()`: kill-switch, cost-cap, success path, error path
 *
 * All tests inject a stub `StandaloneReviewerInvocation` via the
 * `reviewerInvocation` option so no real AWS SDK calls are made.
 * This replaces the prior pattern of asserting that the old
 * `StrandsReviewerInvocation` stub throws `StrandsNotImplementedError`
 * on every call — the real flow is now tested end-to-end through
 * `runScheduledReviewer()` with a controlled stub.
 *
 * Requirements: 2.4
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

import {
  parseScheduledReviewerConfig,
  buildRunId,
  countFindingsBySeverity,
  runScheduledReviewer,
  type StandaloneReviewerInvocation,
  type StandaloneReviewerResult,
} from "../src/run";
import type { ReviewerFinding } from "../../shared/src/fitness-gap-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid `agent-harness.config.json` content for tests. */
function makeValidConfigJson(overrides: Record<string, unknown> = {}): string {
  const base = {
    models: { reviewer: "anthropic.claude-sonnet-4-5-v1:0" },
    fitnessGapLoop: {
      enabled: true,
      costGuardrail: { reviewerTokenSpendCapUSD: 2.0 },
    },
    ...overrides,
  };
  return JSON.stringify(base);
}

/** A minimal valid `ReviewerFinding`. */
function makeFinding(
  partial: Partial<ReviewerFinding> = {},
): ReviewerFinding {
  return {
    id: "WA-SEC-01",
    pillar: "Security",
    severity: "high",
    description: "Missing encryption at rest.",
    suggestedFix: "Enable SSE on the S3 bucket.",
    ...partial,
  };
}

/** A stub `StandaloneReviewerInvocation` that returns a fixed result. */
function makeStubInvocation(
  result: StandaloneReviewerResult,
): StandaloneReviewerInvocation {
  return {
    invoke: async () => result,
  };
}

/** A stub `StandaloneReviewerInvocation` that throws. */
function makeThrowingInvocation(error: Error): StandaloneReviewerInvocation {
  return {
    invoke: async () => {
      throw error;
    },
  };
}

/**
 * Write a temporary config file and return its path.
 * Uses a unique subdirectory per test to avoid collisions.
 */
function writeTempConfig(content: string, label: string): string {
  const dir = join(tmpdir(), `scheduled-reviewer-test-${label}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "agent-harness.config.json");
  writeFileSync(configPath, content, "utf8");
  return configPath;
}

/**
 * Write a temporary findings output path and return it.
 */
function makeTempFindingsPath(label: string): string {
  const dir = join(tmpdir(), `scheduled-reviewer-findings-${label}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "reviewer-findings.json");
}

// ---------------------------------------------------------------------------
// parseScheduledReviewerConfig
// ---------------------------------------------------------------------------

describe("parseScheduledReviewerConfig", () => {
  it("parses a valid config and returns the expected fields", () => {
    const raw = makeValidConfigJson();
    const result = parseScheduledReviewerConfig(raw, "test-config.json");

    expect(result.modelId).toBe("anthropic.claude-sonnet-4-5-v1:0");
    expect(result.enabled).toBe(true);
    expect(result.costCapUSD).toBe(2.0);
  });

  it("parses a config with enabled=false", () => {
    const raw = makeValidConfigJson({
      fitnessGapLoop: {
        enabled: false,
        costGuardrail: { reviewerTokenSpendCapUSD: 1.5 },
      },
    });
    const result = parseScheduledReviewerConfig(raw, "test-config.json");
    expect(result.enabled).toBe(false);
  });

  it("throws on malformed JSON", () => {
    expect(() =>
      parseScheduledReviewerConfig("not-json", "bad.json"),
    ).toThrow(/bad\.json.*not valid JSON/);
  });

  it("throws when the root is not an object", () => {
    expect(() =>
      parseScheduledReviewerConfig('"a string"', "bad.json"),
    ).toThrow(/expected a JSON object/);
  });

  it("throws when models is missing", () => {
    const raw = JSON.stringify({
      fitnessGapLoop: {
        enabled: true,
        costGuardrail: { reviewerTokenSpendCapUSD: 1.0 },
      },
    });
    expect(() =>
      parseScheduledReviewerConfig(raw, "bad.json"),
    ).toThrow(/missing required 'models' object/);
  });

  it("throws when models.reviewer is missing", () => {
    const raw = JSON.stringify({
      models: {},
      fitnessGapLoop: {
        enabled: true,
        costGuardrail: { reviewerTokenSpendCapUSD: 1.0 },
      },
    });
    expect(() =>
      parseScheduledReviewerConfig(raw, "bad.json"),
    ).toThrow(/missing required 'models\.reviewer' string/);
  });

  it("throws when fitnessGapLoop is missing", () => {
    const raw = JSON.stringify({
      models: { reviewer: "some-model" },
    });
    expect(() =>
      parseScheduledReviewerConfig(raw, "bad.json"),
    ).toThrow(/missing required 'fitnessGapLoop' object/);
  });

  it("throws when fitnessGapLoop.enabled is not a boolean", () => {
    const raw = JSON.stringify({
      models: { reviewer: "some-model" },
      fitnessGapLoop: {
        enabled: "yes",
        costGuardrail: { reviewerTokenSpendCapUSD: 1.0 },
      },
    });
    expect(() =>
      parseScheduledReviewerConfig(raw, "bad.json"),
    ).toThrow(/'fitnessGapLoop\.enabled' must be a boolean/);
  });

  it("throws when costGuardrail is missing", () => {
    const raw = JSON.stringify({
      models: { reviewer: "some-model" },
      fitnessGapLoop: { enabled: true },
    });
    expect(() =>
      parseScheduledReviewerConfig(raw, "bad.json"),
    ).toThrow(/missing required 'fitnessGapLoop\.costGuardrail' object/);
  });

  it("throws when reviewerTokenSpendCapUSD is not a number", () => {
    const raw = JSON.stringify({
      models: { reviewer: "some-model" },
      fitnessGapLoop: {
        enabled: true,
        costGuardrail: { reviewerTokenSpendCapUSD: "two" },
      },
    });
    expect(() =>
      parseScheduledReviewerConfig(raw, "bad.json"),
    ).toThrow(/'fitnessGapLoop\.costGuardrail\.reviewerTokenSpendCapUSD' must be a non-negative number/);
  });

  it("throws when reviewerTokenSpendCapUSD is negative", () => {
    const raw = JSON.stringify({
      models: { reviewer: "some-model" },
      fitnessGapLoop: {
        enabled: true,
        costGuardrail: { reviewerTokenSpendCapUSD: -1 },
      },
    });
    expect(() =>
      parseScheduledReviewerConfig(raw, "bad.json"),
    ).toThrow(/'fitnessGapLoop\.costGuardrail\.reviewerTokenSpendCapUSD' must be a non-negative number/);
  });
});

// ---------------------------------------------------------------------------
// buildRunId
// ---------------------------------------------------------------------------

describe("buildRunId", () => {
  it("prefixes the timestamp with 'scheduled-reviewer-run-'", () => {
    const id = buildRunId("2025-01-15T06:00:00.000Z");
    expect(id).toMatch(/^scheduled-reviewer-run-/);
  });

  it("replaces colons with hyphens so the id is file-safe", () => {
    const id = buildRunId("2025-01-15T06:00:00.000Z");
    expect(id).not.toContain(":");
    expect(id).toBe("scheduled-reviewer-run-2025-01-15T06-00-00.000Z");
  });
});

// ---------------------------------------------------------------------------
// countFindingsBySeverity
// ---------------------------------------------------------------------------

describe("countFindingsBySeverity", () => {
  it("returns an empty object for an empty findings array", () => {
    expect(countFindingsBySeverity([])).toEqual({});
  });

  it("counts a single finding correctly", () => {
    const findings = [makeFinding({ severity: "high" })];
    expect(countFindingsBySeverity(findings)).toEqual({ high: 1 });
  });

  it("counts multiple findings across severities", () => {
    const findings = [
      makeFinding({ id: "A", severity: "high" }),
      makeFinding({ id: "B", severity: "critical" }),
      makeFinding({ id: "C", severity: "high" }),
      makeFinding({ id: "D", severity: "info" }),
    ];
    expect(countFindingsBySeverity(findings)).toEqual({
      high: 2,
      critical: 1,
      info: 1,
    });
  });

  it("only includes severities that appear in the findings", () => {
    const findings = [makeFinding({ severity: "medium" })];
    const counts = countFindingsBySeverity(findings);
    expect(Object.keys(counts)).toEqual(["medium"]);
  });
});

// ---------------------------------------------------------------------------
// runScheduledReviewer — kill switch
// ---------------------------------------------------------------------------

describe("runScheduledReviewer — kill switch", () => {
  it("returns null immediately when fitnessGapLoop.enabled is false", async () => {
    const configPath = writeTempConfig(
      makeValidConfigJson({
        fitnessGapLoop: {
          enabled: false,
          costGuardrail: { reviewerTokenSpendCapUSD: 2.0 },
        },
      }),
      "killswitch",
    );

    // The invocation stub should never be called when the kill switch fires.
    let invoked = false;
    const stub: StandaloneReviewerInvocation = {
      invoke: async () => {
        invoked = true;
        return {
          findings: [],
          tokenCostUSD: 0,
          modelVersion: "test",
        };
      },
    };

    const result = await runScheduledReviewer({
      configPath,
      reviewerInvocation: stub,
      findingsOutputPath: makeTempFindingsPath("killswitch"),
    });

    expect(result).toBeNull();
    expect(invoked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runScheduledReviewer — success path
// ---------------------------------------------------------------------------

describe("runScheduledReviewer — success path", () => {
  it("returns the reviewer result and writes findings to the output path", async () => {
    const finding = makeFinding({ id: "WA-REL-01", severity: "medium" });
    const stubResult: StandaloneReviewerResult = {
      findings: [finding],
      tokenCostUSD: 0.5,
      modelVersion: "claude-sonnet-4-5",
    };

    const configPath = writeTempConfig(makeValidConfigJson(), "success");
    const findingsOutputPath = makeTempFindingsPath("success");

    const result = await runScheduledReviewer({
      configPath,
      reviewerInvocation: makeStubInvocation(stubResult),
      findingsOutputPath,
    });

    expect(result).not.toBeNull();
    expect(result!.findings).toHaveLength(1);
    expect(result!.findings[0].id).toBe("WA-REL-01");
    expect(result!.tokenCostUSD).toBe(0.5);
    expect(result!.modelVersion).toBe("claude-sonnet-4-5");

    // Findings must be written to the output path as a JSON array.
    const written = JSON.parse(readFileSync(findingsOutputPath, "utf8")) as unknown[];
    expect(written).toHaveLength(1);
    expect((written[0] as ReviewerFinding).id).toBe("WA-REL-01");
  });

  it("writes an empty array when the reviewer returns no findings", async () => {
    const stubResult: StandaloneReviewerResult = {
      findings: [],
      tokenCostUSD: 0.1,
      modelVersion: "claude-sonnet-4-5",
    };

    const configPath = writeTempConfig(makeValidConfigJson(), "empty-findings");
    const findingsOutputPath = makeTempFindingsPath("empty-findings");

    const result = await runScheduledReviewer({
      configPath,
      reviewerInvocation: makeStubInvocation(stubResult),
      findingsOutputPath,
    });

    expect(result).not.toBeNull();
    expect(result!.findings).toHaveLength(0);

    const written = JSON.parse(readFileSync(findingsOutputPath, "utf8")) as unknown[];
    expect(written).toHaveLength(0);
  });

  it("passes no diff to the invocation in scheduled mode (invoke called with no input)", async () => {
    let capturedInput: Parameters<StandaloneReviewerInvocation["invoke"]>[0];

    const stub: StandaloneReviewerInvocation = {
      invoke: async (input) => {
        capturedInput = input;
        return { findings: [], tokenCostUSD: 0, modelVersion: "test" };
      },
    };

    const configPath = writeTempConfig(makeValidConfigJson(), "no-diff");
    const findingsOutputPath = makeTempFindingsPath("no-diff");

    await runScheduledReviewer({
      configPath,
      reviewerInvocation: stub,
      findingsOutputPath,
    });

    // runScheduledReviewer calls invocation.invoke() with no argument
    // (scheduled mode — the reviewer reads the module state directly).
    expect(capturedInput).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runScheduledReviewer — cost cap exceeded
// ---------------------------------------------------------------------------

describe("runScheduledReviewer — cost cap exceeded", () => {
  it("exits the process with code 1 when tokenCostUSD exceeds the cap", async () => {
    const stubResult: StandaloneReviewerResult = {
      findings: [makeFinding()],
      tokenCostUSD: 5.0, // exceeds the 2.0 cap in the config
      modelVersion: "claude-sonnet-4-5",
    };

    const configPath = writeTempConfig(makeValidConfigJson(), "cost-cap");
    const findingsOutputPath = makeTempFindingsPath("cost-cap");

    // process.exit(1) is called inside runScheduledReviewer when the cap
    // is exceeded. We mock it to prevent the test process from actually
    // exiting.
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((_code?: string | number | null | undefined) => {
        throw new Error("process.exit called");
      });

    try {
      await expect(
        runScheduledReviewer({
          configPath,
          reviewerInvocation: makeStubInvocation(stubResult),
          findingsOutputPath,
        }),
      ).rejects.toThrow("process.exit called");

      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("does not write findings when the cost cap is exceeded", async () => {
    const stubResult: StandaloneReviewerResult = {
      findings: [makeFinding()],
      tokenCostUSD: 99.0, // far exceeds the cap
      modelVersion: "claude-sonnet-4-5",
    };

    const configPath = writeTempConfig(makeValidConfigJson(), "cost-cap-no-write");
    const findingsOutputPath = makeTempFindingsPath("cost-cap-no-write");

    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((_code?: string | number | null | undefined) => {
        throw new Error("process.exit called");
      });

    try {
      await expect(
        runScheduledReviewer({
          configPath,
          reviewerInvocation: makeStubInvocation(stubResult),
          findingsOutputPath,
        }),
      ).rejects.toThrow("process.exit called");
    } finally {
      exitSpy.mockRestore();
    }

    // The findings file should not have been written.
    expect(() => readFileSync(findingsOutputPath, "utf8")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// runScheduledReviewer — reviewer invocation error
// ---------------------------------------------------------------------------

describe("runScheduledReviewer — reviewer invocation error", () => {
  it("propagates errors thrown by the reviewer invocation", async () => {
    const invocationError = new Error("InvokeHarness: access denied");

    const configPath = writeTempConfig(makeValidConfigJson(), "invoke-error");
    const findingsOutputPath = makeTempFindingsPath("invoke-error");

    await expect(
      runScheduledReviewer({
        configPath,
        reviewerInvocation: makeThrowingInvocation(invocationError),
        findingsOutputPath,
      }),
    ).rejects.toThrow("InvokeHarness: access denied");
  });

  it("does not write findings when the invocation throws", async () => {
    const configPath = writeTempConfig(makeValidConfigJson(), "invoke-error-no-write");
    const findingsOutputPath = makeTempFindingsPath("invoke-error-no-write");

    await expect(
      runScheduledReviewer({
        configPath,
        reviewerInvocation: makeThrowingInvocation(new Error("SDK error")),
        findingsOutputPath,
      }),
    ).rejects.toThrow("SDK error");

    // The findings file should not have been written.
    expect(() => readFileSync(findingsOutputPath, "utf8")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// runScheduledReviewer — config errors
// ---------------------------------------------------------------------------

describe("runScheduledReviewer — config errors", () => {
  it("throws when the config file does not exist", async () => {
    await expect(
      runScheduledReviewer({
        configPath: "/nonexistent/path/agent-harness.config.json",
        reviewerInvocation: makeStubInvocation({
          findings: [],
          tokenCostUSD: 0,
          modelVersion: "test",
        }),
        findingsOutputPath: makeTempFindingsPath("config-missing"),
      }),
    ).rejects.toThrow();
  });

  it("throws when the config file contains invalid JSON", async () => {
    const configPath = writeTempConfig("not-valid-json", "bad-json");

    await expect(
      runScheduledReviewer({
        configPath,
        reviewerInvocation: makeStubInvocation({
          findings: [],
          tokenCostUSD: 0,
          modelVersion: "test",
        }),
        findingsOutputPath: makeTempFindingsPath("bad-json"),
      }),
    ).rejects.toThrow(/not valid JSON/);
  });
});
