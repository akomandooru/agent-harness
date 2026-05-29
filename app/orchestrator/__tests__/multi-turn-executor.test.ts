/**
 * Unit tests for MultiTurnExecutor.
 *
 * Uses aws-sdk-client-mock to stub BedrockAgentCoreClient. Tests cover:
 *   - Single-turn terminal stop (end_turn) returns immediately
 *   - Multi-turn loop with tool_use → tool execution → re-invoke
 *   - MaxTurnsExceededError when max turns exceeded
 *   - Filtering: only "tool_use" blocks are executed, server_tool_use and mcp_tool_use are skipped
 *   - Full conversation history accumulation across turns
 *   - Stream without messageStop throws
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 10.1, 10.2, 10.3
 */

import { mockClient } from "aws-sdk-client-mock";
import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
} from "@aws-sdk/client-bedrock-agentcore";

import {
  MultiTurnExecutor,
  MaxTurnsExceededError,
  type Message,
  type MultiTurnExecutorOptions,
} from "../multi-turn-executor";
import { MapToolCatalogue } from "../tool-executor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStream(events: Record<string, unknown>[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < events.length) {
            return { value: events[index++]!, done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

/**
 * Build stream events for a turn that ends with a given stopReason.
 * Optionally includes tool-use blocks.
 */
function makeTurnStream(opts: {
  stopReason: string;
  textContent?: string;
  toolUses?: Array<{
    toolUseId: string;
    name: string;
    input: unknown;
    type?: "tool_use" | "server_tool_use" | "mcp_tool_use";
  }>;
}): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  let blockIndex = 0;

  // Add text content if provided
  if (opts.textContent) {
    events.push({
      contentBlockStart: {
        contentBlockIndex: blockIndex,
        start: {},
      },
    });
    events.push({
      contentBlockDelta: {
        contentBlockIndex: blockIndex,
        delta: { text: opts.textContent },
      },
    });
    events.push({
      contentBlockStop: { contentBlockIndex: blockIndex },
    });
    blockIndex++;
  }

  // Add tool-use blocks
  if (opts.toolUses) {
    for (const tu of opts.toolUses) {
      events.push({
        contentBlockStart: {
          contentBlockIndex: blockIndex,
          start: {
            toolUse: {
              toolUseId: tu.toolUseId,
              name: tu.name,
              type: tu.type ?? "tool_use",
            },
          },
        },
      });
      events.push({
        contentBlockDelta: {
          contentBlockIndex: blockIndex,
          delta: {
            toolUse: { input: JSON.stringify(tu.input) },
          },
        },
      });
      events.push({
        contentBlockStop: { contentBlockIndex: blockIndex },
      });
      blockIndex++;
    }
  }

  // messageStop
  events.push({ messageStop: { stopReason: opts.stopReason } });

  return events;
}

