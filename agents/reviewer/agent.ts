/**
 * Reviewer agent definition and `reviewer.invoke` tool factory.
 *
 * This module is the seam between the reviewer agent and the rest of the
 * harness:
 *
 *   - `ReviewerAgentDefinition` and `loadReviewerAgentDefinition()` describe
 *     the reviewer the orchestrator instantiates as a Strands `Agent`. The
 *     definition pulls the model id from `agent-harness.config.json`, the
 *     system prompt and its version from `agents/reviewer/system.md`, and
 *     the tool catalogue from `agents/reviewer/tools.ts`.
 *
 *   - `ReviewerInvocation` and `createReviewerInvokeTool(invocation)` are the
 *     wrapper the editor's catalogue registers. The editor calls
 *     `reviewer.invoke({ diff })`; the wrapper validates the input against a
 *     strict `{diff: string}` schema (no pass-through prompts), forwards the
 *     diff to the orchestrator-supplied `ReviewerInvocation`, validates the
 *     reviewer's output against the schema in `design.md` Data Models, and
 *     ticks the token cost counter.
 *
 * Why a separate `ReviewerInvocation` interface rather than wiring the
 * Strands SDK directly? Two reasons.
 *
 *   1. The reviewer's runtime is supplied by the orchestrator at deploy
 *      time (production: a `bedrock-agentcore:InvokeHarness` call against
 *      the deployed reviewer Managed Harness — see
 *      `harness/scheduled-reviewer/src/run.ts`'s
 *      `ManagedHarnessReviewerInvocation`). Tests inject
 *      `RecordedReviewerInvocation` with canned outputs keyed by diff.
 *      Both implement the same one-method interface and the wrapper does
 *      not care which.
 *
 *   2. The interface narrows the surface to exactly what the editor needs:
 *      one method, one input field, one output shape. A larger interface
 *      would tempt a future change to pass extra fields the wrapper would
 *      then have to re-validate; a one-method interface is the simplest
 *      shape that defends the "no pass-through prompts" rule.
 *
 * Pass-through resistance. The editor agent is the caller of this tool, but
 * the diff under review can contain text that looks like instructions
 * directed at the reviewer (the "prompt injection" failure mode the
 * reviewer's system prompt warns about). The wrapper here is the *first*
 * line of defence: it rejects any field other than `diff` on the way in,
 * so the editor cannot smuggle a prompt override into the reviewer's input.
 * The reviewer's system prompt is the second line of defence (it tells the
 * model not to follow instructions found in the diff). Both layers are
 * required; this file owns the wrapper layer.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  CostCategory,
  ToolDefinition,
} from "@agent-harness/shared";

import { reviewerToolCatalogue } from "./tools";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Static description of the reviewer agent the orchestrator instantiates.
 *
 * The orchestrator reads this and constructs a Strands `Agent` from the
 * three fields plus the tool catalogue. The shape is deliberately
 * data-only: nothing in this module imports the Strands SDK, so a forker
 * can swap the agent runtime without touching the harness wiring.
 *
 * Why version the system prompt? Two reviewers are not equivalent if their
 * prompts are not equivalent. Pinning a version in the prompt's frontmatter
 * lets the agent definition reference the prompt by version, and lets a
 * forker change the prompt safely (bump the version; downstream tests can
 * assert the version they expect).
 */
export interface ReviewerAgentDefinition {
  /** Bedrock model identifier from `agent-harness.config.json` `models.reviewer`. */
  readonly model: string;
  /** Version string from the system prompt's YAML frontmatter (`version` key). */
  readonly systemPromptVersion: string;
  /** Body of the system prompt with the frontmatter stripped. */
  readonly systemPrompt: string;
  /** Reviewer-side tool catalogue. Strict subset of the editor's surface. */
  readonly tools: ReadonlyArray<ToolDefinition<unknown, unknown>>;
}

