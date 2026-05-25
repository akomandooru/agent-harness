/**
 * Integration test: validate the declarative `harness.json` files
 * against the editor and reviewer agent definitions in code.
 *
 * Catches drift between `app/editor/harness.json` /
 * `app/reviewer/harness.json` and the editor/reviewer source of truth
 * (`EDITOR_TOOL_NAMES` from `agents/editor/agent.ts`,
 * `REVIEWER_TOOL_NAMES` from `agents/reviewer/tools.ts`,
 * `agent-harness.config.json`, the on-disk system prompt files) before
 * `agentcore deploy` is run.
 *
 * Why this lives in `agents/editor/__tests__/`: the editor package
 * already has Jest configured and its tsconfig already pulls in the
 * reviewer package via the relative `../reviewer/*` includes. The
 * test reaches across both harness configs, so it would not naturally
 * belong to either the reviewer or a brand-new `app/` package; the
 * editor package is the existing cross-package home and avoids
 * standing up new Jest plumbing under `app/`.
 *
 * The two harness files use slightly different env-substitution
 * placeholders today:
 *
 *   - `app/editor/harness.json`   → "${models.editor from agent-harness.config.json}"
 *   - `app/reviewer/harness.json` → "${models.reviewer}"
 *
 * Both forms are valid AgentCore Managed Harness substitution syntax
 * (the resolver looks up the dotted path inside the project's config),
 * so the test accepts either spelling rather than picking a winner.
 * If a future spec normalises one, the parser still accepts both and
 * the assertion stays green.
 *
 * The four checks per harness:
 *
 *   1. The tool list matches the agent's source-of-truth catalogue
 *      exactly (order-sensitive for the editor, since `EDITOR_TOOL_NAMES`
 *      is an ordered array; set-equal for the reviewer, since
 *      `REVIEWER_TOOL_NAMES` is a Set).
 *   2. The model placeholder references a valid `models.*` key in
 *      `agent-harness.config.json`.
 *   3. The system prompt `$ref` resolves to a real file on disk.
 *   4. The iteration cap placeholder references `limits.iterationCap`
 *      and the resolved value matches the config.
 *
 * Requirements: 2.1 (reviewer harness shape), 3.1 (editor harness shape).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { EDITOR_TOOL_NAMES } from "../agent";
import { REVIEWER_TOOL_NAMES } from "../../reviewer/tools";

// ---------------------------------------------------------------------------
// Repo-relative paths
// ---------------------------------------------------------------------------

/**
 * Repo root resolved from this test file's location. The editor
 * package lives at `agents/editor/`, so two `..` from here is the
 * repo root regardless of how the test runner is launched.
 */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const EDITOR_HARNESS_PATH = resolve(REPO_ROOT, "app", "editor", "harness.json");
const REVIEWER_HARNESS_PATH = resolve(
  REPO_ROOT,
  "app",
  "reviewer",
  "harness.json",
);
const HARNESS_CONFIG_PATH = resolve(REPO_ROOT, "agent-harness.config.json");

// ---------------------------------------------------------------------------
// Types and loaders
// ---------------------------------------------------------------------------

/**
 * Minimal subset of the harness.json shape this test asserts against.
 * The deploy-time schema is owned by `@aws/agentcore@preview`; this
 * type captures only the four fields under test.
 */
interface HarnessJson {
  readonly name: string;
  readonly model: string;
  readonly systemPrompt: { readonly $ref: string };
  readonly tools: readonly string[];
  readonly memory: { readonly type: string };
  readonly iterationCap: string | number;
}

/**
 * Minimal subset of `agent-harness.config.json` this test reads.
 * `models` is the namespace the harness placeholders reference; the
 * test does not care what other top-level keys exist.
 */
interface HarnessConfig {
  readonly models: Readonly<Record<string, string>>;
  readonly limits: { readonly iterationCap: number };
}

function loadJson<T>(path: string): T {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as T;
}

// ---------------------------------------------------------------------------
// Placeholder parser
// ---------------------------------------------------------------------------

/**
 * Parse an AgentCore env-substitution placeholder of the form
 * `${dotted.path[ from ...source-hint]}` into the dotted path.
 *
 * Both forms appear in the existing harness files:
 *
 *   - `${models.editor from agent-harness.config.json}` → `models.editor`
 *   - `${models.reviewer}`                              → `models.reviewer`
 *   - `${limits.iterationCap from agent-harness.config.json}` → `limits.iterationCap`
 *   - `${limits.iterationCap}`                                → `limits.iterationCap`
 *
 * Returns `null` if the input does not look like a placeholder. That
 * lets the iterationCap assertion handle a future case where the
 * field is resolved at deploy time and stored as a literal number,
 * without the parser throwing.
 */
