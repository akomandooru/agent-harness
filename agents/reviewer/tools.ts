/**
 * Tool catalogue for the reviewer agent.
 *
 * The reviewer's surface is a strict subset of the editor's: read-only file
 * access, the diff under review, and the embedded Well-Architected
 * checklists. No write tools, no CDK tools, no CloudWatch tools, no PR
 * tools, no shell. The reviewer's `system.md` documents this contract; the
 * code in this file enforces it.
 *
 * The three catalogue tools, mirroring `design.md` Tool catalogue (reviewer
 * agent):
 *
 *   - `module.readFile`        `{path}`    -> `{contents, sha}`
 *   - `module.diff`            `{}`        -> `{diff}`
 *   - `reference.checklist`    `{pillar}`  -> `{items[]}`
 *
 * `module.readFile` and `module.diff` are intentionally re-implemented here
 * rather than imported from `@agent-harness/editor`. Two reasons:
 *
 *   1. The editor package's main entry point exposes the writeFile and
 *      listFiles tools alongside the read-only ones; importing it would
 *      make the reviewer transitively aware of write surface that the
 *      reviewer must never touch. Re-implementing keeps the reviewer's
 *      dependency graph free of write tools by construction.
 *
 *   2. Coupling the reviewer to the editor's internals creates the wrong
 *      future tradeoff: if the editor adds a new read-only tool the
 *      reviewer should not automatically inherit it; promotion to the
 *      reviewer's catalogue should be a deliberate code change reviewed
 *      against the reviewer's threat model.
 *
 * `registerTool` is the fail-closed registration check the reviewer
 * agent's setup code calls for each tool name it wires in. A name not in
 * the catalogue throws `UnknownToolError`. The function is the runtime
 * version of "Reject any other tool registration at runtime" from the
 * task brief; the wrapper layer (`@agent-harness/shared`) handles the
 * input/output validation per call, but the catalogue check is what stops
 * a forker from accidentally wiring `module.writeFile` into the reviewer.
 */

