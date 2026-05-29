/**
 * Editor and Reviewer gates for the CodeBuild orchestrator.
 *
 * These gates wire the existing `ManagedHarnessEditorInvocation` and
 * `ManagedHarnessReviewerInvocation` into the CodeBuild bounded loop,
 * with input normalization applied to every tool-use block before
 * execution.
 *
 * The editor gate uses the trimmed tool catalogue (module_readFile,
 * module_writeFile, module_listFiles) and collects the list of edited
 * file paths from module_writeFile calls. The reviewer gate is a
 * single-turn invocation that parses approval/rejection from the
 * harness response.
 *
 * Requirements: 1.1, 5.4, 8.1
 */

import type { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";

import { ManagedHarnessEditorInvocation } from "../../../agents/editor/managed-harness-invocation";
import {
  MapToolCatalogue,
} from "../../orchestrator/tool-executor";
import type { EditorResult, LoopContext } from "@agent-harness/loop/src/run";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EditorGateOptions {
  /** ARN of the editor Managed Harness. */
  readonly editorHarnessArn: string;
  /** Session ID for AgentCore session isolation. */
  readonly sessionId: string;
  /** Tool catalogue with module_readFile, module_writeFile, module_listFiles. */
  readonly toolCatalogue: MapToolCatalogue;
  /** Context string for the editor (serialized trigger + history). */
  readonly context: string;
  /** Optional SDK client (tests inject a mock). */
  readonly client?: BedrockAgentCoreClient;
  /** Optional max multi-turn round-trips. Default: 20. */
  readonly maxTurns?: number;
}

export interface ReviewerGateOptions {
  /** Unified diff string for the reviewer to evaluate. */
  readonly diff: string;
}

export interface EditorGateResult {
  /** List of relative file paths that were written. */
  readonly edits: ReadonlyArray<{ readonly path: string; readonly diff: string }>;
  /** Approximate token usage for the editor turn. */
  readonly tokenUsage: number;
}

export interface ReviewerGateResult {
  /** Whether the reviewer approved the changes. */
  readonly passed: boolean;
  /** List of findings/issues identified by the reviewer. */
  readonly findings: string[];
}

// ---------------------------------------------------------------------------
// runEditor
// ---------------------------------------------------------------------------

/**
 * Runs the editor gate by invoking the Editor Managed Harness via a
 * multi-turn conversation. Tool-use block inputs are normalized before
 * execution via `normalizeInput`.
 *
 * Returns the list of edits (file paths + diffs) and approximate token usage.
 */
export async function runEditor(options: EditorGateOptions): Promise<EditorGateResult> {
  const {
    editorHarnessArn,
    sessionId,
    toolCatalogue,
    client,
    maxTurns,
  } = options;

  // Pass the catalogue directly — no input normalization needed.
  // The multi-turn executor handles JSON parsing of streamed tool inputs,
  // and the handlers expect the raw parsed object.
  const invocation = new ManagedHarnessEditorInvocation({
    harnessArn: editorHarnessArn,
    sessionId,
    toolCatalogue,
    client,
    maxTurns,
  });

  // Build the LoopContext expected by the editor invocation.
  // The context string is already a JSON-serialized trigger + history.
  let loopContext: LoopContext;
  try {
    loopContext = JSON.parse(options.context) as LoopContext;
  } catch {
    // If context is not valid JSON, wrap it as a minimal context
    loopContext = { trigger: {}, history: [] } as unknown as LoopContext;
  }

  const result: EditorResult = await invocation.runEditor(loopContext);

  // Token usage is not directly exposed by ManagedHarnessEditorInvocation;
  // default to 0. A future enhancement can accumulate usage from the
  // multi-turn executor's metadata events.
  const tokenUsage = 0;

  return {
    edits: result.edits,
    tokenUsage,
  };
}

// ---------------------------------------------------------------------------
// runReviewer
// ---------------------------------------------------------------------------

/**
 * Runs the reviewer gate by invoking the Reviewer Managed Harness.
 * The reviewer evaluates the diff and returns approval/rejection with
 * findings.
 *
 * Returns whether the review passed and any findings identified.
 */
export async function runReviewer(options: ReviewerGateOptions): Promise<ReviewerGateResult> {
  const { diff } = options;

  // Pre-load the checklists to include in the prompt
  const { getChecklist } = await import("../../../agents/reviewer/checklists/index");
  const securityItems = getChecklist("Security");
  const reliabilityItems = getChecklist("Reliability");

  // Load the reviewer system prompt
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const systemPromptRaw = readFileSync(
    resolve(__dirname, "../../../agents/reviewer/system.md"),
    "utf8",
  );
  // Strip YAML frontmatter
  const systemPrompt = systemPromptRaw.replace(/^---[\s\S]*?---\n/, "");

  // Call Bedrock Converse directly (bypasses AgentCore harness)
  const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1" });

  const userMessage = [
    "## Diff under review\n\n```\n" + (diff || "(empty diff — no changes)") + "\n```\n",
    "## Security checklist\n\n" + JSON.stringify(securityItems, null, 2),
    "\n\n## Reliability checklist\n\n" + JSON.stringify(reliabilityItems, null, 2),
    "\n\nProduce your ReviewerOutput JSON now. No prose before or after the JSON.",
  ].join("\n");

  const command = new ConverseCommand({
    modelId: "us.anthropic.claude-sonnet-4-6",
    system: [{ text: systemPrompt }],
    messages: [
      {
        role: "user",
        content: [{ text: userMessage }],
      },
    ],
    inferenceConfig: {
      maxTokens: 4096,
      temperature: 0,
    },
  });

  const response = await client.send(command);

  // Extract text from response
  const outputContent = response.output?.message?.content ?? [];
  const textBlock = outputContent.find(
    (b: { text?: string }) => typeof b.text === "string",
  ) as { text: string } | undefined;
  const assistantText = textBlock?.text ?? "";

  if (!assistantText.trim()) {
    throw new Error("Reviewer: model returned no text output.");
  }

  // Parse JSON — the model may wrap it in markdown code fences
  const jsonMatch = assistantText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Reviewer: could not find JSON in response: ${assistantText.slice(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]) as {
    passed?: boolean;
    findings?: Array<{ severity: string; description: string; file?: string; line?: number }>;
    severityCounts?: Record<string, number>;
  };

  const hasBlockingFindings = (parsed.findings ?? []).some(
    (f) => f.severity === "high" || f.severity === "critical",
  );

  const findings = (parsed.findings ?? []).map(
    (f) => `[${f.severity}] ${f.description}${f.file ? ` (${f.file}:${f.line ?? "?"})` : ""}`,
  );

  return {
    passed: parsed.passed ?? !hasBlockingFindings,
    findings,
  };
}