function makeOptions(
  client: BedrockAgentCoreClient,
  catalogue: MapToolCatalogue,
  maxTurns = 10,
): MultiTurnExecutorOptions {
  return {
    client,
    harnessArn: "arn:aws:bedrock:us-east-1:123456789012:harness/test",
    sessionId: "test-session-1",
    toolCatalogue: catalogue,
    maxTurns,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MultiTurnExecutor", () => {
  let clientMock: ReturnType<typeof mockClient>;

  beforeEach(() => {
    clientMock = mockClient(BedrockAgentCoreClient);
  });

  afterEach(() => {
    clientMock.restore();
  });

  it("returns immediately on end_turn stopReason (single turn)", async () => {
    const stream = makeStream(
      makeTurnStream({ stopReason: "end_turn", textContent: "Done!" }),
    );
    clientMock.on(InvokeHarnessCommand).resolves({ stream: stream as never });

    const catalogue = new MapToolCatalogue();
    const client = new BedrockAgentCoreClient({});
    const executor = new MultiTurnExecutor(makeOptions(client, catalogue));

    const initialMessages: Message[] = [
      { role: "user", content: [{ text: "Hello" }] },
    ];

    const result = await executor.execute(initialMessages);

    expect(result.stopReason).toBe("end_turn");
    // messages: initial user message + assistant response
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.role).toBe("user");
    expect(result.messages[1]!.role).toBe("assistant");
    expect(result.finalContent).toHaveLength(1);
  });

  it("returns on max_tokens stopReason (terminal)", async () => {
    const stream = makeStream(
      makeTurnStream({ stopReason: "max_tokens", textContent: "Truncated" }),
    );
    clientMock.on(InvokeHarnessCommand).resolves({ stream: stream as never });

    const catalogue = new MapToolCatalogue();
    const client = new BedrockAgentCoreClient({});
    const executor = new MultiTurnExecutor(makeOptions(client, catalogue));

    const result = await executor.execute([
      { role: "user", content: [{ text: "Hello" }] },
    ]);

    expect(result.stopReason).toBe("max_tokens");
    expect(result.messages).toHaveLength(2);
  });

  it("executes tool_use blocks and re-invokes until terminal", async () => {
    const catalogue = new MapToolCatalogue();
    catalogue.register("myTool", async (input) => ({ result: "ok", input }));

    // First call: stopReason "tool_use" with one tool block
    const turn1Stream = makeStream(
      makeTurnStream({
        stopReason: "tool_use",
        toolUses: [{ toolUseId: "tu-1", name: "myTool", input: { key: "val" } }],
      }),
    );

    // Second call: stopReason "end_turn" with text
    const turn2Stream = makeStream(
      makeTurnStream({ stopReason: "end_turn", textContent: "All done." }),
    );

    clientMock
      .on(InvokeHarnessCommand)
      .resolvesOnce({ stream: turn1Stream as never })
      .resolvesOnce({ stream: turn2Stream as never });

    const client = new BedrockAgentCoreClient({});
    const executor = new MultiTurnExecutor(makeOptions(client, catalogue));

    const result = await executor.execute([
      { role: "user", content: [{ text: "Do something" }] },
    ]);

    expect(result.stopReason).toBe("end_turn");
    // Messages: user + assistant(tool_use) + user(toolResult) + assistant(end_turn)
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]!.role).toBe("user");
    expect(result.messages[1]!.role).toBe("assistant");
    expect(result.messages[2]!.role).toBe("user");
    expect(result.messages[3]!.role).toBe("assistant");

    // The tool result message should contain toolResult block
    const toolResultMsg = result.messages[2]!;
    expect(toolResultMsg.content).toHaveLength(1);
    const toolResultBlock = toolResultMsg.content![0] as { toolResult: { toolUseId: string; status: string } };
    expect(toolResultBlock.toolResult.toolUseId).toBe("tu-1");
    expect(toolResultBlock.toolResult.status).toBe("success");

    // Verify InvokeHarness was called twice
    const calls = clientMock.commandCalls(InvokeHarnessCommand);
    expect(calls).toHaveLength(2);
  });

  it("throws MaxTurnsExceededError when maxTurns is exceeded", async () => {
    const catalogue = new MapToolCatalogue();
    catalogue.register("myTool", async () => "result");

    // Always respond with tool_use
    const makeToolStream = () =>
      makeStream(
        makeTurnStream({
          stopReason: "tool_use",
          toolUses: [{ toolUseId: `tu-${Math.random()}`, name: "myTool", input: {} }],
        }),
      );

    clientMock.on(InvokeHarnessCommand).resolves({ stream: makeToolStream() as never });

    const client = new BedrockAgentCoreClient({});
    const executor = new MultiTurnExecutor(makeOptions(client, catalogue, 2));

    await expect(
      executor.execute([{ role: "user", content: [{ text: "Go" }] }]),
    ).rejects.toThrow(MaxTurnsExceededError);

    await expect(
      executor.execute([{ role: "user", content: [{ text: "Go" }] }]),
    ).rejects.toThrow(/exceeded maximum turns/i);
  });

  it("skips server_tool_use and mcp_tool_use blocks, only executes tool_use", async () => {
    const executedTools: string[] = [];
    const catalogue = new MapToolCatalogue();
    catalogue.register("inlineTool", async () => {
      executedTools.push("inlineTool");
      return "inline-result";
    });

    // Turn 1: mix of tool types — only "tool_use" should be executed
    const turn1Stream = makeStream(
      makeTurnStream({
        stopReason: "tool_use",
        toolUses: [
          { toolUseId: "tu-inline", name: "inlineTool", type: "tool_use", input: {} },
          { toolUseId: "tu-server", name: "serverTool", type: "server_tool_use", input: {} },
          { toolUseId: "tu-mcp", name: "mcpTool", type: "mcp_tool_use", input: {} },
        ],
      }),
    );

    // Turn 2: terminal
    const turn2Stream = makeStream(
      makeTurnStream({ stopReason: "end_turn", textContent: "Done" }),
    );

    clientMock
      .on(InvokeHarnessCommand)
      .resolvesOnce({ stream: turn1Stream as never })
      .resolvesOnce({ stream: turn2Stream as never });

    const client = new BedrockAgentCoreClient({});
    const executor = new MultiTurnExecutor(makeOptions(client, catalogue));

    const result = await executor.execute([
      { role: "user", content: [{ text: "Do" }] },
    ]);

    expect(result.stopReason).toBe("end_turn");
    // Only the inline tool should have been executed
    expect(executedTools).toEqual(["inlineTool"]);

    // The toolResult user message should only contain result for the inline tool
    const toolResultMsg = result.messages[2]!;
    expect(toolResultMsg.content).toHaveLength(1);
    const block = toolResultMsg.content![0] as { toolResult: { toolUseId: string } };
    expect(block.toolResult.toolUseId).toBe("tu-inline");
  });

  it("throws when stream has no messageStop event", async () => {
    const stream = makeStream([
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: {},
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { text: "partial" },
        },
      },
      {
        contentBlockStop: { contentBlockIndex: 0 },
      },
      // No messageStop!
    ]);

    clientMock.on(InvokeHarnessCommand).resolves({ stream: stream as never });

    const catalogue = new MapToolCatalogue();
    const client = new BedrockAgentCoreClient({});
    const executor = new MultiTurnExecutor(makeOptions(client, catalogue));

    await expect(
      executor.execute([{ role: "user", content: [{ text: "Hi" }] }]),
    ).rejects.toThrow(/messageStop/);
  });

  it("throws when stream is undefined in response", async () => {
    clientMock.on(InvokeHarnessCommand).resolves({} as never);

    const catalogue = new MapToolCatalogue();
    const client = new BedrockAgentCoreClient({});
    const executor = new MultiTurnExecutor(makeOptions(client, catalogue));

    await expect(
      executor.execute([{ role: "user", content: [{ text: "Hi" }] }]),
    ).rejects.toThrow(/did not include a stream/);
  });

  it("accumulates full conversation history across multiple turns", async () => {
    const catalogue = new MapToolCatalogue();
    catalogue.register("tool1", async () => "r1");
    catalogue.register("tool2", async () => "r2");

    // Turn 1: tool_use
    const turn1 = makeStream(
      makeTurnStream({
        stopReason: "tool_use",
        toolUses: [{ toolUseId: "tu-a", name: "tool1", input: { x: 1 } }],
      }),
    );
    // Turn 2: tool_use
    const turn2 = makeStream(
      makeTurnStream({
        stopReason: "tool_use",
        toolUses: [{ toolUseId: "tu-b", name: "tool2", input: { y: 2 } }],
      }),
    );
    // Turn 3: end_turn
    const turn3 = makeStream(
      makeTurnStream({ stopReason: "end_turn", textContent: "Complete" }),
    );

    clientMock
      .on(InvokeHarnessCommand)
      .resolvesOnce({ stream: turn1 as never })
      .resolvesOnce({ stream: turn2 as never })
      .resolvesOnce({ stream: turn3 as never });

    const client = new BedrockAgentCoreClient({});
    const executor = new MultiTurnExecutor(makeOptions(client, catalogue));

    const result = await executor.execute([
      { role: "user", content: [{ text: "Start" }] },
    ]);

    // Expected messages:
    //   0: user (initial)
    //   1: assistant (tool_use turn 1)
    //   2: user (toolResult for turn 1)
    //   3: assistant (tool_use turn 2)
    //   4: user (toolResult for turn 2)
    //   5: assistant (end_turn)
    expect(result.messages).toHaveLength(6);
    expect(result.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);

    // InvokeHarness should have been called 3 times
    const calls = clientMock.commandCalls(InvokeHarnessCommand);
    expect(calls).toHaveLength(3);

    // Verify that messages were accumulated correctly in the result
    // (The mock captures references, so we verify via the final result instead)
    expect(result.stopReason).toBe("end_turn");
    expect(result.finalContent).toHaveLength(1);
  });

  it("handles tool execution errors gracefully (error toolResult, loop continues)", async () => {
    const catalogue = new MapToolCatalogue();
    catalogue.register("failingTool", async () => {
      throw new Error("Tool exploded");
    });

    // Turn 1: tool_use with failing tool
    const turn1 = makeStream(
      makeTurnStream({
        stopReason: "tool_use",
        toolUses: [{ toolUseId: "tu-fail", name: "failingTool", input: {} }],
      }),
    );
    // Turn 2: end_turn
    const turn2 = makeStream(
      makeTurnStream({ stopReason: "end_turn", textContent: "Recovered" }),
    );

    clientMock
      .on(InvokeHarnessCommand)
      .resolvesOnce({ stream: turn1 as never })
      .resolvesOnce({ stream: turn2 as never });

    const client = new BedrockAgentCoreClient({});
    const executor = new MultiTurnExecutor(makeOptions(client, catalogue));

    const result = await executor.execute([
      { role: "user", content: [{ text: "Go" }] },
    ]);

    expect(result.stopReason).toBe("end_turn");

    // The toolResult should have error status
    const toolResultMsg = result.messages[2]!;
    const block = toolResultMsg.content![0] as {
      toolResult: { toolUseId: string; status: string; content: Array<{ text: string }> };
    };
    expect(block.toolResult.status).toBe("error");
    expect(block.toolResult.content[0]!.text).toBe("Tool exploded");
  });
});