import { exec as execCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

import type { ToolDefinition } from "@agent-harness/shared";

import {
  type ChecklistItem,
  getChecklist,
} from "./checklists";

const exec = promisify(execCb);

/** Default base ref for `module.diff`, mirroring the editor's tool. */
const DEFAULT_DIFF_BASE_REF = "HEAD";

// ---------------------------------------------------------------------------
// module.readFile (read-only)
// ---------------------------------------------------------------------------

interface ReadFileInput {
  readonly path: string;
}

interface ReadFileOutput {
  readonly contents: string;
  readonly sha: string;
}

/**
 * Read a UTF-8 file inside the module root, returning its contents and a
 * SHA-256 of the bytes.
 *
 * Same shape as the editor's `module.readFile`, by design: the reviewer's
 * system prompt instructs the agent to use it the same way (inspect a file
 * the diff edits in full, or the module's `AGENTS.md`). The wrapper handles
 * path-scope enforcement via `pathField`; nothing in this handler needs to
 * touch the path validator directly.
 */
export const readFileTool: ToolDefinition<ReadFileInput, ReadFileOutput> = {
  name: "module.readFile",
  description:
    "Read a UTF-8 file inside the module root. Reviewer-side, read-only.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      contents: { type: "string" },
      sha: { type: "string", pattern: "^[0-9a-f]{64}$" },
    },
    required: ["contents", "sha"],
    additionalProperties: false,
  },
  pathField: "path",
  handler: async (_input, ctx) => {
    const absolute = ctx.resolvedPath as string;
    const buffer = await fs.readFile(absolute);
    return {
      output: {
        contents: buffer.toString("utf8"),
        sha: sha256(buffer),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// module.diff (read-only)
// ---------------------------------------------------------------------------

interface DiffInput {
  // Empty by design.
}

interface DiffOutput {
  readonly diff: string;
}

/**
 * Return a text diff of the module's working tree vs. the base git ref.
 *
 * Read-only; same shape as the editor's `module.diff`. The reviewer uses
 * this to fetch the diff under review when the harness has not already
 * passed it in invocation context.
 */
export const diffTool: ToolDefinition<DiffInput, DiffOutput> = {
  name: "module.diff",
  description:
    "Return a text diff of the module's working tree vs. the base git ref. " +
    "Reviewer-side, read-only.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      diff: { type: "string" },
    },
    required: ["diff"],
    additionalProperties: false,
  },
  // No `pathField`; diff takes no path argument from the agent.
  handler: async (_input, ctx) => {
    const moduleRoot = ctx.resolvedModuleRoot as string;
    const args = [
      "diff",
      "--no-color",
      "--no-ext-diff",
      DEFAULT_DIFF_BASE_REF,
      "--",
      ".",
    ];
    const { stdout } = await exec(`git ${args.join(" ")}`, {
      cwd: moduleRoot,
      // 10 MiB matches the editor's tool; reviewer reads diffs of the same
      // size the editor produces.
      maxBuffer: 10 * 1024 * 1024,
    });
    return { output: { diff: stdout } };
  },
};

// ---------------------------------------------------------------------------
// reference.checklist
// ---------------------------------------------------------------------------

interface ReferenceChecklistInput {
  readonly pillar: string;
}

interface ReferenceChecklistOutput {
  readonly items: readonly ChecklistItem[];
}

/**
 * Fetch the embedded Well-Architected checklist for a pillar.
 *
 * Wraps `getChecklist` from `agents/reviewer/checklists/index.ts`. The
 * underlying call returns an empty array for recognised-but-unpopulated
 * pillars and throws `UnknownPillarError` for unrecognised names; the
 * shared wrapper turns the throw into a `handler-error` outcome so the
 * agent gets a structured rejection rather than a partial response.
 *
 * The output schema deliberately matches the shape that JSON-schema
 * validation can verify: each item carries an `id`, `pillar`, `title`,
 * `severityGuidance`, `whatToLookFor`, and an optional `references`
 * array. If a future fork adds a field, the schema and the type both
 * change in lockstep.
 */
export const referenceChecklistTool: ToolDefinition<
  ReferenceChecklistInput,
  ReferenceChecklistOutput
> = {
  name: "reference.checklist",
  description:
    "Fetch the embedded Well-Architected checklist items for a pillar.",
  inputSchema: {
    type: "object",
    properties: {
      pillar: { type: "string", minLength: 1 },
    },
    required: ["pillar"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1 },
            pillar: { type: "string", minLength: 1 },
            title: { type: "string", minLength: 1 },
            severityGuidance: {
              type: "string",
              enum: ["info", "low", "medium", "high", "critical"],
            },
            whatToLookFor: { type: "string", minLength: 1 },
            references: {
              type: "array",
              items: { type: "string" },
              nullable: true,
            },
          },
          required: [
            "id",
            "pillar",
            "title",
            "severityGuidance",
            "whatToLookFor",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
  // No `pathField`: the input is a pillar name, not a path.
  handler: async (input) => {
    // `getChecklist` throws `UnknownPillarError` for unknown pillar names.
    // Let the throw propagate; the shared wrapper records the call as a
    // `handler-error` and surfaces a clean message to the agent.
    const items = getChecklist(input.pillar);
    // The output schema does not allow `readonly` semantics through, but
    // structurally the array is fine; the wrapper validates against the
    // schema, not against the TypeScript readonly modifier.
    return { output: { items: items as ChecklistItem[] } };
  },
};

// ---------------------------------------------------------------------------
// Catalogue and registration
// ---------------------------------------------------------------------------

/**
 * The complete set of tools the reviewer is allowed to register. Anything
 * outside this set is rejected at registration time by `registerTool`.
 *
 * Frozen so a runtime caller cannot mutate the array reference and slip a
 * write tool into the catalogue.
 */
export const reviewerToolCatalogue: readonly ToolDefinition<
  unknown,
  unknown
>[] = Object.freeze([
  // Cast through `unknown` so the heterogeneous tools live in one frozen
  // array without losing the per-tool typed exports above. Callers should
  // prefer the named exports (`readFileTool`, `diffTool`,
  // `referenceChecklistTool`) when they need the typed shape.
  readFileTool as unknown as ToolDefinition<unknown, unknown>,
  diffTool as unknown as ToolDefinition<unknown, unknown>,
  referenceChecklistTool as unknown as ToolDefinition<unknown, unknown>,
]);

/**
 * Stable set of allowed tool names for fast `registerTool` lookups. Frozen
 * so the catalogue cannot be widened at runtime.
 */
export const REVIEWER_TOOL_NAMES: ReadonlySet<string> = Object.freeze(
  new Set(reviewerToolCatalogue.map((tool) => tool.name)),
);

/**
 * Thrown by `registerTool` when called with a tool name not in the
 * catalogue. Programmer error: the reviewer's setup code is trying to
 * wire a tool the catalogue does not authorise. The thrown message names
 * the rejected tool and the allowed set so the failure is actionable.
 */
export class UnknownToolError extends Error {
  public readonly tool: string;

  public constructor(tool: string) {
    super(
      `Tool ${JSON.stringify(tool)} is not in the reviewer catalogue. ` +
        `Allowed: ${[...REVIEWER_TOOL_NAMES].sort().join(", ")}.`,
    );
    this.name = "UnknownToolError";
    this.tool = tool;
  }
}

/**
 * Fail-closed registration check.
 *
 * The reviewer agent's setup code calls this for each tool name it wants
 * to wire in. Returns the matching `ToolDefinition` from the catalogue if
 * the name is allowed; throws `UnknownToolError` otherwise.
 *
 * This is the runtime enforcement of "Reject any other tool registration
 * at runtime" from `tasks.md` task 5.3. The wrapper layer enforces
 * per-call input/output validation; this enforces catalogue membership.
 *
 * The function is intentionally simple and side-effect free so it can be
 * called from any setup path (agent definition, integration tests, the
 * reviewer wrapper) without ordering concerns.
 */
export function registerTool(
  toolName: string,
): ToolDefinition<unknown, unknown> {
  if (!REVIEWER_TOOL_NAMES.has(toolName)) {
    throw new UnknownToolError(toolName);
  }
  // We have already confirmed membership; the find cannot return undefined.
  // The non-null assertion is safe and avoids the need for a second guard.
  return reviewerToolCatalogue.find((tool) => tool.name === toolName)!;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
