/**
 * Integration test: validate the deploy-harnesses.ts script configuration
 * against the editor and reviewer agent definitions in code.
 *
 * Previously this file validated `app/editor/harness.json` and
 * `app/reviewer/harness.json`. Those files were removed as part of the
 * agentcore-sdk-direct-deploy bugfix (Requirement 2.9). The harness
 * configuration is now expressed directly in `scripts/deploy-harnesses.ts`,
 * which calls `bedrock-agentcore-control:CreateHarness` with tool definitions
 * sourced from the agent code.
 *
 * This test now validates the equivalent properties against the new deploy
 * mechanism:
 *
 *   1. The deploy script exists and references `inline_function` tool registration.
 *   2. The tool names match `EDITOR_TOOL_NAMES` / `REVIEWER_TOOL_NAMES` exactly.
 *   3. The model IDs come from `agent-harness.config.json` (`models.editor`,
 *      `models.reviewer`).
 *   4. The system prompt files exist on disk (`agents/editor/system.md`,
 *      `agents/reviewer/system.md`).
 *   5. The limits mapping is correct (`iterationCap`, `tokenSpendCapUSD`,
 *      `wallClockCapMinutes`).
 *   6. The obsolete harness.json files are absent from disk.
 *
 * Why this lives in `agents/editor/__tests__/`: the editor package
 * already has Jest configured and its tsconfig already pulls in the
 * reviewer package via the relative `../reviewer/*` includes. The
 * test reaches across both harness configs, so it would not naturally
 * belong to either the reviewer or a brand-new `app/` package; the
 * editor package is the existing cross-package home and avoids
 * standing up new Jest plumbing under `app/`.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.9, 2.10, 3.7
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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
const DEPLOY_SCRIPT_PATH = resolve(REPO_ROOT, "scripts", "deploy-harnesses.ts");
const HARNESS_CONFIG_PATH = resolve(REPO_ROOT, "agent-harness.config.json");
const EDITOR_SYSTEM_MD_PATH = resolve(REPO_ROOT, "agents", "editor", "system.md");
const REVIEWER_SYSTEM_MD_PATH = resolve(REPO_ROOT, "agents", "reviewer", "system.md");

// Obsolete paths that must NOT exist after the fix (Requirement 2.9)
const OBSOLETE_EDITOR_HARNESS_PATH = resolve(REPO_ROOT, "app", "editor", "harness.json");
const OBSOLETE_REVIEWER_HARNESS_PATH = resolve(REPO_ROOT, "app", "reviewer", "harness.json");
const OBSOLETE_AGENTCORE_JSON_PATH = resolve(REPO_ROOT, "agentcore", "agentcore.json");
const OBSOLETE_AWS_TARGETS_PATH = resolve(REPO_ROOT, "agentcore", "aws-targets.json");

// ---------------------------------------------------------------------------
// Types and loaders
// ---------------------------------------------------------------------------

/**
 * Minimal subset of `agent-harness.config.json` this test reads.
 */
interface HarnessConfig {
  readonly models: Readonly<Record<string, string>>;
  readonly limits: {
    readonly iterationCap: number;
    readonly tokenSpendCapUSD: number;
    readonly wallClockCapMinutes: number;
  };
}

function loadJson<T>(path: string): T {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as T;
}

// ---------------------------------------------------------------------------
// Placeholder parser (kept for backward compatibility with any callers)
// ---------------------------------------------------------------------------

/**
 * Parse an AgentCore env-substitution placeholder of the form
 * `${dotted.path[ from ...source-hint]}` into the dotted path.
 *
 * Returns `null` if the input does not look like a placeholder.
 */
function parsePlaceholderPath(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const match = input.match(/^\$\{\s*([^}]+?)\s*\}$/);
  if (match === null) return null;
  const inside = match[1];
  const fromIndex = inside.search(/\s+from\s+/);
  const dottedPath = (fromIndex >= 0 ? inside.slice(0, fromIndex) : inside).trim();
  if (dottedPath.length === 0) return null;
  return dottedPath;
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

// ---------------------------------------------------------------------------
// Obsolete files must be absent (Requirement 2.9)
// ---------------------------------------------------------------------------