/**
 * Strict input shape for `reviewer.invoke`.
 *
 * The editor must pass exactly `{ diff }` and nothing else. The wrapper's
 * input schema enforces this with `additionalProperties: false`; this type
 * is the TypeScript-side mirror of that schema.
 */
export interface ReviewerInvocationInput {
  /** Diff under review. Treated as data, never as instructions. */
  readonly diff: string;
}

/**
 * Severity vocabulary for findings, matching `design.md` Data Models and
 * the reviewer system prompt's output schema.
 */
export type ReviewerSeverity =
  | "info"
  | "low"
  | "medium"
  | "high"
  | "critical";

/**
 * One reviewer finding. Mirrors the schema from `design.md`'s
 * `ReviewerOutput.findings[*]` and the system-prompt-declared shape.
 */
export interface ReviewerFinding {
  /** Checklist item id, e.g. `WA-SEC-02`. */
  readonly id: string;
  /** Pillar the finding belongs to, e.g. `Security`. */
  readonly pillar: string;
  /** Severity of the finding; `passed` is computed against this. */
  readonly severity: ReviewerSeverity;
  /** Path inside the module, when locatable. */
  readonly file?: string;
  /** 1-indexed line in `file`, when locatable. */
  readonly line?: number;
  /** One or two sentences naming the gap. */
  readonly description: string;
  /** One-line note describing the suggested fix. Never code. */
  readonly suggestedFix: string;
}

/**
 * Output the reviewer agent produces and the wrapper validates against its
 * output schema. Mirrors `design.md`'s `ReviewerOutput`.
 */
export interface ReviewerOutput {
  readonly passed: boolean;
  readonly findings: ReadonlyArray<ReviewerFinding>;
  readonly severityCounts: Readonly<Record<string, number>>;
}

/**
 * Single-method interface the wrapper depends on.
 *
 * Implementations:
 *   - Production: a Strands-backed reviewer (deferred to task 12 of
 *     `tasks.md`).
 *   - Tests: `RecordedReviewerInvocation`, which returns canned
 *     `ReviewerOutput` for a given diff.
 *
 * The interface is intentionally narrow: one method, one input, one output.
 * A larger interface would invite a future change to widen the wrapper's
 * input shape, which is exactly the failure mode the "no pass-through"
 * rule is designed to prevent.
 */
export interface ReviewerInvocation {
  invoke(input: ReviewerInvocationInput): Promise<ReviewerOutput>;
}

// ---------------------------------------------------------------------------
// System-prompt loading
// ---------------------------------------------------------------------------

/**
 * Result of parsing the YAML frontmatter at the top of `system.md`.
 *
 * Only the keys the agent definition needs are surfaced; the parser is
 * intentionally minimal to avoid pulling a YAML dependency in for a
 * three-line frontmatter block.
 */
export interface ParsedSystemPrompt {
  readonly version: string;
  readonly body: string;
}

/**
 * Parse the `---`-delimited YAML frontmatter at the top of a markdown file
 * and return the `version` value plus the body.
 *
 * The reviewer's `system.md` opens with:
 *
 *     ---
 *     prompt: agents/reviewer/system.md
 *     version: 1.0.0
 *     ---
 *
 * This parser handles only the subset of YAML the frontmatter uses
 * (top-level `key: value` lines, optional surrounding whitespace, no
 * nested objects). A full YAML parser would be overkill and adds a
 * dependency we do not otherwise need.
 *
 * Throws when the frontmatter is missing or malformed. Callers should let
 * the throw surface; a malformed system prompt is a build-time error, not
 * a runtime condition the reviewer can recover from.
 */
