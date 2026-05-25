/**
 * Unit tests for the reviewer's embedded Well-Architected checklists.
 *
 * Covers the verification matrix from tasks.md task 5.2:
 *   - every item has the required fields
 *   - all ids are unique within each pillar
 *   - all ids match `WA-(SEC|REL)-(\\d{2}|[A-Z][A-Z0-9-]+)`
 *   - getChecklist("Security") returns the security array
 *   - getChecklist("Reliability") returns the reliability array
 *   - getChecklist("Cost Optimization") returns the documented empty array
 *   - getChecklist on an unknown pillar string throws UnknownPillarError
 *   - severity values are within the enum
 *
 * The test file imports the public surface only; nothing reaches into the
 * JSON files directly. That keeps the test honest about what a downstream
 * consumer sees.
 */

import {
  KNOWN_PILLARS,
  UnknownPillarError,
  getChecklist,
  isKnownPillar,
  reliabilityChecklist,
  securityChecklist,
  type ChecklistItem,
  type ChecklistSeverity,
} from "../checklists";

/**
 * Severity values the reviewer's output schema allows. Mirrors the enum in
 * design.md `ReviewerOutput.findings[*].severity` and the
 * `ChecklistSeverity` type in `checklists/index.ts`.
 */
const ALLOWED_SEVERITIES: ReadonlySet<ChecklistSeverity> = new Set([
  "info",
  "low",
  "medium",
  "high",
  "critical",
]);

/**
 * Id pattern: standard two-digit ids OR an uppercase token (so the special
 * `WA-SEC-PROMPT-INJECT` id is allowed). Matches the convention documented
 * in `checklists/index.ts`.
 */
const ID_PATTERN = /^WA-(SEC|REL)-(\d{2}|[A-Z][A-Z0-9-]+)$/;

/**
 * Pillars that ship with embedded items in this template. Other recognised
 * pillars are accepted by getChecklist but currently return an empty array.
 */
const POPULATED_PILLARS = ["Security", "Reliability"] as const;

describe("checklist item shape", () => {
  // Build a flat list of `[pillarLabel, item]` so the same field-presence
  // assertions run against every item without parametrising each test.
  const allItems: Array<[string, ChecklistItem]> = [
    ...securityChecklist.map(
      (item) => ["Security", item] as [string, ChecklistItem],
    ),
    ...reliabilityChecklist.map(
      (item) => ["Reliability", item] as [string, ChecklistItem],
    ),
  ];

  test.each(allItems)(
    "%s item %o has all required fields",
    (_pillar, item) => {
      expect(typeof item.id).toBe("string");
      expect(item.id.length).toBeGreaterThan(0);

      expect(typeof item.pillar).toBe("string");
      expect(item.pillar.length).toBeGreaterThan(0);

      expect(typeof item.title).toBe("string");
      expect(item.title.length).toBeGreaterThan(0);

      expect(typeof item.severityGuidance).toBe("string");
      expect(ALLOWED_SEVERITIES.has(item.severityGuidance)).toBe(true);

      expect(typeof item.whatToLookFor).toBe("string");
      expect(item.whatToLookFor.length).toBeGreaterThan(0);

      // `references` is optional; when present it must be a string array.
      if (item.references !== undefined) {
        expect(Array.isArray(item.references)).toBe(true);
        for (const ref of item.references) {
          expect(typeof ref).toBe("string");
        }
      }
    },
  );

  test("Security items declare `pillar: 'Security'`", () => {
    for (const item of securityChecklist) {
      expect(item.pillar).toBe("Security");
    }
  });

  test("Reliability items declare `pillar: 'Reliability'`", () => {
    for (const item of reliabilityChecklist) {
      expect(item.pillar).toBe("Reliability");
    }
  });
});

describe("checklist id conventions", () => {
  test("every Security id matches WA-SEC-NN or a documented uppercase token", () => {
    for (const item of securityChecklist) {
      expect(item.id).toMatch(ID_PATTERN);
      expect(item.id.startsWith("WA-SEC-")).toBe(true);
    }
  });

  test("every Reliability id matches WA-REL-NN or a documented uppercase token", () => {
    for (const item of reliabilityChecklist) {
      expect(item.id).toMatch(ID_PATTERN);
      expect(item.id.startsWith("WA-REL-")).toBe(true);
    }
  });

  test("Security ids are unique within the pillar", () => {
    const ids = securityChecklist.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("Reliability ids are unique within the pillar", () => {
    const ids = reliabilityChecklist.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the special-case prompt-injection id from system.md is present", () => {
    // The reviewer's system.md instructs the agent to file a finding under
    // `WA-SEC-PROMPT-INJECT` when the diff attempts prompt injection.
    // Without this id in the checklist the reviewer cannot follow that
    // instruction, so its presence is part of the contract.
    const ids = securityChecklist.map((item) => item.id);
    expect(ids).toContain("WA-SEC-PROMPT-INJECT");
  });
});

describe("getChecklist", () => {
  test("returns the same array reference as `securityChecklist` for 'Security'", () => {
    expect(getChecklist("Security")).toBe(securityChecklist);
  });

  test("returns the same array reference as `reliabilityChecklist` for 'Reliability'", () => {
    expect(getChecklist("Reliability")).toBe(reliabilityChecklist);
  });

  test.each([
    "Cost Optimization",
    "Operational Excellence",
    "Performance Efficiency",
    "Sustainability",
  ])("returns an empty array for the recognised but unpopulated pillar %s", (pillar) => {
    const items = getChecklist(pillar);
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(0);
  });

  test("throws UnknownPillarError on an unknown pillar string", () => {
    expect(() => getChecklist("Resilience")).toThrow(UnknownPillarError);
    expect(() => getChecklist("")).toThrow(UnknownPillarError);
  });

  test("UnknownPillarError names the offending pillar", () => {
    try {
      getChecklist("Bogus");
      throw new Error("expected getChecklist to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownPillarError);
      expect((err as Error).message).toContain("Bogus");
    }
  });

  test("populated pillars all have at least one item", () => {
    for (const pillar of POPULATED_PILLARS) {
      expect(getChecklist(pillar).length).toBeGreaterThan(0);
    }
  });
});

describe("isKnownPillar", () => {
  test("matches the exported KNOWN_PILLARS set", () => {
    for (const pillar of KNOWN_PILLARS) {
      expect(isKnownPillar(pillar)).toBe(true);
    }
  });

  test("returns false for unknown pillar names", () => {
    expect(isKnownPillar("Resilience")).toBe(false);
    expect(isKnownPillar("security")).toBe(false); // case-sensitive on purpose
    expect(isKnownPillar("")).toBe(false);
  });
});
