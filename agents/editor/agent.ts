/**
 * Editor agent definition and tool-catalogue factory.
 *
 * This module is the seam between the editor agent and the rest of the
 * harness. It mirrors the reviewer's `agent.ts` (see
 * `agents/reviewer/agent.ts`) so a forker reading both files sees the
 * same shape on each side:
 *
 *   - `EditorAgentDefinition` and `loadEditorAgentDefinition()` describe
 *     the editor agent. The definition pulls the model id from
 *     `agent-harness.config.json` (`models.editor`), the system prompt
 *     and its version from `agents/editor/system.md`, and the tool
 *     catalogue from this module's `buildEditorToolCatalogue` factory.
 *     The harness config at `app/editor/harness.json` references these
 *     values; `agentcore deploy` reads them at deploy time.
 *
 *   - `buildEditorToolCatalogue(deps)` assembles the editor's full tool
 *     surface: the four `module.*` file tools, the two `cdk.*` tools,
 *     the four `sensor.*` computational sensors, the two `preview.*`
 *     observation tools, the `pr.open` tool, the `postDeploy.invoke`
 *     tool, and the `reviewer.invoke` tool. The orchestrator builds
 *     this once per session, injecting the runners and clients that
 *     own SDK lifecycles (CDK CLI runner, sensor runner, GitHub
 *     client, post-deploy runner, reviewer invocation).
 *
 * Why the orchestrator owns the runners and clients (and this module
 * does not). The editor's tool surface fans out to four classes of
 * external collaborators: the CDK CLI, local CLIs (`tsc`, `eslint`,
 * `jest`, `cdk synth` for cdk-nag), AWS SDK clients (CloudWatch logs
 * and metrics), and the GitHub REST API. Each has a credential or
 * lifecycle the wrapper layer should not know about. The tool wrappers
 * already accept the runner/client injection points
 * (`createCdkDeployTool(runner)`, `createCwLogsTool(clients)`,
 * `createPrOpenTool(client)`, etc.); this factory just wires them
 * through. Tests pass stubs; production passes the real runners and
 * SDK clients.
 *
 * Why a factory rather than a static catalogue. The reviewer's
 * `tools.ts` exports a frozen `reviewerToolCatalogue` because all three
 * reviewer tools are pure read-only and need nothing injected. The
 * editor cannot do that: `cdk.deploy` needs a CLI runner, the
 * `preview.*` tools need CloudWatch SDK clients, `pr.open` needs a
 * session-bound GitHub client, `postDeploy.invoke` needs the
 * post-deploy runner and a per-session context object, and
 * `reviewer.invoke` needs the orchestrator-built `ReviewerInvocation`.
 * A factory keeps the injection seam visible at the call site.
 *
 * This module is data-only: it describes the agent definition and tool
 * catalogue as plain TypeScript values. Nothing here imports the AWS
 * SDK or AgentCore. The runtime invocation is handled by
 * `ManagedHarnessEditorInvocation` in `managed-harness-invocation.ts`,
 * which calls `InvokeHarness` against the deployed editor harness ARN.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ToolDefinition } from "@agent-harness/shared";
import {
  createReviewerInvokeTool,
  type CreateReviewerInvokeToolOptions,
  type ReviewerInvocation,
} from "../reviewer/agent";

import {
  createCdkDeployTool,
  createCdkDiffTool,
  type CdkRunner,
} from "./tools/cdk";
import { diffTool, listFilesTool, readFileTool, writeFileTool } from "./tools/module";
import {
  createPostDeployTool,
  type PostDeployContext,
  type PostDeployRunner,
} from "./tools/post-deploy";
import {
  createCwLogsTool,
  createCwMetricsTool,
  type CloudWatchClients,
} from "./tools/preview";
import { createPrOpenTool, type GitHubClient } from "./tools/pr";
import {
  createCdkNagTool,
  createEslintTool,
  createTscTool,
  createUnitTestsTool,
  type SensorRunner,
} from "./tools/sensors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Static description of the editor agent.
 *
 * The orchestrator reads this to build the `ManagedHarnessEditorInvocation`
 * and to validate the harness config at `app/editor/harness.json`. The
 * shape is deliberately data-only: nothing in this module imports the
 * AWS SDK or AgentCore, so a forker can inspect the agent definition
 * without pulling in runtime dependencies.
 *
 * Why version the system prompt? Two editors are not equivalent if
 * their prompts are not equivalent. Pinning a version in the prompt's
 * frontmatter lets the agent definition reference the prompt by
 * version, and lets a forker change the prompt safely (bump the
 * version; downstream tests can assert the version they expect). This
 * mirrors the reviewer's pattern in `agents/reviewer/agent.ts`.
 */
