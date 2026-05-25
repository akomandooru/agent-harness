/**
 * Embedded Well-Architected reference checklists for the reviewer agent.
 *
 * The reviewer's `reference.checklist` tool calls `getChecklist(pillar)` and
 * returns `{ items }` to the agent. JSON files are the source of truth so a
 * forker can edit pillar items without touching TypeScript; `index.ts` loads
 * them at module init and exposes them as typed arrays.
 *
 * Embedded (not fetched) per design.md deferred-decisions: leaning toward
 * embedded for forkability. A fork that wants checklists in S3 can replace
 * the imports below without changing the public surface.
 *
 * Conventions:
 *   - One JSON file per pillar, located alongside this file.
 *   - Item ids follow `WA-<PILLAR_SHORT>-<NN>` (two digits) by default;
 *     special-purpose ids may use an uppercase token instead of digits
 *     (e.g. `WA-SEC-PROMPT-INJECT`). The id pattern enforced by the tests
 *     is `WA-(SEC|REL)-(\\d{2}|[A-Z][A-Z0-9-]+)`.
 *   - `getChecklist` returns the embedded array for known pillars
 *     (`Security`, `Reliability`). Other Well-Architected pillars
 *     (`Cost Optimization`, `Operational Excellence`, `Performance Efficiency`,
 *     `Sustainability`) are recognised but currently ship without items;
 *     `getChecklist` returns `[]` for them. Unknown pillar names throw
 *     `UnknownPillarError` because that is a programmer error, not a
 *     runtime condition the reviewer can recover from.
 */

import securityRaw from "./security.json";
import reliabilityRaw from "./reliability.json";

/**
 * Severity guidance attached to each checklist item. Matches the
 * `ReviewerOutput.findings[*].severity` enum from `design.md`.
 *
 * The severity on a checklist item is a *baseline* the reviewer uses when
 * filing a finding against that item; the reviewer can raise or lower the
 * severity for a specific finding when the diff context warrants it.
 */
export type ChecklistSeverity =
  | "info"
  | "low"
  | "medium"
  | "high"
  | "critical";

/**
 * One checklist item. Schema mirrors the JSON files under this directory.
 */
export type ChecklistItem = {
  /**
   * Stable identifier the reviewer cites in `findings[*].id`. Either
   * `WA-SEC-NN`, `WA-REL-NN`, or a special token like
   * `WA-SEC-PROMPT-INJECT`.
   */
  id: string;

  /** Pillar this item belongs to. Matches `WellArchitectedPillar`. */
  pillar: WellArchitectedPillar;

  /** Short imperative title; one line. */
  title: string;

  /**
   * Baseline severity for findings filed against this item. The reviewer
   * may pick a different severity for a specific finding when the diff
   * context calls for it.
   */
  severityGuidance: ChecklistSeverity;

  /** One to three sentences describing the gap the item targets. */
  whatToLookFor: string;

  /** Optional: AWS docs URLs supporting the item. */
  references?: string[];
};

/**
 * Well-Architected pillars the reviewer recognises. Only `Security` and
 * `Reliability` ship with embedded items in this template; the others are
 * accepted by `getChecklist` for forward-compatibility but return an empty
 * array.
 */
export type WellArchitectedPillar =
  | "Security"
  | "Reliability"
  | "Cost Optimization"
  | "Operational Excellence"
  | "Performance Efficiency"
  | "Sustainability";

/**
 * The set of pillars `getChecklist` accepts without throwing.
 *
 * Exported so tests and the reviewer wrapper can validate input against the
 * exact same list this module honours.
 */
export const KNOWN_PILLARS: readonly WellArchitectedPillar[] = [
  "Security",
  "Reliability",
  "Cost Optimization",
  "Operational Excellence",
  "Performance Efficiency",
  "Sustainability",
] as const;

/**
 * Thrown by `getChecklist` when the caller passes a pillar name that is
 * not in `KNOWN_PILLARS`. Programmer error; not retryable at runtime.
 */
export class UnknownPillarError extends Error {
  constructor(pillar: string) {
    super(
      `Unknown Well-Architected pillar: ${JSON.stringify(pillar)}. ` +
        `Expected one of: ${KNOWN_PILLARS.join(", ")}.`,
    );
    this.name = "UnknownPillarError";
  }
}

/**
 * Cast the loaded JSON to `ChecklistItem[]`. The runtime shape is verified
 * by the unit tests; the cast here is intentional because TypeScript's
 * `resolveJsonModule` widens enum-like fields to `string`.
 */
function asChecklist(raw: unknown): ChecklistItem[] {
  return raw as ChecklistItem[];
}

/**
 * Embedded Security pillar checklist. Frozen so a caller cannot mutate the
 * shared array.
 */
export const securityChecklist: readonly ChecklistItem[] = Object.freeze(
  asChecklist(securityRaw),
);

/**
 * Embedded Reliability pillar checklist. Frozen so a caller cannot mutate
 * the shared array.
 */
export const reliabilityChecklist: readonly ChecklistItem[] = Object.freeze(
  asChecklist(reliabilityRaw),
);

/**
 * Return the embedded checklist for `pillar`, or an empty array for a
 * recognised pillar that does not currently ship with items. Throws
 * `UnknownPillarError` for any pillar name not in `KNOWN_PILLARS`.
 *
 * The reviewer's `reference.checklist` tool wraps this and returns
 * `{ items }` to the agent. Returning `[]` for `Cost Optimization` and the
 * other yet-to-be-populated pillars is intentional: the reviewer can ask
 * for any pillar `agent-harness.config.json` enables without crashing if
 * the embedded set has not caught up yet. Empty checklists produce no
 * findings, which matches the reviewer's "fewer findings of higher
 * confidence" guidance.
 */
export function getChecklist(
  pillar: string,
): readonly ChecklistItem[] {
  if (!isKnownPillar(pillar)) {
    throw new UnknownPillarError(pillar);
  }
  switch (pillar) {
    case "Security":
      return securityChecklist;
    case "Reliability":
      return reliabilityChecklist;
    case "Cost Optimization":
    case "Operational Excellence":
    case "Performance Efficiency":
    case "Sustainability":
      return EMPTY_CHECKLIST;
  }
}

/**
 * Type-guarding `isKnownPillar` so callers can branch cleanly. Used by the
 * reviewer wrapper to validate input before invoking `getChecklist`.
 */
export function isKnownPillar(
  pillar: string,
): pillar is WellArchitectedPillar {
  return (KNOWN_PILLARS as readonly string[]).includes(pillar);
}

/**
 * Shared frozen empty array for pillars without embedded items. Reusing one
 * instance avoids per-call allocations and signals intentional emptiness.
 */
const EMPTY_CHECKLIST: readonly ChecklistItem[] = Object.freeze([]);
