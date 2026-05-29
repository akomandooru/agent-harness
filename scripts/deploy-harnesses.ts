#!/usr/bin/env ts-node
/**
 * deploy-harnesses.ts — Deploy the editor and reviewer AgentCore Managed Harnesses.
 *
 * Replaces the broken `agentcore deploy` CLI step with a direct SDK call to
 * `bedrock-agentcore-control:CreateHarness`. Modelled on
 * `scripts/test-create-harness.ts` (the proven SDK-direct reference).
 *
 * Usage:
 *   npx ts-node scripts/deploy-harnesses.ts \
 *     --account-id 123456789012 \
 *     --region us-east-1 \
 *     --execution-role arn:aws:iam::123456789012:role/agent-harness-editor \
 *     [--reviewer-execution-role arn:aws:iam::123456789012:role/agent-harness-reviewer] \
 *     [--force-recreate]
 *
 * Outputs:
 *   .deployed-harnesses.json  — { editor: { harnessId, arn }, reviewer: { harnessId, arn } }
 */

import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { rename } from "node:fs/promises";

import {
  BedrockAgentCoreControlClient,
  CreateHarnessCommand,
  DeleteHarnessCommand,
  GetHarnessCommand,
  ListHarnessesCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { CreateHarnessCommandInput } from "@aws-sdk/client-bedrock-agentcore-control";

// ---------------------------------------------------------------------------
// Agent source imports — single source of truth for tool names and schemas
// ---------------------------------------------------------------------------

import {
  parseEditorSystemPromptFrontmatter,
} from "../agents/editor/agent";

// Editor tool ToolDefinition exports (only the 3 module tools for CodeBuild)
import { readFileTool, writeFileTool, listFilesTool } from "../agents/editor/tools/module";

// Reviewer tool ToolDefinition exports
import {
  reviewerToolCatalogue,
  REVIEWER_TOOL_NAMES,
} from "../agents/reviewer/tools";
import { parseReviewerSystemPromptFrontmatter } from "../agents/reviewer/agent";

import type { ToolDefinition } from "@agent-harness/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Args {
  accountId: string;
  region: string;
  executionRoleArn: string;
  reviewerExecutionRoleArn: string;
  forceRecreate: boolean;
}

/**
 * Shape of the limits section in agent-harness.config.json.
 */
export interface HarnessLimitsConfig {
  readonly iterationCap: number;
  readonly tokenSpendCapUSD: number;
  readonly wallClockCapMinutes: number;
}

/**
 * Mapped SDK limit fields for CreateHarnessRequest.
 */
export interface MappedLimits {
  readonly maxIterations: number;
  readonly maxTokens: number;
  readonly timeoutSeconds: number;
}

/**
 * Shape of the deployed harnesses output file.
 */
export interface DeployedHarnessEntry {
  readonly harnessId: string;
  readonly arn: string;
}

export interface DeployedHarnessesFile {
  readonly editor: DeployedHarnessEntry;
  readonly reviewer: DeployedHarnessEntry;
}

/**
 * Options for pollUntilReady.
 */
export interface PollOptions {
  /** Poll interval in milliseconds. Default: 5000 (5 seconds). */
  readonly intervalMs?: number;
  /** Hard timeout in milliseconds. Default: 600000 (10 minutes). */
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> & { forceRecreate: boolean } = { forceRecreate: false };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--account-id") { args.accountId = value; i++; }
    else if (flag === "--region") { args.region = value; i++; }
    else if (flag === "--execution-role") { args.executionRoleArn = value; i++; }
    else if (flag === "--reviewer-execution-role") { args.reviewerExecutionRoleArn = value; i++; }
    else if (flag === "--force-recreate") { args.forceRecreate = true; }
  }

  if (!args.accountId || !args.region || !args.executionRoleArn) {
    console.error(
      "Usage: npx ts-node scripts/deploy-harnesses.ts \\\n" +
      "  --account-id <12-digit-id> \\\n" +
      "  --region <aws-region> \\\n" +
      "  --execution-role <editor-iam-role-arn> \\\n" +
      "  [--reviewer-execution-role <reviewer-iam-role-arn>] \\\n" +
      "  [--force-recreate]\n" +
      "\n" +
      "If --reviewer-execution-role is omitted, it is derived from\n" +
      "--execution-role by replacing 'agent-harness-editor' with\n" +
      "'agent-harness-reviewer'."
    );
    process.exit(1);
  }

  // Derive reviewer role ARN if not supplied.
  if (!args.reviewerExecutionRoleArn) {
    args.reviewerExecutionRoleArn = args.executionRoleArn.replace(
      "agent-harness-editor",
      "agent-harness-reviewer",
    );
  }

  return args as Args;
}