export interface EditorAgentDefinition {
  /** Bedrock model identifier from `agent-harness.config.json` `models.editor`. */
  readonly model: string;
  /** Version string from the system prompt's YAML frontmatter (`version` key). */
  readonly systemPromptVersion: string;
  /** Body of the system prompt with the frontmatter stripped. */
  readonly systemPrompt: string;
  /** Editor-side tool catalogue. The full editor surface (15 tools). */
  readonly tools: EditorTools;
}

/**
 * The editor's tool catalogue type. A read-only array of `ToolDefinition`s
 * spanning the 15 tools the design's Tool catalogue table specifies.
 *
 * The shape is identical to the reviewer's catalogue type (a plain
 * `ReadonlyArray<ToolDefinition<unknown, unknown>>`); the type alias
 * exists so callers reading the agent definition see one named symbol
 * rather than a wide structural type, and so a future expansion of the
 * catalogue can be a single rename.
 */
export type EditorTools = ReadonlyArray<ToolDefinition<unknown, unknown>>;

/**
 * Result of parsing the YAML frontmatter at the top of `system.md`.
 *
 * Shape is intentionally identical to `ParsedSystemPrompt` in
 * `agents/reviewer/agent.ts`; the parser is reimplemented below for
 * clarity (per the task brief) rather than imported. Two
 * three-line-frontmatter parsers are easier to reason about than one
 * shared helper in a separate package.
 */
export interface ParsedEditorSystemPrompt {
  readonly version: string;
  readonly body: string;
}

// ---------------------------------------------------------------------------
// System-prompt loading
// ---------------------------------------------------------------------------

/**
 * Parse the `---`-delimited YAML frontmatter at the top of a markdown
 * file and return the `version` value plus the body.
 *
 * The editor's `system.md` opens with:
 *
 *     ---
 *     prompt: agents/editor/system.md
 *     version: 1.0.0
 *     ---
 *
 * This parser handles only the subset of YAML the frontmatter uses
 * (top-level `key: value` lines, optional surrounding whitespace, no
 * nested objects). A full YAML parser would be overkill for a
 * three-line block and would add a dependency we do not otherwise
 * need.
 *
 * Throws when the frontmatter is missing or malformed. Callers should
 * let the throw surface; a malformed system prompt is a build-time
 * error, not a runtime condition the editor can recover from.
 */
export function parseEditorSystemPromptFrontmatter(
  markdown: string,
): ParsedEditorSystemPrompt {
  // Frontmatter must be the first non-empty content. Allow a leading
  // BOM (Windows editors sometimes save with one) so the parser is
  // forgiving about file-handling differences.
  const trimmed = markdown.replace(/^\uFEFF/, "");
  const startMarker = trimmed.match(/^---\r?\n/);
  if (startMarker === null) {
    throw new Error(
      "editor system.md: expected YAML frontmatter starting with '---' on the first line",
    );
  }
  const afterStart = trimmed.slice(startMarker[0].length);

  // The closing `---` must be on its own line. Search for the next
  // such line; the content between is the frontmatter body.
  const endMatch = afterStart.match(/\r?\n---\r?\n/);
  if (endMatch === null || endMatch.index === undefined) {
    throw new Error(
      "editor system.md: frontmatter is missing a closing '---' delimiter",
    );
  }
  const frontmatterBody = afterStart.slice(0, endMatch.index);
  const bodyAfterFrontmatter = afterStart.slice(
    endMatch.index + endMatch[0].length,
  );

  // Tiny key:value parser. Skip blank and comment lines; reject
  // anything that does not look like a top-level scalar entry.
  const entries: Record<string, string> = {};
  for (const rawLine of frontmatterBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 1) {
      throw new Error(
        `editor system.md: malformed frontmatter line ${JSON.stringify(rawLine)}`,
      );
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    entries[key] = stripFrontmatterScalarQuotes(value);
  }

  const version = entries["version"];
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(
      "editor system.md: frontmatter is missing a non-empty 'version' field",
    );
  }

  return {
    version,
    body: bodyAfterFrontmatter.replace(/^\r?\n/, ""),
  };
}