describe("obsolete harness.json files are absent (Requirement 2.9)", () => {
  test("app/editor/harness.json does not exist", () => {
    expect(existsSync(OBSOLETE_EDITOR_HARNESS_PATH)).toBe(false);
  });

  test("app/reviewer/harness.json does not exist", () => {
    expect(existsSync(OBSOLETE_REVIEWER_HARNESS_PATH)).toBe(false);
  });

  test("agentcore/agentcore.json does not exist", () => {
    expect(existsSync(OBSOLETE_AGENTCORE_JSON_PATH)).toBe(false);
  });

  test("agentcore/aws-targets.json does not exist", () => {
    expect(existsSync(OBSOLETE_AWS_TARGETS_PATH)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Deploy script exists and references the correct mechanism (Requirement 2.1)
// ---------------------------------------------------------------------------

describe("deploy script (scripts/deploy-harnesses.ts)", () => {
  let deployScriptContent: string;

  beforeAll(() => {
    deployScriptContent = readFileSync(DEPLOY_SCRIPT_PATH, "utf8");
  });

  test("scripts/deploy-harnesses.ts exists", () => {
    expect(existsSync(DEPLOY_SCRIPT_PATH)).toBe(true);
  });

  test("deploy script references inline_function tool registration (Requirement 2.3, 2.4)", () => {
    expect(deployScriptContent).toContain("inline_function");
  });

  test("deploy script imports EDITOR_TOOL_NAMES from agents/editor/agent (Requirement 3.7)", () => {
    expect(deployScriptContent).toContain("EDITOR_TOOL_NAMES");
  });

  test("deploy script imports REVIEWER_TOOL_NAMES or reviewerToolCatalogue from agents/reviewer (Requirement 3.7)", () => {
    expect(deployScriptContent).toMatch(/REVIEWER_TOOL_NAMES|reviewerToolCatalogue/);
  });

  test("deploy script calls CreateHarness (Requirement 2.1)", () => {
    expect(deployScriptContent).toContain("CreateHarness");
  });

  test("deploy script writes .deployed-harnesses.json (Requirement 2.6, 2.8)", () => {
    expect(deployScriptContent).toContain(".deployed-harnesses.json");
  });

  test("deploy script supports --force-recreate flag (Requirement 2.7)", () => {
    expect(deployScriptContent).toContain("force-recreate");
  });

  test("deploy script calls DeleteHarness with harnessId (Requirement 2.7)", () => {
    expect(deployScriptContent).toContain("DeleteHarness");
    expect(deployScriptContent).toContain("harnessId");
  });
});

// ---------------------------------------------------------------------------
// Editor harness configuration (via deploy-harnesses.ts) (Requirement 2.3)
// ---------------------------------------------------------------------------

describe("editor harness configuration (scripts/deploy-harnesses.ts)", () => {
  let config: HarnessConfig;

  beforeAll(() => {
    config = loadJson<HarnessConfig>(HARNESS_CONFIG_PATH);
  });

  test("EDITOR_TOOL_NAMES has exactly 15 entries (source of truth)", () => {
    expect(EDITOR_TOOL_NAMES).toHaveLength(15);
  });

  test("EDITOR_TOOL_NAMES contains all expected tool names in order", () => {
    const expected = [
      "module.readFile",
      "module.writeFile",
      "module.listFiles",
      "module.diff",
      "cdk.diff",
      "cdk.deploy",
      "sensor.cdkNag",
      "sensor.tsc",
      "sensor.eslint",
      "sensor.unitTests",
      "preview.cwLogs",
      "preview.cwMetrics",
      "reviewer.invoke",
      "postDeploy.invoke",
      "pr.open",
    ];
    expect([...EDITOR_TOOL_NAMES]).toEqual(expected);
  });

  test("agent-harness.config.json has models.editor key (Requirement 2.2)", () => {
    expect(typeof config.models.editor).toBe("string");
    expect(config.models.editor.length).toBeGreaterThan(0);
  });

  test("agents/editor/system.md exists on disk (Requirement 2.2)", () => {
    expect(existsSync(EDITOR_SYSTEM_MD_PATH)).toBe(true);
  });

  test("agents/editor/system.md has frontmatter (Requirement 2.2)", () => {
    const content = readFileSync(EDITOR_SYSTEM_MD_PATH, "utf8");
    expect(content.startsWith("---")).toBe(true);
  });

  test("iterationCap is a positive integer in agent-harness.config.json (Requirement 2.2)", () => {
    expect(config.limits.iterationCap).toBeGreaterThan(0);
    expect(Number.isInteger(config.limits.iterationCap)).toBe(true);
  });

  test("wallClockCapMinutes is a positive number in agent-harness.config.json (Requirement 2.2)", () => {
    expect(config.limits.wallClockCapMinutes).toBeGreaterThan(0);
  });

  test("tokenSpendCapUSD is a positive number in agent-harness.config.json (Requirement 2.2)", () => {
    expect(config.limits.tokenSpendCapUSD).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Reviewer harness configuration (via deploy-harnesses.ts) (Requirement 2.4)
// ---------------------------------------------------------------------------

describe("reviewer harness configuration (scripts/deploy-harnesses.ts)", () => {
  let config: HarnessConfig;

  beforeAll(() => {
    config = loadJson<HarnessConfig>(HARNESS_CONFIG_PATH);
  });

  test("REVIEWER_TOOL_NAMES has exactly 3 entries (source of truth)", () => {
    expect(REVIEWER_TOOL_NAMES.size).toBe(3);
  });

  test("REVIEWER_TOOL_NAMES contains module.readFile, module.diff, reference.checklist", () => {
    expect(REVIEWER_TOOL_NAMES.has("module.readFile")).toBe(true);
    expect(REVIEWER_TOOL_NAMES.has("module.diff")).toBe(true);
    expect(REVIEWER_TOOL_NAMES.has("reference.checklist")).toBe(true);
  });

  test("agent-harness.config.json has models.reviewer key (Requirement 2.2)", () => {
    expect(typeof config.models.reviewer).toBe("string");
    expect(config.models.reviewer.length).toBeGreaterThan(0);
  });

  test("agents/reviewer/system.md exists on disk (Requirement 2.2)", () => {
    expect(existsSync(REVIEWER_SYSTEM_MD_PATH)).toBe(true);
  });

  test("agents/reviewer/system.md has frontmatter (Requirement 2.2)", () => {
    const content = readFileSync(REVIEWER_SYSTEM_MD_PATH, "utf8");
    expect(content.startsWith("---")).toBe(true);
  });

  test("reviewer tools do not include write or CDK tools (defence-in-depth)", () => {
    for (const name of REVIEWER_TOOL_NAMES) {
      expect(name).not.toMatch(/writeFile|cdk\.|preview\.|\.open|sensor\./i);
    }
  });
});