// ---------------------------------------------------------------------------
// Limits mapping
// ---------------------------------------------------------------------------

/**
 * Map agent-harness.config.json limits to CreateHarnessRequest SDK fields.
 *
 * - `iterationCap`       → `maxIterations`  (direct mapping)
 * - `tokenSpendCapUSD`   → `maxTokens`      (multiply by TOKENS_PER_USD placeholder)
 * - `wallClockCapMinutes`→ `timeoutSeconds` (multiply by 60)
 *
 * NOTE: The SDK's `maxTokens` is a token count, not a dollar amount.
 * We convert using a conservative placeholder of 1,000,000 tokens per USD
 * until a live-fire run pins the real ratio. This matches the
 * PROVISIONAL_DEPLOY_COST_USD convention in agents/editor/tools/cdk.ts.
 * A follow-up issue tracks pinning the ratio to a live-fire measurement.
 */
const TOKENS_PER_USD = 1_000_000;

export function mapLimits(config: HarnessLimitsConfig): MappedLimits {
  return {
    maxIterations: config.iterationCap,
    // Placeholder conversion: 1,000,000 tokens per USD.
    // Update this ratio once a live-fire run measures real token spend.
    maxTokens: Math.round(config.tokenSpendCapUSD * TOKENS_PER_USD),
    timeoutSeconds: config.wallClockCapMinutes * 60,
  };
}

// ---------------------------------------------------------------------------
// Tool name mangling
// ---------------------------------------------------------------------------

/**
 * Mangle a tool name for AgentCore's tool-name constraint.
 * AgentCore does not allow dots in tool names; replace with underscores.
 *
 * Example: "module.readFile" → "module_readFile"
 */
export function mangleToolName(name: string): string {
  return name.replace(/\./g, "_");
}

// ---------------------------------------------------------------------------
// Tool array builders
// ---------------------------------------------------------------------------

/**
 * One HarnessTool entry in the CreateHarnessRequest shape.
 * Matches the shape proven in test-create-harness.ts.
 */
interface HarnessTool {
  type: "inline_function";
  name: string;
  config: {
    inlineFunction: {
      description: string;
      inputSchema: unknown;
    };
  };
}

function toolDefToHarnessTool(tool: ToolDefinition<unknown, unknown>): HarnessTool {
  return {
    type: "inline_function",
    name: mangleToolName(tool.name),
    config: {
      inlineFunction: {
        description: tool.description ?? tool.name,
        // inputSchema is already a JSON Schema literal on every ToolDefinition
        // in this codebase. No Zod conversion required.
        inputSchema: tool.inputSchema,
      },
    },
  };
}

/**
 * Build the editor's 15-tool array.
 *
 * Tools are sourced directly from agents/editor/tools/*.ts and
 * agents/reviewer/agent.ts (for reviewer.invoke). The order matches
 * EDITOR_TOOL_NAMES for readability; the SDK does not require a specific order.
 *
 * The reviewer.invoke tool is created with a placeholder invocation since
 * the deploy script only needs the tool's name and inputSchema for
 * CreateHarness — the actual invocation wiring happens at runtime in the
 * orchestrator.
 */
