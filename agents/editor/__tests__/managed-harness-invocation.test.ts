/**
 * Unit tests for `ManagedHarnessEditorInvocation`.
 *
 * Uses `aws-sdk-client-mock` to stub `BedrockAgentCoreClient` so no real
 * AWS traffic is required. Tests verify multi-turn tool execution via
 * MultiTurnExecutor:
 *
 *   1. Multi-turn with two `module.writeFile` calls → `EditorResult.edits`
 *      has two entries with correct `{path, diff}`.
 *   2. Single turn with no tool-use → `EditorResult.edits` is empty.
 *   3. SDK throws → error propagated, not swallowed.
 *   4. Stream ends before a `messageStop` event → throws (malformed stream).
 *   5. Multi-turn with readFile then writeFile → diff uses before-contents.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 10.1, 10.2, 10.3
 */

import { mockClient } from "aws-sdk-client-mock";
import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
} from "@aws-sdk/client-bedrock-agentcore";

import { ManagedHarnessEditorInvocation } from "../managed-harness-invocation";
import type { LoopContext } from "@agent-harness/loop/src/run";
import { MapToolCatalogue } from "../../../app/orchestrator/tool-executor";

// ---------------------------------------------------------------------------
// Helpers: build canned stream events
// ---------------------------------------------------------------------------

/**
 * Build an async iterable from an array of stream events.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeStream(events: Record<string, unknown>[]): any {
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
 * Build stream events for a single tool-use block (assistant requesting a tool).
 */
function toolUseEvents(opts: {
  toolUseId: string;
  blockIndex: number;
  name: string;
  input: unknown;
}): Record<string, unknown>[] {
  const inputStr = JSON.stringify(opts.input);
  return [
    {
      contentBlockStart: {
        contentBlockIndex: opts.blockIndex,
        start: {
          toolUse: {
            toolUseId: opts.toolUseId,
            name: opts.name,
          },
        },
      },
    },
    {
      contentBlockDelta: {
        contentBlockIndex: opts.blockIndex,
        delta: {
          toolUse: { input: inputStr },
        },
      },
    },
    {
      contentBlockStop: {
        contentBlockIndex: opts.blockIndex,
      },
    },
  ];
}

/** A `messageStop` event with stopReason "tool_use" (multi-turn continues). */
const toolUseStopEvent: Record<string, unknown> = {
  messageStop: { stopReason: "tool_use" },
};

/** A `messageStop` event with stopReason "end_turn" (terminal). */
const endTurnStopEvent: Record<string, unknown> = {
  messageStop: { stopReason: "end_turn" },
};

/**
 * Build a stream that represents the assistant requesting tool calls
 * (stopReason: "tool_use").
 */
function buildToolUseStream(
  toolCalls: Array<{ toolUseId: string; name: string; input: unknown }>,
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  toolCalls.forEach((call, idx) => {
    events.push(
      ...toolUseEvents({
        toolUseId: call.toolUseId,
        blockIndex: idx,
        name: call.name,
        input: call.input,
      }),
    );
  });
  events.push(toolUseStopEvent);
  return events;
}

/**
 * Build a terminal stream with just a text block and end_turn.
 */
function buildTerminalStream(text?: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  if (text) {
    events.push(
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: {},
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { text },
        },
      },
      {
        contentBlockStop: { contentBlockIndex: 0 },
      },
    );
  }
  events.push(endTurnStopEvent);
  return events;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const HARNESS_ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/editor-agent/abc";
const SESSION_ID = "session-test-001";

/** Minimal LoopContext for tests. */
const CONTEXT: LoopContext = {
  trigger: {
    issueNumber: 1,
    issueTitle: "test",
    issueBody: "body",
    modulePath: "modules/fanout",
    session: { id: SESSION_ID },
  } as unknown as LoopContext["trigger"],
  history: [],
};

/**
 * Create a tool catalogue with module.writeFile and module.readFile handlers
 * that simulate real behavior (write returns success, read returns file contents).
 */