/**
 * Strip a single layer of matching single or double quotes from a YAML
 * scalar. The frontmatter today uses bare scalars, but tolerating
 * quotes is cheap and prevents surprises if a forker quotes the
 * version string.
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
// Tool-catalogue factory
// ---------------------------------------------------------------------------

/**
 * Dependency injection bag for `buildEditorToolCatalogue`. Every field
 * has a runtime default (or is wired to the orchestrator's session
 * state); tests pass stubs.
 *
 * The four optional fields (`cdkRunner`, `sensorRunner`, `githubClient`,
 * `cloudWatchClients`) all have production defaults inside their
 * respective tool factories. Passing them is for tests that want to
 * exercise the wiring without spawning real subprocesses or hitting
 * AWS / GitHub.
 *
 * The five required fields (`postDeployRunner`, `postDeployContext`,
 * `reviewerInvocation`, plus the optional `reviewerInvokeOptions` and
 * `prClient` placement) are required because they are session-scoped:
 * the orchestrator must build them per session and hand them in. A
 * static default would either smuggle session state into module load
 * (bad) or fail loudly on first use (also bad — fail-fast is fine, but
 * with the factory making the requirement explicit at call time the
 * misconfiguration is impossible to overlook).
 */
export interface EditorToolCatalogueDependencies {
  // ---- Required, session-scoped -----------------------------------
  /**
   * Synthetic post-deploy runner. Production: `runPostDeploy` from
   * `@agent-harness/post-deploy`. Tests pass a stub matching
   * `PostDeployRunner`.
   */
  readonly postDeployRunner: PostDeployRunner;
  /**
   * Mutable per-session context the orchestrator updates between
   * iterations so `postDeploy.invoke` picks up the latest deploy
   * result. See `tools/post-deploy.ts` for the lifecycle contract.
   */
  readonly postDeployContext: PostDeployContext;
  /**
   * Reviewer invocation built by the orchestrator. Production: a
   * `ManagedHarnessReviewerInvocation` from
   * `harness/scheduled-reviewer/src/run.ts`. Tests pass a
   * `RecordedReviewerInvocation` from `@agent-harness/reviewer`.
   */
  readonly reviewerInvocation: ReviewerInvocation;

  // ---- Optional, with sensible defaults --------------------------
  /**
   * CDK CLI runner used by `cdk.diff` and `cdk.deploy`. Defaults to
   * the production `defaultCdkRunner` (spawns `npx cdk`).
   */
  readonly cdkRunner?: CdkRunner;
  /**
   * Sensor runner used by all four `sensor.*` tools. Defaults to the
   * production `defaultSensorRunner` (spawns `npx <tool>`).
   */
  readonly sensorRunner?: SensorRunner;
  /**
   * GitHub client for `pr.open`. Production: built by the
   * orchestrator from `defaultGitHubClient({ token, repository })`
   * after extracting the trigger payload. If omitted, the tool's
   * default placeholder client throws on first call with a clear
   * misconfiguration message.
   */
  readonly githubClient?: GitHubClient;
  /**
   * CloudWatch SDK clients for `preview.cwLogs` and
   * `preview.cwMetrics`. Defaults to lazily-constructed real SDK
   * clients picking up credentials and region from the SDK chain.
   */
  readonly cloudWatchClients?: CloudWatchClients;
  /**
   * Optional knobs for `createReviewerInvokeTool`, principally
   * `costUsdProvider`. The orchestrator typically sets this to map
   * Bedrock token counts to USD. Tests usually omit it.
   */
  readonly reviewerInvokeOptions?: CreateReviewerInvokeToolOptions;
}