export function parseReviewerSystemPromptFrontmatter(
  markdown: string,
): ParsedSystemPrompt {
  // Frontmatter must be the first non-empty content. Allow a leading BOM
  // (Windows editors sometimes save with one) and any number of leading
  // newlines so the parser is forgiving about file-handling differences.
  const trimmed = markdown.replace(/^\uFEFF/, "");
  const startMarker = trimmed.match(/^---\r?\n/);
  if (startMarker === null) {
    throw new Error(
      "reviewer system.md: expected YAML frontmatter starting with '---' on the first line",
    );
  }
  const afterStart = trimmed.slice(startMarker[0].length);

  // The closing `---` must be on its own line. Search for the next such
  // line; the content between is the frontmatter body.
  const endMatch = afterStart.match(/\r?\n---\r?\n/);
  if (endMatch === null || endMatch.index === undefined) {
    throw new Error(
      "reviewer system.md: frontmatter is missing a closing '---' delimiter",
    );
  }
  const frontmatterBody = afterStart.slice(0, endMatch.index);
  const bodyAfterFrontmatter = afterStart.slice(
    endMatch.index + endMatch[0].length,
  );

  // Tiny key:value parser. Skip blank and comment lines; reject anything
  // that does not look like a top-level scalar entry.
  const entries: Record<string, string> = {};
  for (const rawLine of frontmatterBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 1) {
      throw new Error(
        `reviewer system.md: malformed frontmatter line ${JSON.stringify(rawLine)}`,
      );
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    entries[key] = stripFrontmatterScalarQuotes(value);
  }

  const version = entries["version"];
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(
      "reviewer system.md: frontmatter is missing a non-empty 'version' field",
    );
  }

  return {
    version,
    body: bodyAfterFrontmatter.replace(/^\r?\n/, ""),
  };
}

/**
 * Strip a single layer of matching single or double quotes from a YAML
 * scalar. The frontmatter today uses bare scalars, but tolerating quotes
 * is cheap and prevents surprises if a forker quotes the version string.
 */
function stripFrontmatterScalarQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Definition loader
// ---------------------------------------------------------------------------

/**
 * Optional inputs to `loadReviewerAgentDefinition`. Tests use these to
 * point the loader at fixture files; production code passes nothing and
 * gets the on-disk defaults.
 */
export interface LoadReviewerAgentDefinitionOptions {
  /** Absolute path to `agent-harness.config.json`. Default: repo root. */
  readonly configPath?: string;
  /** Absolute path to `agents/reviewer/system.md`. Default: alongside this file. */
  readonly systemPromptPath?: string;
  /** Tool catalogue. Default: the reviewer's static catalogue. */
  readonly tools?: ReadonlyArray<ToolDefinition<unknown, unknown>>;
}

/**
 * Build the reviewer's `ReviewerAgentDefinition` from the on-disk system
 * prompt, repo config, and tool catalogue.
 *
 * The function is synchronous because it reads two small files (the system
 * prompt and the JSON config) at startup; making the orchestrator await an
 * async loader would add no value.
 *
 * Tests inject `configPath`, `systemPromptPath`, and `tools` so they can
 * exercise the loader with controlled inputs.
 */
export function loadReviewerAgentDefinition(
  options: LoadReviewerAgentDefinitionOptions = {},
): ReviewerAgentDefinition {
  const systemPromptPath =
    options.systemPromptPath ?? defaultSystemPromptPath();
  const configPath = options.configPath ?? defaultConfigPath();

  const promptRaw = readFileSync(systemPromptPath, "utf8");
  const parsed = parseReviewerSystemPromptFrontmatter(promptRaw);

  const configRaw = readFileSync(configPath, "utf8");
  const config = parseHarnessConfig(configRaw, configPath);

  const tools = options.tools ?? reviewerToolCatalogue;

  return {
    model: config.models.reviewer,
    systemPromptVersion: parsed.version,
    systemPrompt: parsed.body,
    tools,
  };
}

/**
 * Minimal subset of `agent-harness.config.json` the reviewer cares about.
 * The full config is validated by `scripts/validate-config.ts`; this loader
 * is content with extracting the one field the reviewer uses.
 */
interface HarnessConfigFragment {
  readonly models: { readonly reviewer: string };
}