function buildEditorToolArray(): HarnessTool[] {
  // CodeBuild orchestrator only exposes 3 module tools to the editor.
  // Sensors, deploy, reviewer, and PR tools are loop gates controlled
  // by the orchestrator — not tools the model calls directly.
  // See ADR-001 for rationale.
  const toolDefs: ToolDefinition<unknown, unknown>[] = [
    readFileTool as unknown as ToolDefinition<unknown, unknown>,
    writeFileTool as unknown as ToolDefinition<unknown, unknown>,
    listFilesTool as unknown as ToolDefinition<unknown, unknown>,
  ];

  const EXPECTED_TOOL_COUNT = 3;
  if (toolDefs.length !== EXPECTED_TOOL_COUNT) {
    throw new Error(
      `buildEditorToolArray: expected ${EXPECTED_TOOL_COUNT} tools, got ${toolDefs.length}`,
    );
  }

  return toolDefs.map(toolDefToHarnessTool);
}

/**
 * Build the reviewer's 3-tool array from reviewerToolCatalogue.
 */
function buildReviewerToolArray(): HarnessTool[] {
  const tools = reviewerToolCatalogue.map(toolDefToHarnessTool);

  // Verify we have exactly 3 tools matching REVIEWER_TOOL_NAMES.
  if (tools.length !== REVIEWER_TOOL_NAMES.size) {
    throw new Error(
      `buildReviewerToolArray: expected ${REVIEWER_TOOL_NAMES.size} tools, got ${tools.length}`,
    );
  }

  return tools;
}

// ---------------------------------------------------------------------------
// Config and prompt loading
// ---------------------------------------------------------------------------

interface HarnessConfig {
  readonly models: {
    readonly editor: string;
    readonly reviewer: string;
  };
  readonly limits: HarnessLimitsConfig;
}

function loadHarnessConfig(): HarnessConfig {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const raw = require(resolve(__dirname, "..", "agent-harness.config.json")) as unknown;
  const config = raw as Record<string, unknown>;
  if (
    typeof config !== "object" ||
    config === null ||
    typeof (config as { models?: unknown }).models !== "object" ||
    typeof (config as { limits?: unknown }).limits !== "object"
  ) {
    throw new Error("agent-harness.config.json: missing required 'models' or 'limits' object");
  }
  return config as unknown as HarnessConfig;
}

function loadSystemPrompt(agentPath: string, parser: (md: string) => { body: string }): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const raw = require("node:fs").readFileSync(agentPath, "utf8") as string;
  const parsed = parser(raw);
  return parsed.body;
}

// ---------------------------------------------------------------------------
// Existence check and idempotency
// ---------------------------------------------------------------------------

interface ExistingHarness {
  readonly harnessId: string;
  readonly arn: string;
}

/**
 * Paginate ListHarnesses and look for a harness with the given name.
 * Returns the existing harness entry if found, or undefined if not found.
 */
async function findExistingHarness(
  client: BedrockAgentCoreControlClient,
  harnessName: string,
): Promise<ExistingHarness | undefined> {
  let nextToken: string | undefined;
  do {
    const response = await client.send(
      new ListHarnessesCommand({ nextToken }),
    );
    const typedResponse = response as {
      harnesses?: ReadonlyArray<{
        harnessName?: string;
        harnessId?: string;
        arn?: string;
      }>;
      nextToken?: string;
    };
    for (const h of typedResponse.harnesses ?? []) {
      if (h.harnessName === harnessName && h.harnessId && h.arn) {
        return { harnessId: h.harnessId, arn: h.arn };
      }
    }
    nextToken = typedResponse.nextToken;
  } while (nextToken !== undefined);
  return undefined;
}

/**
 * Poll GetHarness until the harness is no longer found (i.e., deletion complete).
 * Used after DeleteHarness to wait for the delete to propagate.
 */
