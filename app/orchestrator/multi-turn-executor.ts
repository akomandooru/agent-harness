/**
 * MultiTurnExecutor — shared engine for multi-turn InvokeHarness loops.
 *
 * Both ManagedHarnessEditorInvocation and ManagedHarnessReviewerInvocation
 * use this engine to drive the multi-turn tool execution cycle:
 *
 *   1. Invoke InvokeHarness with the current messages array.
 *   2. Walk the stream to collect assistant content blocks and stopReason.
 *   3. If stopReason is "tool_use":
 *      a. Extract tool-use blocks (only type "tool_use"; skip server_tool_use / mcp_tool_use).
 *      b. Execute them via ToolExecutor.
 *      c. Append assistant message + user message (with toolResult blocks) to history.
 *      d. Re-invoke InvokeHarness with the full accumulated messages.
 *   4. If stopReason is terminal (end_turn, max_tokens, timeout_exceeded, etc.):
 *      return the accumulated conversation.
 *   5. If maxTurns is exceeded, throw MaxTurnsExceededError.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 10.1, 10.2, 10.3
 */

import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
  type InvokeHarnessStreamOutput,
  type HarnessMessage,
  type HarnessContentBlock,
  type HarnessContentBlockStartEvent,
  type HarnessContentBlockDeltaEvent,
} from "@aws-sdk/client-bedrock-agentcore";

import { ToolExecutor, type ToolCatalogue, type ToolUseBlock, type ToolResultBlock } from "./tool-executor";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A message in the InvokeHarness conversation. Wraps the SDK HarnessMessage.
 */
export type Message = HarnessMessage;

/**
 * A content block in a message. Wraps the SDK HarnessContentBlock.
 */
export type ContentBlock = HarnessContentBlock;

/**
 * A tool-use block extracted from the stream with its type discriminator.
 */
export interface ExtractedToolUse {
  readonly toolUseId: string;
  readonly name: string;
  readonly input: unknown;
  readonly type: "tool_use" | "server_tool_use" | "mcp_tool_use";
}

/**
 * Options for constructing a MultiTurnExecutor.
 */
export interface MultiTurnExecutorOptions {
  /** SDK client for InvokeHarness calls. */
  readonly client: BedrockAgentCoreClient;
  /** Harness ARN to invoke. */
  readonly harnessArn: string;
  /** Runtime session ID. */
  readonly sessionId: string;
  /** Registered tool catalogue for inline_function execution. */
  readonly toolCatalogue: ToolCatalogue;
  /** Maximum number of multi-turn round-trips before aborting. */
  readonly maxTurns: number;
}

/**
 * The result of a completed multi-turn execution.
 */
export interface MultiTurnResult {
  /** All messages exchanged across all turns (full conversation). */
  readonly messages: Message[];
  /** The final stop reason that terminated the loop. */
  readonly stopReason: string;
  /** The final assistant message content blocks. */
  readonly finalContent: ContentBlock[];
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Thrown when the multi-turn loop exceeds the configured maxTurns.
 */
export class MaxTurnsExceededError extends Error {
  public readonly turnCount: number;
  public readonly lastStopReason: string;

  constructor(turnCount: number, lastStopReason: string) {
    super(
      `Multi-turn loop exceeded maximum turns (${turnCount}). Last stop reason: "${lastStopReason}"`,
    );
    this.name = "MaxTurnsExceededError";
    this.turnCount = turnCount;
    this.lastStopReason = lastStopReason;
  }
}

// ---------------------------------------------------------------------------
// Stream parse result
// ---------------------------------------------------------------------------

interface StreamParseResult {
  readonly contentBlocks: ContentBlock[];
  readonly extractedToolUses: ExtractedToolUse[];
  readonly stopReason: string;
}

// ---------------------------------------------------------------------------
// MultiTurnExecutor
// ---------------------------------------------------------------------------

/**
 * Drives the multi-turn InvokeHarness loop. Shared between editor and
 * reviewer harness invocations to avoid duplication.
 */
export class MultiTurnExecutor {
  private readonly client: BedrockAgentCoreClient;
  private readonly harnessArn: string;
  private readonly sessionId: string;
  private readonly toolExecutor: ToolExecutor;
  private readonly maxTurns: number;