function parseHarnessConfig(
  raw: string,
  configPath: string,
): HarnessConfigFragment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${configPath}: not valid JSON: ${message}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("models" in parsed) ||
    typeof (parsed as { models: unknown }).models !== "object" ||
    (parsed as { models: unknown }).models === null
  ) {
    throw new Error(
      `${configPath}: missing required 'models' object`,
    );
  }
  const models = (parsed as { models: Record<string, unknown> }).models;
  const reviewer = models["reviewer"];
  if (typeof reviewer !== "string" || reviewer.length === 0) {
    throw new Error(
      `${configPath}: missing required 'models.reviewer' string`,
    );
  }
  return { models: { reviewer } };
}

function defaultSystemPromptPath(): string {
  return resolve(__dirname, "system.md");
}

function defaultConfigPath(): string {
  // `__dirname` is `agents/reviewer`. The config lives at the repo root,
  // three levels up.
  return resolve(__dirname, "..", "..", "agent-harness.config.json");
}

// ---------------------------------------------------------------------------
// `reviewer.invoke` tool wrapper for the editor's catalogue
// ---------------------------------------------------------------------------

/**
 * Cost category for the wrapper. Reviewer invocations consume model
 * tokens. The actual token-to-USD conversion happens upstream of this
 * wrapper; here we just label the category and report a USD figure
 * supplied by the orchestrator (or `0` when running in tests without a
 * cost provider).
 */
const REVIEWER_COST_CATEGORY: CostCategory = "tokens";

/**
 * Provisional reviewer cost. Mirrors the
 * `PROVISIONAL_DEPLOY_COST_USD = 0` pattern in the editor's `cdk.ts`:
 * report `0` when no real measurement is plumbed through, so the cost
 * counter records the call without skewing the running total. Real
 * numbers come from the orchestrator via `costUsdProvider`.
 */
const PROVISIONAL_REVIEWER_COST_USD = 0;

/**
 * Optional knobs for `createReviewerInvokeTool`.
 *
 * `costUsdProvider` lets the orchestrator hand back the USD figure for
 * the invocation just made (typically derived from the Bedrock invocation's
 * input/output token count). If omitted, the wrapper reports
 * `PROVISIONAL_REVIEWER_COST_USD`.
 */
export interface CreateReviewerInvokeToolOptions {
  readonly costUsdProvider?: (output: ReviewerOutput) => number;
}

/**
 * Build the `reviewer.invoke` tool the editor agent registers in its
 * catalogue.
 *
 * The wrapper:
 *   - validates the input against `{ diff: string }` with
 *     `additionalProperties: false`. Any extra fields (a smuggled
 *     `prompt`, `tools`, `instructions`, etc.) are rejected before the
 *     `ReviewerInvocation` is called.
 *   - forwards the diff to the supplied `ReviewerInvocation`.
 *   - validates the returned `ReviewerOutput` against the schema from
 *     `design.md`. A reviewer that returns malformed output is treated as
 *     a tool bug (output-schema-error); the editor's loop treats this as
 *     a sensor-class failure and continues to the next iteration.
 *   - reports the call's cost to the cost counter under the `tokens`
 *     category.
 *
 * The factory takes the `ReviewerInvocation` rather than constructing one
 * itself so the orchestrator owns the runtime. Tests pass a
 * `RecordedReviewerInvocation`; production passes a Strands-backed one.
 */
export function createReviewerInvokeTool(
  invocation: ReviewerInvocation,
  options: CreateReviewerInvokeToolOptions = {},
): ToolDefinition<ReviewerInvocationInput, ReviewerOutput> {
  return {
    name: "reviewer.invoke",
    description:
      "Run the inferential Well-Architected reviewer against the supplied diff. " +
      "The reviewer is a separate Strands Agent invocation; the wrapper " +
      "rejects any input field other than 'diff' so the editor cannot " +
      "smuggle prompt overrides into the reviewer.",
    inputSchema: REVIEWER_INVOKE_INPUT_SCHEMA,
    outputSchema: REVIEWER_INVOKE_OUTPUT_SCHEMA,
    costCategory: REVIEWER_COST_CATEGORY,
    handler: async (input) => {
      const output = await invocation.invoke({ diff: input.diff });
      const usd =
        options.costUsdProvider !== undefined
          ? options.costUsdProvider(output)
          : PROVISIONAL_REVIEWER_COST_USD;
      return {
        output,
        cost: { usd },
      };
    },
  };
}