async function waitForDeletion(
  client: BedrockAgentCoreControlClient,
  harnessId: string,
  harnessName: string,
): Promise<void> {
  const timeoutMs = 5 * 60 * 1000; // 5 minutes for deletion
  const intervalMs = 5_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await client.send(new GetHarnessCommand({ harnessId }));
      const typedResponse = response as { harness?: { status?: string } };
      const status = typedResponse.harness?.status;
      console.log(`[${harnessName}] polling deletion: status=${status ?? "unknown"}`);
      // Still exists; wait and retry.
    } catch (err) {
      // Not-found error means deletion is complete.
      const awsErr = err as Error & { name?: string; $metadata?: { httpStatusCode?: number } };
      if (
        awsErr.name === "ResourceNotFoundException" ||
        awsErr.$metadata?.httpStatusCode === 404
      ) {
        console.log(`[${harnessName}] deletion confirmed.`);
        return;
      }
      throw err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`[${harnessName}] timed out waiting for deletion to complete`);
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/**
 * Poll GetHarness every `intervalMs` milliseconds until the harness reaches
 * status "READY". Throws on terminal failure statuses or hard timeout.
 *
 * Exported for unit tests.
 */
export async function pollUntilReady(
  client: BedrockAgentCoreControlClient,
  harnessId: string,
  options: PollOptions = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000; // 10 minutes
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await client.send(new GetHarnessCommand({ harnessId }));
    const typedResponse = response as { harness?: { status?: string; harnessName?: string } };
    const status = typedResponse.harness?.status;
    const name = typedResponse.harness?.harnessName ?? harnessId;

    console.log(`[${name}] polling status: ${status ?? "unknown"}`);

    if (status === "READY") {
      console.log(`[${name}] READY.`);
      return;
    }

    if (status === "FAILED" || status === "DELETING" || status === "DELETED") {
      throw new Error(
        `[${name}] harness reached terminal status '${status}' — cannot proceed`,
      );
    }

    await sleep(intervalMs);
  }

  throw new Error(
    `pollUntilReady: timed out after ${timeoutMs / 1000}s waiting for harness ${harnessId} to reach READY`,
  );
}

// ---------------------------------------------------------------------------
// Output artifact
// ---------------------------------------------------------------------------

const DEPLOYED_HARNESSES_PATH = resolve(__dirname, "..", ".deployed-harnesses.json");
const DEPLOYED_HARNESSES_TMP_PATH = DEPLOYED_HARNESSES_PATH + ".tmp";

/**
 * Write .deployed-harnesses.json atomically (write to .tmp then rename).
 * Exported for unit tests.
 */
export async function writeDeployedHarnessesFile(
  data: DeployedHarnessesFile,
): Promise<void> {
  const json = JSON.stringify(data, null, 2) + "\n";
  await fs.writeFile(DEPLOYED_HARNESSES_TMP_PATH, json, "utf8");
  await rename(DEPLOYED_HARNESSES_TMP_PATH, DEPLOYED_HARNESSES_PATH);
}

/**
 * Load .deployed-harnesses.json from disk.
 * Exported for unit tests.
 */
export async function loadDeployedHarnessesFile(): Promise<DeployedHarnessesFile> {
  const raw = await fs.readFile(DEPLOYED_HARNESSES_PATH, "utf8");
  return JSON.parse(raw) as DeployedHarnessesFile;
}

// ---------------------------------------------------------------------------
// Harness name constants
// ---------------------------------------------------------------------------

const EDITOR_HARNESS_NAME = "agent_harness_editor";
const REVIEWER_HARNESS_NAME = "agent_harness_reviewer";

// ---------------------------------------------------------------------------
// Deploy one harness
// ---------------------------------------------------------------------------

interface DeployHarnessOptions {
  readonly client: BedrockAgentCoreControlClient;
  readonly harnessName: string;
  readonly executionRoleArn: string;
  readonly modelId: string;
  readonly systemPrompt: string;
  readonly tools: HarnessTool[];
  readonly limits: MappedLimits;
  readonly forceRecreate: boolean;
}