  constructor(options: MultiTurnExecutorOptions) {
    this.client = options.client;
    this.harnessArn = options.harnessArn;
    this.sessionId = options.sessionId;
    this.toolExecutor = new ToolExecutor(options.toolCatalogue);
    this.maxTurns = options.maxTurns;
  }

  /**
   * Execute the multi-turn loop starting with the given initial messages.
   *
   * @param initialMessages - The initial messages array (typically contains the user prompt).
   * @returns MultiTurnResult with full conversation history, final stop reason, and final content.
   */
  async execute(initialMessages: Message[]): Promise<MultiTurnResult> {
    const messages: Message[] = [...initialMessages];
    let turnCount = 0;

    while (true) {
      turnCount++;

      // Check max turns BEFORE invoking (so we never exceed the limit)
      if (turnCount > this.maxTurns) {
        throw new MaxTurnsExceededError(turnCount - 1, "tool_use");
      }

      // Invoke InvokeHarness with current message history
      const command = new InvokeHarnessCommand({
        harnessArn: this.harnessArn,
        runtimeSessionId: this.sessionId,
        messages: messages as HarnessMessage[],
      });

      const response = await this.client.send(command);

      if (response.stream === undefined) {
        throw new Error(
          "MultiTurnExecutor: InvokeHarness response did not include a stream.",
        );
      }

      // Walk the stream to collect content blocks and stop reason
      const parseResult = await this.walkStream(response.stream);

      // If stopReason is not "tool_use", we're done (terminal)
      if (parseResult.stopReason !== "tool_use") {
        // Append the final assistant message to history
        const assistantMessage: Message = {
          role: "assistant",
          content: parseResult.contentBlocks,
        };
        messages.push(assistantMessage);

        return {
          messages,
          stopReason: parseResult.stopReason,
          finalContent: parseResult.contentBlocks,
        };
      }

      // stopReason is "tool_use" — execute inline_function tools and continue

      // Append assistant message (with tool-use blocks) to history
      const assistantMessage: Message = {
        role: "assistant",
        content: parseResult.contentBlocks,
      };
      messages.push(assistantMessage);

      // Filter to only "tool_use" type blocks (skip server_tool_use, mcp_tool_use)
      const inlineToolUses = parseResult.extractedToolUses.filter(
        (t) => t.type === "tool_use",
      );

      // Execute the inline tools via ToolExecutor
      const toolUseBlocks: ToolUseBlock[] = inlineToolUses.map((t) => ({
        toolUseId: t.toolUseId,
        name: t.name,
        input: t.input,
      }));

      const toolResults: ToolResultBlock[] = await this.toolExecutor.executeAll(toolUseBlocks);

      // Build user message with toolResult content blocks
      const toolResultContentBlocks: ContentBlock[] = toolResults.map((result) => ({
        toolResult: {
          toolUseId: result.toolUseId,
          status: result.status,
          content: [{ text: result.content }],
        },
      }));

      const userMessage: Message = {
        role: "user",
        content: toolResultContentBlocks,
      };
      messages.push(userMessage);
    }
  }

  // -------------------------------------------------------------------------
  // Stream walker
  // -------------------------------------------------------------------------