/**
 * Strict input schema for `reviewer.invoke`. Exactly one required field,
 * no extras allowed. The schema matches the design's editor catalogue
 * declaration (`reviewer.invoke {diff} -> {findings[], passed, severityCounts}`).
 */
const REVIEWER_INVOKE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    diff: { type: "string" },
  },
  required: ["diff"],
  additionalProperties: false,
} as const;

/**
 * Output schema mirroring `design.md`'s `ReviewerOutput`.
 *
 * Strictness here is deliberate: a reviewer that returns malformed output
 * is a tool bug, and the wrapper's output-schema check turns it into an
 * `output-schema-error` outcome the loop can handle uniformly. The
 * alternative (accepting whatever shape the reviewer produces) would let a
 * misbehaving reviewer break the editor's gate logic silently.
 */
const REVIEWER_INVOKE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    passed: { type: "boolean" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          pillar: { type: "string", minLength: 1 },
          severity: {
            type: "string",
            enum: ["info", "low", "medium", "high", "critical"],
          },
          file: { type: "string" },
          line: { type: "integer", minimum: 1 },
          description: { type: "string", minLength: 1 },
          suggestedFix: { type: "string", minLength: 1 },
        },
        required: [
          "id",
          "pillar",
          "severity",
          "description",
          "suggestedFix",
        ],
        additionalProperties: false,
      },
    },
    severityCounts: {
      type: "object",
      additionalProperties: { type: "integer", minimum: 0 },
    },
  },
  required: ["passed", "findings", "severityCounts"],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Recorded fixture-based reviewer invocation
// ---------------------------------------------------------------------------

/**
 * Stub `ReviewerInvocation` that returns canned outputs for known diffs.
 *
 * Used by agent integration tests to exercise the reviewer wrapper without
 * a live Strands or Bedrock dependency. The fixture set is keyed on the
 * exact diff string; tests register a fixture, then call `invoke` and
 * assert on the returned output.
 *
 * `recordResponse` adds (or overwrites) a fixture; `invoke` looks it up
 * and throws if no fixture matches. Throwing on miss is intentional: a
 * test that passes an unexpected diff is a test bug, not a runtime
 * condition; failing fast surfaces the bug at the invocation site.
 */
export class RecordedReviewerInvocation implements ReviewerInvocation {
  private readonly responses = new Map<string, ReviewerOutput>();

  /**
   * Register the canned output for `diff`. Subsequent calls to
   * `invoke({ diff })` return this output. Re-recording the same diff
   * replaces the previous output.
   */
  public recordResponse(diff: string, output: ReviewerOutput): void {
    this.responses.set(diff, output);
  }

  /**
   * Look up the canned output for `input.diff`. Throws when the diff has
   * no recorded response so the test author sees the misconfiguration
   * immediately.
   */
  public async invoke(
    input: ReviewerInvocationInput,
  ): Promise<ReviewerOutput> {
    const recorded = this.responses.get(input.diff);
    if (recorded === undefined) {
      throw new Error(
        `RecordedReviewerInvocation: no canned response for diff ` +
          `(diff length=${input.diff.length}). Call recordResponse() first.`,
      );
    }
    return recorded;
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Resolved default paths the loader uses. Exported so tests can assert on
 * the defaults without re-deriving them from `__dirname`.
 */
export const REVIEWER_AGENT_DEFAULT_PATHS = {
  systemPromptPath: defaultSystemPromptPath,
  configPath: defaultConfigPath,
} as const;

// `dirname` is intentionally re-exported for tests that build relative
// fixture paths without depending on Node's path module directly.
export const __testHelpers = { dirname };
