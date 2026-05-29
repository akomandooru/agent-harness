/**
 * `ManagedHarnessEditorInvocation` — `LoopGates.runEditor` adapter backed
 * by AWS Bedrock AgentCore Managed Harness.
 *
 * This module is a runtime concern; it is intentionally separate from
 * `agents/editor/agent.ts` (which holds the data-only `EditorAgentDefinition`
 * and tool-catalogue factory). Mixing the two would force every test that
 * imports `EditorAgentDefinition` to also resolve the AWS SDK; keeping them
 * separate maintains the data/runtime split that already shapes the
 * codebase.
 *
 * What it does
 *
 *   On `runEditor(context)`:
 *     1. Serialise the supplied `LoopContext` (trigger + history) as a
 *        single JSON string and send it as one user message to the
 *        configured editor harness via `MultiTurnExecutor`.
 *     2. The MultiTurnExecutor handles the multi-turn loop: detecting
 *        `stopReason: "tool_use"`, executing inline_function tools via
 *        the registered ToolCatalogue, and re-invoking InvokeHarness
 *        with toolResult content blocks until a terminal stop reason.
 *     3. After the multi-turn conversation completes, walk all messages
 *        to extract `module.writeFile` tool-use calls and their inputs.
 *        For each writeFile call, compute a diff from the prior contents
 *        (captured from any preceding `module.readFile` result for the
 *        same path, or empty if never read) versus the new contents.
 *     4. Return `EditorResult { edits }`.
 *
 * What it deliberately doesn't do
 *
 *   - It does not catch SDK throws and convert them into empty results.
 *     A network failure, throttling, access-denied, or validation error
 *     propagates so `runLoop()` can record the iteration as failed and
 *     evaluate stop conditions.
 *
 *   - It does not register or override the harness's tool catalogue or
 *     system prompt. The tool catalogue passed here is for executing
 *     inline_function tools locally during multi-turn conversation.
 *
 *   - It does not reach into the orchestrator's local filesystem to
 *     diff against the working tree. The Lambda has no working copy of
 *     the module under maintenance — only what the harness streams back
 *     in tool events.
 *
 * Lifecycle
 *
 *   The orchestrator constructs one `ManagedHarnessEditorInvocation` per
 *   session. The `BedrockAgentCoreClient` is reused across iterations
 *   (connection pooling); the `harnessArn` and `sessionId` are stable for
 *   the lifetime of the session.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 10.1, 10.2, 10.3
 */

import {
  BedrockAgentCoreClient,
} from "@aws-sdk/client-bedrock-agentcore";

import type { EditorResult, LoopContext } from "@agent-harness/loop/src/run";
import { MultiTurnExecutor, type Message, type ContentBlock } from "../../app/orchestrator/multi-turn-executor";
import type { ToolCatalogue } from "../../app/orchestrator/tool-executor";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Construction options for `ManagedHarnessEditorInvocation`.
 *
 * `client` is optional and defaults to a freshly-constructed
 * `BedrockAgentCoreClient({})` that picks up region and credentials from
 * the AWS SDK chain. Tests inject a mocked client via
 * `aws-sdk-client-mock` so no real AWS traffic is required.
 */
export interface ManagedHarnessEditorInvocationOptions {
  /** ARN of the editor Managed Harness produced by `agentcore deploy`. */
  readonly harnessArn: string;
  /**
   * Session id used as `runtimeSessionId` in every `InvokeHarness` call.
   * The orchestrator passes the session id from the trigger payload so
   * the harness associates this turn with the rest of the session.
   */
  readonly sessionId: string;
  /**
   * Pre-built SDK client. Defaults to `new BedrockAgentCoreClient({})`.
   * Tests pass an `aws-sdk-client-mock`-backed instance.
   */
  readonly client?: BedrockAgentCoreClient;
  /** Tool catalogue for inline_function execution during multi-turn conversation. */
  readonly toolCatalogue: ToolCatalogue;
  /** Max multi-turn round-trips. Default: 20. */
  readonly maxTurns?: number;
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

/**
 * Implements the `LoopGates.runEditor` contract from
 * `@agent-harness/loop/src/run` by invoking the editor Managed Harness
 * via `bedrock-agentcore:InvokeHarness` with multi-turn tool execution.
 *
 * Hand the bound method directly to `LoopGates`:
 *
 *   const editorInvocation = new ManagedHarnessEditorInvocation({
 *     harnessArn: process.env.EDITOR_HARNESS_ARN!,
 *     sessionId: session.trigger.session.id,
 *     toolCatalogue: catalogue,
 *   });
 *
 *   const gates: LoopGates = {
 *     runEditor: (ctx) => editorInvocation.runEditor(ctx),
 *     // ...
 *   };
 */
export class ManagedHarnessEditorInvocation {
  private readonly executor: MultiTurnExecutor;