async function deployHarness(opts: DeployHarnessOptions): Promise<DeployedHarnessEntry> {
  const {
    client,
    harnessName,
    executionRoleArn,
    modelId,
    systemPrompt,
    tools,
    limits,
    forceRecreate,
  } = opts;

  // Step 1: Existence check
  console.log(`[${harnessName}] existence check...`);
  const existing = await findExistingHarness(client, harnessName);

  if (existing !== undefined) {
    if (!forceRecreate) {
      console.log(`[${harnessName}] already exists (harnessId=${existing.harnessId}); reusing.`);
      return existing;
    }

    // --force-recreate: delete then recreate
    console.log(`[${harnessName}] --force-recreate: deleting existing harness (harnessId=${existing.harnessId})...`);
    await client.send(new DeleteHarnessCommand({ harnessId: existing.harnessId }));
    await waitForDeletion(client, existing.harnessId, harnessName);
  }

  // Step 2: Create
  console.log(`[${harnessName}] creating...`);
  const createResult = await client.send(
    new CreateHarnessCommand({
      harnessName,
      executionRoleArn,
      model: {
        bedrockModelConfig: {
          modelId,
        },
      },
      systemPrompt: [{ text: systemPrompt }],
      tools: tools as unknown as CreateHarnessCommandInput["tools"],
      maxIterations: limits.maxIterations,
      maxTokens: limits.maxTokens,
      timeoutSeconds: limits.timeoutSeconds,
    }),
  );

  const typedResult = createResult as {
    harness?: { harnessId?: string; arn?: string };
  };
  const harnessId = typedResult.harness?.harnessId;
  const arn = typedResult.harness?.arn;

  if (!harnessId || !arn) {
    throw new Error(`[${harnessName}] CreateHarness did not return harnessId or arn`);
  }

  console.log(`[${harnessName}] created (harnessId=${harnessId}, arn=${arn})`);

  // Step 3: Poll until READY
  console.log(`[${harnessName}] polling status...`);
  await pollUntilReady(client, harnessId);

  return { harnessId, arn };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  console.log("Deploy parameters:");
  console.log("  Account:                  " + args.accountId);
  console.log("  Region:                   " + args.region);
  console.log("  Editor execution role:    " + args.executionRoleArn);
  console.log("  Reviewer execution role:  " + args.reviewerExecutionRoleArn);
  console.log("  Force recreate:           " + args.forceRecreate);
  console.log("");

  // Load config
  const config = loadHarnessConfig();
  const limits = mapLimits(config.limits);

  // Load system prompts (frontmatter stripped by reusing the agent parsers)
  const editorSystemPrompt = loadSystemPrompt(
    resolve(__dirname, "..", "agents", "editor", "system.md"),
    parseEditorSystemPromptFrontmatter,
  );
  const reviewerSystemPrompt = loadSystemPrompt(
    resolve(__dirname, "..", "agents", "reviewer", "system.md"),
    parseReviewerSystemPromptFrontmatter,
  );

  // Build tool arrays
  const editorTools = buildEditorToolArray();
  const reviewerTools = buildReviewerToolArray();

  console.log(`Editor tools: ${editorTools.length} (expected 3)`);
  console.log(`Reviewer tools: ${reviewerTools.length} (expected 3)`);
  console.log("");

  const client = new BedrockAgentCoreControlClient({ region: args.region });

  // Deploy editor harness
  const editorEntry = await deployHarness({
    client,
    harnessName: EDITOR_HARNESS_NAME,
    executionRoleArn: args.executionRoleArn,
    modelId: config.models.editor,
    systemPrompt: editorSystemPrompt,
    tools: editorTools,
    limits,
    forceRecreate: args.forceRecreate,
  });

  // Deploy reviewer harness
  const reviewerEntry = await deployHarness({
    client,
    harnessName: REVIEWER_HARNESS_NAME,
    executionRoleArn: args.reviewerExecutionRoleArn,
    modelId: config.models.reviewer,
    systemPrompt: reviewerSystemPrompt,
    tools: reviewerTools,
    limits,
    forceRecreate: args.forceRecreate,
  });

  // Write output artifact atomically
  const output: DeployedHarnessesFile = {
    editor: editorEntry,
    reviewer: reviewerEntry,
  };
  await writeDeployedHarnessesFile(output);
  console.log(`[deploy-harnesses] wrote artifact: .deployed-harnesses.json`);
  console.log("  Editor   ARN: " + editorEntry.arn);
  console.log("  Reviewer ARN: " + reviewerEntry.arn);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