function createTestToolCatalogue(
  fileSystem?: Map<string, string>,
): MapToolCatalogue {
  const fs = fileSystem ?? new Map<string, string>();
  const catalogue = new MapToolCatalogue();

  catalogue.register("module.writeFile", async (input: unknown) => {
    const { path, contents } = input as { path: string; contents: string };
    fs.set(path, contents);
    return { written: true };
  });

  catalogue.register("module.readFile", async (input: unknown) => {
    const { path } = input as { path: string };
    const contents = fs.get(path) ?? "";
    return { contents, sha: "abc123" };
  });

  return catalogue;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ManagedHarnessEditorInvocation", () => {
  const clientMock = mockClient(BedrockAgentCoreClient);

  beforeEach(() => {
    clientMock.reset();
  });

  afterAll(() => {
    clientMock.restore();
  });

  // -------------------------------------------------------------------------
  // Test 1: two module.writeFile calls in multi-turn → two edits
  // -------------------------------------------------------------------------

  it("returns two edits when the agent makes two module.writeFile calls across multi-turn", async () => {
    // Turn 1: assistant requests two writeFile tool calls
    const turn1Stream = buildToolUseStream([
      {
        toolUseId: "tu-001",
        name: "module.writeFile",
        input: { path: "lib/alpha.ts", contents: "export const alpha = 1;\n" },
      },
      {
        toolUseId: "tu-002",
        name: "module.writeFile",
        input: { path: "lib/beta.ts", contents: "export const beta = 2;\n" },
      },
    ]);

    // Turn 2: after receiving tool results, assistant ends the turn
    const turn2Stream = buildTerminalStream("Done editing files.");

    clientMock
      .on(InvokeHarnessCommand)
      .resolvesOnce({ stream: makeStream(turn1Stream) })
      .resolvesOnce({ stream: makeStream(turn2Stream) });

    const invocation = new ManagedHarnessEditorInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client: new BedrockAgentCoreClient({}),
      toolCatalogue: createTestToolCatalogue(),
    });

    const result = await invocation.runEditor(CONTEXT);

    expect(result.edits).toHaveLength(2);

    const alpha = result.edits[0]!;
    expect(alpha.path).toBe("lib/alpha.ts");
    expect(alpha.diff).toContain("+++ lib/alpha.ts");
    expect(alpha.diff).toContain("+export const alpha = 1;");

    const beta = result.edits[1]!;
    expect(beta.path).toBe("lib/beta.ts");
    expect(beta.diff).toContain("+++ lib/beta.ts");
    expect(beta.diff).toContain("+export const beta = 2;");
  });

  // -------------------------------------------------------------------------
  // Test 2: no tool-use → empty edits
  // -------------------------------------------------------------------------

  it("returns empty edits when the agent produces no tool calls", async () => {
    const stream = buildTerminalStream("No changes needed.");

    clientMock.on(InvokeHarnessCommand).resolves({
      stream: makeStream(stream),
    });

    const invocation = new ManagedHarnessEditorInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client: new BedrockAgentCoreClient({}),
      toolCatalogue: createTestToolCatalogue(),
    });

    const result = await invocation.runEditor(CONTEXT);

    expect(result.edits).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 3: SDK throws → error propagated, not swallowed
  // -------------------------------------------------------------------------

  it("propagates SDK errors rather than swallowing them", async () => {
    const sdkError = new Error("ThrottlingException: Rate exceeded");
    sdkError.name = "ThrottlingException";

    clientMock.on(InvokeHarnessCommand).rejects(sdkError);

    const invocation = new ManagedHarnessEditorInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client: new BedrockAgentCoreClient({}),
      toolCatalogue: createTestToolCatalogue(),
    });

    await expect(invocation.runEditor(CONTEXT)).rejects.toThrow(
      "ThrottlingException",
    );
  });

  // -------------------------------------------------------------------------
  // Test 4: stream ends without messageStop → throws
  // -------------------------------------------------------------------------

  it("throws when the stream ends without a messageStop event", async () => {
    // Stream with a tool-use block but no messageStop — truncated/malformed.
    const events = [
      ...toolUseEvents({
        toolUseId: "tu-003",
        blockIndex: 0,
        name: "module.writeFile",
        input: { path: "lib/gamma.ts", contents: "export const gamma = 3;\n" },
      }),
      // Deliberately omit messageStop
    ];

    clientMock.on(InvokeHarnessCommand).resolves({
      stream: makeStream(events),
    });

    const invocation = new ManagedHarnessEditorInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client: new BedrockAgentCoreClient({}),
      toolCatalogue: createTestToolCatalogue(),
    });

    await expect(invocation.runEditor(CONTEXT)).rejects.toThrow(
      /messageStop/,
    );
  });

  // -------------------------------------------------------------------------
  // Test 5: readFile before writeFile → diff uses before-contents
  // -------------------------------------------------------------------------

  it("computes diff against readFile before-contents when the agent reads before writing", async () => {
    const beforeContents = "export const x = 0;\n";
    const afterContents = "export const x = 42;\n";

    // Pre-populate the filesystem with the existing file
    const fs = new Map<string, string>();
    fs.set("lib/x.ts", beforeContents);

    // Turn 1: agent reads the file
    const turn1Stream = buildToolUseStream([
      {
        toolUseId: "tu-read-001",
        name: "module.readFile",
        input: { path: "lib/x.ts" },
      },
    ]);

    // Turn 2: agent writes the file (after receiving readFile result)
    const turn2Stream = buildToolUseStream([
      {
        toolUseId: "tu-write-001",
        name: "module.writeFile",
        input: { path: "lib/x.ts", contents: afterContents },
      },
    ]);

    // Turn 3: terminal
    const turn3Stream = buildTerminalStream("Updated lib/x.ts.");

    clientMock
      .on(InvokeHarnessCommand)
      .resolvesOnce({ stream: makeStream(turn1Stream) })
      .resolvesOnce({ stream: makeStream(turn2Stream) })
      .resolvesOnce({ stream: makeStream(turn3Stream) });

    const invocation = new ManagedHarnessEditorInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client: new BedrockAgentCoreClient({}),
      toolCatalogue: createTestToolCatalogue(fs),
    });

    const result = await invocation.runEditor(CONTEXT);

    expect(result.edits).toHaveLength(1);
    const edit = result.edits[0]!;
    expect(edit.path).toBe("lib/x.ts");
    expect(edit.diff).toContain("-export const x = 0;");
    expect(edit.diff).toContain("+export const x = 42;");
  });

  // -------------------------------------------------------------------------
  // Test 6: in-band error events are thrown
  // -------------------------------------------------------------------------

  it("throws when the stream contains an internalServerException event", async () => {
    const events: Record<string, unknown>[] = [
      {
        internalServerException: { message: "Internal server error from harness" },
      },
    ];

    clientMock.on(InvokeHarnessCommand).resolves({
      stream: makeStream(events),
    });

    const invocation = new ManagedHarnessEditorInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client: new BedrockAgentCoreClient({}),
      toolCatalogue: createTestToolCatalogue(),
    });

    await expect(invocation.runEditor(CONTEXT)).rejects.toThrow(
      /InternalServerException/,
    );
  });

  // -------------------------------------------------------------------------
  // Test 7: MaxTurnsExceededError when agent keeps requesting tools
  // -------------------------------------------------------------------------

  it("throws MaxTurnsExceededError when maxTurns is exceeded", async () => {
    // Always respond with tool_use to exhaust the turn limit
    const toolStream = buildToolUseStream([
      {
        toolUseId: "tu-loop",
        name: "module.writeFile",
        input: { path: "lib/loop.ts", contents: "loop" },
      },
    ]);

    clientMock.on(InvokeHarnessCommand).resolves({
      stream: makeStream(toolStream),
    });

    const invocation = new ManagedHarnessEditorInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client: new BedrockAgentCoreClient({}),
      toolCatalogue: createTestToolCatalogue(),
      maxTurns: 3,
    });

    await expect(invocation.runEditor(CONTEXT)).rejects.toThrow(
      /maximum turns/,
    );
  });
});