/**
 * Build the editor's tool catalogue from the supplied dependencies.
 *
 * Returns the array of `ToolDefinition`s the orchestrator uses when
 * validating the harness config and building the `LoopGates`. The order
 * of the array matches the design's Tool catalogue table for the editor:
 * file tools, CDK tools, sensors, preview tools, reviewer, post-deploy,
 * pr.open. Order is not semantically important to the wrapper layer
 * but matches the design for readability.
 *
 * Total count: 15 tools.
 *
 *   - `module.readFile`     (file tool)
 *   - `module.writeFile`    (file tool)
 *   - `module.listFiles`    (file tool)
 *   - `module.diff`         (file tool)
 *   - `cdk.diff`            (CDK tool)
 *   - `cdk.deploy`          (CDK tool)
 *   - `sensor.cdkNag`       (sensor)
 *   - `sensor.tsc`          (sensor)
 *   - `sensor.eslint`       (sensor)
 *   - `sensor.unitTests`    (sensor)
 *   - `preview.cwLogs`      (preview observation)
 *   - `preview.cwMetrics`   (preview observation)
 *   - `reviewer.invoke`     (tool-as-agent)
 *   - `postDeploy.invoke`   (synthetic harness)
 *   - `pr.open`             (PR creation)
 */
export function buildEditorToolCatalogue(
  deps: EditorToolCatalogueDependencies,
): EditorTools {
  // Cast each tool through `unknown` so the heterogeneously-typed
  // tools live in one array without losing the per-tool typed exports
  // on their factories. Same approach as the reviewer's catalogue.
  const tools: ReadonlyArray<ToolDefinition<unknown, unknown>> = [
    // File tools — no injection needed; the wrapper layer handles
    // path scoping and the handlers call into the local filesystem.
    readFileTool as unknown as ToolDefinition<unknown, unknown>,
    writeFileTool as unknown as ToolDefinition<unknown, unknown>,
    listFilesTool as unknown as ToolDefinition<unknown, unknown>,
    diffTool as unknown as ToolDefinition<unknown, unknown>,
    // CDK tools — runner injected so tests can avoid spawning npx.
    createCdkDiffTool(deps.cdkRunner) as unknown as ToolDefinition<unknown, unknown>,
    createCdkDeployTool(deps.cdkRunner) as unknown as ToolDefinition<unknown, unknown>,
    // Computational sensors — runner injected per CDK.
    createCdkNagTool(deps.sensorRunner) as unknown as ToolDefinition<unknown, unknown>,
    createTscTool(deps.sensorRunner) as unknown as ToolDefinition<unknown, unknown>,
    createEslintTool(deps.sensorRunner) as unknown as ToolDefinition<unknown, unknown>,
    createUnitTestsTool(deps.sensorRunner) as unknown as ToolDefinition<unknown, unknown>,
    // Preview observation — CloudWatch SDK clients injected.
    createCwLogsTool(deps.cloudWatchClients) as unknown as ToolDefinition<unknown, unknown>,
    createCwMetricsTool(deps.cloudWatchClients) as unknown as ToolDefinition<unknown, unknown>,
    // Reviewer-as-tool. The reviewer wrapper rejects pass-through
    // prompts at the input-schema level (see
    // `@agent-harness/reviewer`'s `createReviewerInvokeTool`).
    createReviewerInvokeTool(
      deps.reviewerInvocation,
      deps.reviewerInvokeOptions,
    ) as unknown as ToolDefinition<unknown, unknown>,
    // Post-deploy harness. Context is mutable and updated by the
    // orchestrator between iterations.
    createPostDeployTool(
      deps.postDeployRunner,
      deps.postDeployContext,
    ) as unknown as ToolDefinition<unknown, unknown>,
    // PR creation. If `githubClient` is omitted, the factory's
    // placeholder client throws on call.
    createPrOpenTool(deps.githubClient) as unknown as ToolDefinition<
      unknown,
      unknown
    >,
  ];
  return Object.freeze(tools);
}

// ---------------------------------------------------------------------------
// Definition loader
// ---------------------------------------------------------------------------

/**
 * Optional inputs to `loadEditorAgentDefinition`. Tests use these to
 * point the loader at fixture files; production code passes the
 * required runtime dependencies in `tools` (or `dependencies`) and
 * gets the on-disk system prompt and config defaults.
 *
 * Exactly one of `tools` and `dependencies` should be supplied:
 *
 *   - `tools`: a fully-built catalogue (typically what tests pass so
 *     they can stub the entire surface in one go).
 *   - `dependencies`: dependencies for `buildEditorToolCatalogue`. The
 *     loader builds the catalogue itself. This is the production path.
 *
 * If neither is supplied, the loader throws — there is no sensible
 * default tool catalogue (the editor needs runner/client injection to
 * be runnable).
 */