  public constructor(options: ManagedHarnessEditorInvocationOptions) {
    const client = options.client ?? new BedrockAgentCoreClient({});
    this.executor = new MultiTurnExecutor({
      client,
      harnessArn: options.harnessArn,
      sessionId: options.sessionId,
      toolCatalogue: options.toolCatalogue,
      maxTurns: options.maxTurns ?? 20,
    });
  }

  /**
   * Implements `LoopGates.runEditor`. Sends the supplied context to the
   * editor Managed Harness via a multi-turn conversation, and returns
   * the edits the agent produced via `module.writeFile`.
   */
  public async runEditor(context: LoopContext): Promise<EditorResult> {
    // Serialise the LoopContext as a single user message.
    // Strip `module.path` from the trigger sent to the model — tools already
    // resolve paths relative to the module root, and leaving the raw path in
    // the context causes the model to concatenate it (producing ENOENT).
    const sanitizedTrigger = {
      ...context.trigger,
      module: {
        ...context.trigger.module,
        path: "(all tool paths are already scoped to the module root — use relative paths like \"AGENTS.md\", not \"modules/fanout/AGENTS.md\")",
      },
    };

    const userMessage = JSON.stringify({
      trigger: sanitizedTrigger,
      history: context.history,
    });

    const initialMessages: Message[] = [
      {
        role: "user",
        content: [{ text: userMessage }],
      },
    ];

    // Execute the multi-turn loop via MultiTurnExecutor.
    // SDK throws (network, throttling, access-denied, validation) and
    // MaxTurnsExceededError propagate without being caught.
    const result = await this.executor.execute(initialMessages);

    // Extract edits from the full conversation history.
    const edits = this.extractEdits(result.messages);

    return { edits };
  }

  // -------------------------------------------------------------------------
  // Edit extraction from conversation messages
  // -------------------------------------------------------------------------