  /**
   * Walk the InvokeHarness streaming response and collect:
   * - All content blocks from the assistant message
   * - Extracted tool-use blocks with their type discriminators
   * - The stopReason from the messageStop event
   */
  private async walkStream(
    stream: AsyncIterable<InvokeHarnessStreamOutput>,
  ): Promise<StreamParseResult> {
    const contentBlocks: ContentBlock[] = [];
    const extractedToolUses: ExtractedToolUse[] = [];
    let stopReason = "";

    // Track in-flight blocks by their contentBlockIndex
    interface ActiveToolUseBlock {
      readonly kind: "tool-use";
      readonly toolUseId: string;
      readonly toolName: string;
      readonly type: "tool_use" | "server_tool_use" | "mcp_tool_use";
      inputFragments: string[];
    }
    interface ActiveTextBlock {
      readonly kind: "text";
      textFragments: string[];
    }
    type ActiveBlock = ActiveToolUseBlock | ActiveTextBlock;

    const activeBlocks = new Map<number, ActiveBlock>();

    for await (const event of stream) {
      // Surface server-side errors as throws
      if (event.internalServerException !== undefined) {
        throw new Error(
          `MultiTurnExecutor: InternalServerException: ${event.internalServerException.message ?? "(no message)"}`,
        );
      }
      if (event.validationException !== undefined) {
        throw new Error(
          `MultiTurnExecutor: ValidationException: ${event.validationException.message} (reason=${event.validationException.reason})`,
        );
      }
      if (event.runtimeClientError !== undefined) {
        throw new Error(
          `MultiTurnExecutor: RuntimeClientError: ${event.runtimeClientError.message ?? "(no message)"}`,
        );
      }

      if (event.contentBlockStart !== undefined) {
        const startEvent = event.contentBlockStart as HarnessContentBlockStartEvent;
        const idx = startEvent.contentBlockIndex;
        if (idx === undefined) continue;
        const start = startEvent.start;
        if (start === undefined) continue;

        if (start.toolUse !== undefined) {
          const { toolUseId, name, type } = start.toolUse;
          if (toolUseId === undefined || name === undefined) continue;
          // Resolve the type: default to "tool_use" if not specified
          const resolvedType = type ?? "tool_use";
          activeBlocks.set(idx, {
            kind: "tool-use",
            toolUseId,
            toolName: name,
            type: resolvedType as "tool_use" | "server_tool_use" | "mcp_tool_use",
            inputFragments: [],
          });
        } else {
          // Text block (or other non-tool block)
          activeBlocks.set(idx, {
            kind: "text",
            textFragments: [],
          });
        }
        continue;
      }

      if (event.contentBlockDelta !== undefined) {
        const deltaEvent = event.contentBlockDelta as HarnessContentBlockDeltaEvent;
        const idx = deltaEvent.contentBlockIndex;
        if (idx === undefined) continue;
        const block = activeBlocks.get(idx);
        if (block === undefined) continue;
        const delta = deltaEvent.delta;
        if (delta === undefined) continue;

        if (block.kind === "tool-use") {
          if (delta.toolUse !== undefined && delta.toolUse.input !== undefined) {
            block.inputFragments.push(delta.toolUse.input);
          }
        } else if (block.kind === "text") {
          if (delta.text !== undefined) {
            block.textFragments.push(delta.text);
          }
        }
        continue;
      }

      if (event.contentBlockStop !== undefined) {
        const idx = event.contentBlockStop.contentBlockIndex;
        if (idx === undefined) continue;
        const block = activeBlocks.get(idx);
        if (block === undefined) continue;
        activeBlocks.delete(idx);

        if (block.kind === "tool-use") {
          // Parse the accumulated input.
          // Bedrock requires toolUse.input to be a JSON OBJECT (not a
          // primitive, array, null, or string). We must coerce any
          // non-object value to {} or Bedrock rejects the next turn
          // with "messages.N.content.M.toolUse.input is invalid".
          const inputJson = block.inputFragments.join("");
          let parsedInput: Record<string, unknown> = {};
          if (inputJson.trim() !== "") {
            try {
              const parsed: unknown = JSON.parse(inputJson);
              if (
                parsed !== null &&
                typeof parsed === "object" &&
                !Array.isArray(parsed)
              ) {
                parsedInput = parsed as Record<string, unknown>;
              }
              // Else: leave parsedInput as {}; primitives, arrays, and
              // null are not valid JSON objects per Bedrock's contract.
            } catch {
              // Malformed JSON: fall back to {}.
            }
          }

          // Add to content blocks as a ToolUseMember.
          // We do NOT include `type` in the outgoing block — that's our
          // internal discriminator for filtering inline vs server vs MCP
          // tools, not part of Bedrock's wire schema.
          contentBlocks.push({
            toolUse: {
              toolUseId: block.toolUseId,
              name: block.toolName,
              input: parsedInput,
            },
          } as ContentBlock);

          // Track for tool execution
          extractedToolUses.push({
            toolUseId: block.toolUseId,
            name: block.toolName,
            input: parsedInput,
            type: block.type,
          });
        } else {
          // Text block
          const text = block.textFragments.join("");
          if (text.length > 0) {
            contentBlocks.push({ text } as ContentBlock);
          }
        }
        continue;
      }

      if (event.messageStop !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stopReason = (event.messageStop as any).stopReason ?? "end_turn";
        continue;
      }
    }

    if (stopReason === "") {
      throw new Error(
        "MultiTurnExecutor: stream ended without a messageStop event.",
      );
    }

    return { contentBlocks, extractedToolUses, stopReason };
  }
}