function parsePlaceholderPath(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const match = input.match(/^\$\{\s*([^}]+?)\s*\}$/);
  if (match === null) return null;
  const inside = match[1];
  // Strip an optional ` from <hint>` suffix. Whitespace between the
  // dotted path and `from` is already handled by the outer trim above
  // because the regex's lazy capture with the `\s*` boundaries pulls
  // in the trailing space; redo it inside to be safe.
  const fromIndex = inside.search(/\s+from\s+/);
  const dottedPath = (fromIndex >= 0 ? inside.slice(0, fromIndex) : inside).trim();
  if (dottedPath.length === 0) return null;
  return dottedPath;
}

/**
 * Walk a dotted path (`models.editor`, `limits.iterationCap`) into a
 * record-shaped object and return the leaf value, or `undefined` if
 * any segment is missing.
 */
function readDottedPath(root: unknown, dottedPath: string): unknown {
  const parts = dottedPath.split(".");
  let cursor: unknown = root;
  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

// ---------------------------------------------------------------------------
// Shared assertion helpers
// ---------------------------------------------------------------------------

/**
 * Assert the harness's `model` field references a valid `models.*`
 * key in `agent-harness.config.json`. Returns the resolved key (e.g.
 * `editor`, `reviewer`) so callers can also assert which model role
 * is referenced, and the resolved model id for downstream checks.
 */
function assertModelReferencesConfig(
  harness: HarnessJson,
  config: HarnessConfig,
): { modelKey: string; modelId: string } {
  const dottedPath = parsePlaceholderPath(harness.model);
  expect(dottedPath).not.toBeNull();
  // The placeholder must address the `models` namespace.
  expect(dottedPath!.split(".")[0]).toBe("models");

  const modelId = readDottedPath(config, dottedPath!);
  expect(typeof modelId).toBe("string");
  expect((modelId as string).length).toBeGreaterThan(0);

  // The dotted path must be exactly two segments — `models.<role>` —
  // so a malformed `models.foo.bar` would fail rather than silently
  // resolving to an unrelated leaf.
  const parts = dottedPath!.split(".");
  expect(parts).toHaveLength(2);
  return { modelKey: parts[1], modelId: modelId as string };
}

/**
 * Resolve the `systemPrompt.$ref` against the harness file's
 * directory and assert the file exists on disk. Returns the resolved
 * absolute path so callers can do additional assertions if they want
 * to.
 */
function assertSystemPromptResolves(
  harness: HarnessJson,
  harnessPath: string,
): string {
  expect(typeof harness.systemPrompt).toBe("object");
  expect(typeof harness.systemPrompt.$ref).toBe("string");

  const ref = harness.systemPrompt.$ref;
  const resolved = isAbsolute(ref)
    ? ref
    : resolve(dirname(harnessPath), ref);
  expect(existsSync(resolved)).toBe(true);
  return resolved;
}

/**
 * Assert the `iterationCap` field references `limits.iterationCap`
 * in the config, and that the resolved value matches the configured
 * cap. Tolerates a numeric literal too in case a future deploy-time
 * resolver inlines the value.
 */
function assertIterationCapMatchesConfig(
  harness: HarnessJson,
  config: HarnessConfig,
): void {
  if (typeof harness.iterationCap === "number") {
    expect(harness.iterationCap).toBe(config.limits.iterationCap);
    return;
  }
  const dottedPath = parsePlaceholderPath(harness.iterationCap);
  expect(dottedPath).toBe("limits.iterationCap");
  // Sanity: the resolved value matches the config the orchestrator
  // would read at runtime.
  expect(readDottedPath(config, dottedPath!)).toBe(
    config.limits.iterationCap,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("harness.json shape — placeholder parser", () => {
  test("parses the `${path from source}` form", () => {
    expect(
      parsePlaceholderPath("${models.editor from agent-harness.config.json}"),
    ).toBe("models.editor");
    expect(
      parsePlaceholderPath(
        "${limits.iterationCap from agent-harness.config.json}",
      ),
    ).toBe("limits.iterationCap");
  });

  test("parses the bare `${path}` form", () => {
    expect(parsePlaceholderPath("${models.reviewer}")).toBe(
      "models.reviewer",
    );
    expect(parsePlaceholderPath("${limits.iterationCap}")).toBe(
      "limits.iterationCap",
    );
  });

  test("tolerates inner whitespace around the dotted path", () => {
    expect(parsePlaceholderPath("${  models.editor  }")).toBe(
      "models.editor",
    );
  });

  test("returns null for non-placeholder input", () => {
    expect(parsePlaceholderPath("models.editor")).toBeNull();
    expect(parsePlaceholderPath("")).toBeNull();
    expect(parsePlaceholderPath("${}")).toBeNull();
    expect(parsePlaceholderPath(42 as unknown)).toBeNull();
  });
});

describe("editor harness.json (app/editor/harness.json)", () => {
  let harness: HarnessJson;
  let config: HarnessConfig;

  beforeAll(() => {
    harness = loadJson<HarnessJson>(EDITOR_HARNESS_PATH);
    config = loadJson<HarnessConfig>(HARNESS_CONFIG_PATH);
  });

  test("declares name `editor-agent`", () => {
    expect(harness.name).toBe("editor-agent");
  });

  test("`tools` list matches EDITOR_TOOL_NAMES exactly (same order)", () => {
    // EDITOR_TOOL_NAMES is an ordered array; the harness file should
    // mirror it byte-for-byte. Order matters for the editor because
    // the design pins the catalogue order.
    expect(harness.tools).toEqual([...EDITOR_TOOL_NAMES]);
  });

  test("`model` references a valid `models.*` key in agent-harness.config.json", () => {
    const { modelKey } = assertModelReferencesConfig(harness, config);
    // The editor harness should specifically reference `models.editor`.
    expect(modelKey).toBe("editor");
  });

  test("`systemPrompt.$ref` resolves to an existing file on disk", () => {
    const resolved = assertSystemPromptResolves(harness, EDITOR_HARNESS_PATH);
    // The editor's prompt lives under `agents/editor/system.md`.
    expect(resolved.endsWith(`agents${require("node:path").sep}editor${require("node:path").sep}system.md`)).toBe(
      true,
    );
  });

  test("`iterationCap` matches agent-harness.config.json `limits.iterationCap`", () => {
    assertIterationCapMatchesConfig(harness, config);
  });

  test("memory.type is `session`", () => {
    expect(harness.memory.type).toBe("session");
  });
});

describe("reviewer harness.json (app/reviewer/harness.json)", () => {
  let harness: HarnessJson;
  let config: HarnessConfig;

  beforeAll(() => {
    harness = loadJson<HarnessJson>(REVIEWER_HARNESS_PATH);
    config = loadJson<HarnessConfig>(HARNESS_CONFIG_PATH);
  });

  test("declares name `reviewer-agent`", () => {
    expect(harness.name).toBe("reviewer-agent");
  });

  test("`tools` list matches REVIEWER_TOOL_NAMES exactly (set equality)", () => {
    // REVIEWER_TOOL_NAMES is a ReadonlySet, so order is not part of
    // the source-of-truth contract; assert set equality and the
    // expected count.
    const expected = new Set(REVIEWER_TOOL_NAMES);
    const actual = new Set(harness.tools);
    expect(actual).toEqual(expected);
    expect(harness.tools.length).toBe(expected.size);

    // Defence-in-depth: the reviewer must not register any write or
    // CDK tool, even if a future expansion accidentally widens
    // REVIEWER_TOOL_NAMES.
    for (const name of harness.tools) {
      expect(name).not.toMatch(/writeFile|cdk\.|preview\.|\.open|sensor\./i);
    }
  });

  test("`model` references a valid `models.*` key in agent-harness.config.json", () => {
    const { modelKey } = assertModelReferencesConfig(harness, config);
    // The reviewer harness should specifically reference `models.reviewer`.
    expect(modelKey).toBe("reviewer");
  });

  test("`systemPrompt.$ref` resolves to an existing file on disk", () => {
    const resolved = assertSystemPromptResolves(
      harness,
      REVIEWER_HARNESS_PATH,
    );
    expect(
      resolved.endsWith(
        `agents${require("node:path").sep}reviewer${require("node:path").sep}system.md`,
      ),
    ).toBe(true);
  });

  test("`iterationCap` matches agent-harness.config.json `limits.iterationCap`", () => {
    assertIterationCapMatchesConfig(harness, config);
  });

  test("memory.type is `session`", () => {
    expect(harness.memory.type).toBe("session");
  });
});