  /**
   * Walk all messages in the completed conversation to extract
   * `module.writeFile` tool calls and compute diffs.
   *
   * For each assistant message with tool-use blocks:
   *   - `module.readFile` calls: remember the path for later pairing
   *     with its tool-result.
   *   - `module.writeFile` calls: record the path and contents for
   *     diff computation.
   *
   * For each user message with tool-result blocks:
   *   - Match results to prior `module.readFile` calls and extract
   *     the "before" contents.
   *
   * Then compute diffs for each writeFile call using before-contents
   * from readFile results (or empty string if never read).
   */
  private extractEdits(
    messages: Message[],
  ): ReadonlyArray<{ readonly path: string; readonly diff: string }> {
    /**
     * path -> "before" contents observed so far. Populated by
     * `module.readFile` tool results; default is `""` for paths the
     * agent never read before writing.
     */
    const beforeContents = new Map<string, string>();

    /** Accumulated edits in order of writeFile calls. */
    const edits: Array<{ path: string; diff: string }> = [];

    /**
     * Track tool-use blocks by toolUseId so we can pair them with
     * their results in subsequent user messages.
     */
    const pendingToolUses = new Map<
      string,
      { toolName: string; input: unknown }
    >();

    for (const message of messages) {
      if (message.content === undefined) continue;

      for (const block of message.content as ContentBlock[]) {
        // Handle tool-use blocks from assistant messages
        if (hasToolUse(block)) {
          const toolUse = getToolUse(block);
          if (toolUse === null) continue;

          pendingToolUses.set(toolUse.toolUseId, {
            toolName: toolUse.name,
            input: toolUse.input,
          });

          // For writeFile, immediately record the edit (we have the
          // input with path and contents already)
          if (toolUse.name === "module.writeFile") {
            const input = toolUse.input as { path?: string; contents?: string };
            if (
              typeof input.path === "string" &&
              input.path.length > 0 &&
              typeof input.contents === "string"
            ) {
              const before = beforeContents.get(input.path) ?? "";
              const after = input.contents;
              // Update beforeContents so a subsequent writeFile for the
              // same path diffs against the most recent state.
              beforeContents.set(input.path, after);
              edits.push({
                path: input.path,
                diff: computeUnifiedDiff(input.path, before, after),
              });
            }
          }
          continue;
        }

        // Handle tool-result blocks from user messages
        if (hasToolResult(block)) {
          const toolResult = getToolResult(block);
          if (toolResult === null) continue;

          const toolUse = pendingToolUses.get(toolResult.toolUseId);
          if (toolUse === undefined) continue;

          // For readFile results, extract "before" contents
          if (
            toolUse.toolName === "module.readFile" &&
            toolResult.status === "success"
          ) {
            const readInput = toolUse.input as { path?: string };
            if (typeof readInput.path === "string" && readInput.path.length > 0) {
              const contents = extractReadFileContents(toolResult.content);
              if (contents !== null) {
                beforeContents.set(readInput.path, contents);
              }
            }
          }
          continue;
        }
      }
    }

    return edits;
  }
}

// ---------------------------------------------------------------------------
// Content block helpers
// ---------------------------------------------------------------------------

/**
 * Type-guard: does this content block have a toolUse member?
 */
function hasToolUse(block: ContentBlock): boolean {
  return (block as { toolUse?: unknown }).toolUse !== undefined;
}

/**
 * Extract tool-use data from a content block.
 */
function getToolUse(
  block: ContentBlock,
): { toolUseId: string; name: string; input: unknown } | null {
  const tu = (block as { toolUse?: { toolUseId?: string; name?: string; input?: unknown } })
    .toolUse;
  if (tu === undefined) return null;
  if (typeof tu.toolUseId !== "string" || typeof tu.name !== "string") return null;
  return { toolUseId: tu.toolUseId, name: tu.name, input: tu.input };
}

/**
 * Type-guard: does this content block have a toolResult member?
 */
function hasToolResult(block: ContentBlock): boolean {
  return (block as { toolResult?: unknown }).toolResult !== undefined;
}

/**
 * Extract tool-result data from a content block.
 */
function getToolResult(
  block: ContentBlock,
): { toolUseId: string; status: string; content?: unknown[] } | null {
  const tr = (
    block as {
      toolResult?: { toolUseId?: string; status?: string; content?: unknown[] };
    }
  ).toolResult;
  if (tr === undefined) return null;
  if (typeof tr.toolUseId !== "string") return null;
  return {
    toolUseId: tr.toolUseId,
    status: tr.status ?? "error",
    content: tr.content,
  };
}

/**
 * Extract file contents from a readFile tool-result's content array.
 * The tool returns JSON like `{ contents: "...", sha: "..." }`.
 */
function extractReadFileContents(content: unknown[] | undefined): string | null {
  if (!Array.isArray(content) || content.length === 0) return null;

  for (const item of content) {
    // Try JSON format: { json: { contents: "..." } }
    const jsonItem = item as { json?: { contents?: string } };
    if (jsonItem.json !== undefined && typeof jsonItem.json.contents === "string") {
      return jsonItem.json.contents;
    }

    // Try text format: might be JSON-serialized
    const textItem = item as { text?: string };
    if (typeof textItem.text === "string") {
      try {
        const parsed = JSON.parse(textItem.text) as { contents?: string };
        if (typeof parsed.contents === "string") {
          return parsed.contents;
        }
      } catch {
        // Not JSON text; skip
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Diff helper
// ---------------------------------------------------------------------------

/**
 * Build a minimal unified-diff-style string from `before` and `after`.
 *
 * The orchestrator may not have a working git tree in all contexts,
 * so we cannot always delegate to `git diff`. The output here is a textual
 * representation suitable for the session record, the partial-PR body,
 * and the reviewer harness's `diff` input — all of which want a human-
 * readable diff string, not a parseable patch.
 */
function computeUnifiedDiff(
  path: string,
  before: string,
  after: string,
): string {
  if (before === after) {
    return `--- ${path}\n+++ ${path}\n`;
  }

  const beforeLines = before === "" ? [] : before.split("\n");
  const afterLines = after === "" ? [] : after.split("\n");

  const lines: string[] = [];
  lines.push(`--- ${path}`);
  lines.push(`+++ ${path}`);
  lines.push(
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
  );
  for (const line of beforeLines) {
    lines.push(`-${line}`);
  }
  for (const line of afterLines) {
    lines.push(`+${line}`);
  }
  return lines.join("\n");
}