export interface LoadEditorAgentDefinitionOptions {
  /** Absolute path to `agent-harness.config.json`. Default: repo root. */
  readonly configPath?: string;
  /** Absolute path to `agents/editor/system.md`. Default: alongside this file. */
  readonly systemPromptPath?: string;
  /**
   * Pre-built tool catalogue. Mutually exclusive with `dependencies`.
   * Tests typically pass an array of stub tools so they can exercise
   * the loader's shape assertions without wiring real injection.
   */
  readonly tools?: EditorTools;
  /**
   * Runtime dependencies for `buildEditorToolCatalogue`. The loader
   * calls `buildEditorToolCatalogue(dependencies)` to produce the
   * catalogue. Mutually exclusive with `tools`.
   */
  readonly dependencies?: EditorToolCatalogueDependencies;}

/**
 * Build the editor's `EditorAgentDefinition` from the on-disk system
 * prompt, repo config, and tool catalogue.
 *
 * The function is synchronous because it reads two small files (the
 * system prompt and the JSON config) at startup; making the
 * orchestrator await an async loader would add no value.
 *
 * Tests inject `configPath`, `systemPromptPath`, and either `tools` or
 * `dependencies` so they can exercise the loader with controlled
 * inputs.
 */
export function loadEditorAgentDefinition(
  options: LoadEditorAgentDefinitionOptions = {},
): EditorAgentDefinition {
  const systemPromptPath =
    options.systemPromptPath ?? defaultSystemPromptPath();
  const configPath = options.configPath ?? defaultConfigPath();

  const promptRaw = readFileSync(systemPromptPath, "utf8");
  const parsed = parseEditorSystemPromptFrontmatter(promptRaw);

  const configRaw = readFileSync(configPath, "utf8");
  const config = parseHarnessConfig(configRaw, configPath);

  const tools = resolveTools(options);

  return {
    model: config.models.editor,
    systemPromptVersion: parsed.version,
    systemPrompt: parsed.body,
    tools,
  };
}

/**
 * Resolve the catalogue from `LoadEditorAgentDefinitionOptions`. Either
 * `tools` is provided directly, or `dependencies` is provided and we
 * build the catalogue ourselves. Supplying both is a programmer error
 * because there is no sensible merge: the call site needs to pick one.
 */
function resolveTools(options: LoadEditorAgentDefinitionOptions): EditorTools {
  if (options.tools !== undefined && options.dependencies !== undefined) {
    throw new Error(
      "loadEditorAgentDefinition: pass either 'tools' (pre-built) or " +
        "'dependencies' (to build), not both",
    );
  }
  if (options.tools !== undefined) return options.tools;
  if (options.dependencies !== undefined) {
    return buildEditorToolCatalogue(options.dependencies);
  }
  throw new Error(
    "loadEditorAgentDefinition: missing tool catalogue. Pass 'tools' or " +
      "'dependencies' so the editor's tool surface is wired before use.",
  );
}

/**
 * Minimal subset of `agent-harness.config.json` the editor cares
 * about. The full config is validated by
 * `scripts/validate-config.ts`; this loader is content with extracting
 * the one field the editor uses.
 */
interface HarnessConfigFragment {
  readonly models: { readonly editor: string };
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
    throw new Error(`${configPath}: missing required 'models' object`);
  }
  const models = (parsed as { models: Record<string, unknown> }).models;
  const editor = models["editor"];
  if (typeof editor !== "string" || editor.length === 0) {
    throw new Error(`${configPath}: missing required 'models.editor' string`);
  }
  return { models: { editor } };
}

function defaultSystemPromptPath(): string {
  return resolve(__dirname, "system.md");
}

function defaultConfigPath(): string {
  // `__dirname` is `agents/editor`. The config lives at the repo root,
  // two levels up.
  return resolve(__dirname, "..", "..", "agent-harness.config.json");
}

// ---------------------------------------------------------------------------
// Re-export tool-name constants for tests and orchestrator use
// ---------------------------------------------------------------------------

/**
 * Stable list of editor tool names, in catalogue order.
 *
 * The orchestrator uses this to confirm registration; tests use it to
 * assert that the catalogue contains exactly the 15 tools the design
 * declares without being sensitive to the per-tool typed shape.
 *
 * Frozen so a runtime caller cannot mutate the array reference.
 */
export const EDITOR_TOOL_NAMES: ReadonlyArray<string> = Object.freeze([
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
]);
