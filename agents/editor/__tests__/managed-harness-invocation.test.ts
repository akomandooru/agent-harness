/**
 * Unit tests for `ManagedHarnessEditorInvocation`.
 *
 * Uses `aws-sdk-client-mock` to stub `BedrockAgentCoreClient` so no real
 * AWS traffic is required. The tests cover the four scenarios from task 4.2:
 *
 *   1. Canned stream with two `module.writeFile` results → `EditorResult.edits`
 *      has two entries with correct `{path, diff}`.
 *   2. Canned stream with no `module.writeFile` results but a `final` event
 *      (messageStop) → `EditorResult.edits` is empty (legitimate outcome).
 *   3. SDK throws → error propagated, not swallowed.
 *   4. Stream ends before a `final` event (no messageStop) → throws (malformed
 *      stream).
 *
 * Requirements: 3.3, 3.5
 */

import { mockClient } from "aws-sdk-client-mock";
import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
} from "@aws-sdk/client-bedrock-agentcore";

import { ManagedHarnessEditorInvocation } from "../managed-harness-invocation";
import type { LoopContext } from "@agent-harness/loop/src/run";

// ---------------------------------------------------------------------------
// Helpers: build canned stream events
// ---------------------------------------------------------------------------

/**
 * Build an async iterable from an array of stream events. This is the shape
 * the SDK delivers via `response.stream` — an `AsyncIterable<InvokeHarnessStreamOutput>`.
 *
 * We use `unknown` casts throughout because the SDK's `InvokeHarnessStreamOutput`
 * is a tagged union with a required `$unknown` discriminant that we don't need
 * to satisfy in test fixtures — the implementation only reads the named keys.
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
 * Build the sequence of stream events that represent a single
 * `module.writeFile` tool call followed by its tool result.
 *
 * The sequence mirrors what the SDK emits for one tool use + result pair:
 *   contentBlockStart (tool-use)
 *   contentBlockDelta (tool-use input JSON)
 *   contentBlockStop  (tool-use)
 *   contentBlockStart (tool-result)
 *   contentBlockDelta (tool-result json)
 *   contentBlockStop  (tool-result)
 */
function writeFileEvents(opts: {
  toolUseId: string;
  blockIndexToolUse: number;
  blockIndexToolResult: number;
  path: string;
  contents: string;
}): Record<string, unknown>[] {
  const input = JSON.stringify({ path: opts.path, contents: opts.contents });
  return [
    // tool-use start
    {
      contentBlockStart: {
        contentBlockIndex: opts.blockIndexToolUse,
        start: {
          toolUse: {
            toolUseId: opts.toolUseId,
            name: "module.writeFile",
          },
        },
      },
    },
    // tool-use input delta
    {
      contentBlockDelta: {
        contentBlockIndex: opts.blockIndexToolUse,
        delta: {
          toolUse: { input },
        },
      },
    },
    // tool-use stop
    {
      contentBlockStop: {
        contentBlockIndex: opts.blockIndexToolUse,
      },
    },
    // tool-result start (success)
    {
      contentBlockStart: {
        contentBlockIndex: opts.blockIndexToolResult,
        start: {
          toolResult: {
            toolUseId: opts.toolUseId,
            status: "success",
          },
        },
      },
    },
    // tool-result delta (json output)
    {
      contentBlockDelta: {
        contentBlockIndex: opts.blockIndexToolResult,
        delta: {
          toolResult: [{ json: { written: true } }],
        },
      },
    },
    // tool-result stop
    {
      contentBlockStop: {
        contentBlockIndex: opts.blockIndexToolResult,
      },
    },
  ];
}

/** A minimal `messageStop` event that terminates the stream cleanly. */
const messageStopEvent: Record<string, unknown> = {
  messageStop: { stopReason: "end_turn" },
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const HARNESS_ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/editor-agent/abc";
const SESSION_ID = "session-test-001";

/** Minimal LoopContext for tests — content doesn't matter for stream-walking tests. */
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
  // Test 1: two module.writeFile results → two edits with correct {path, diff}
  // -------------------------------------------------------------------------

  it("returns two edits when the stream contains two module.writeFile results", async () => {
    const events = [
      ...writeFileEvents({
        toolUseId: "tu-001",
        blockIndexToolUse: 0,
        blockIndexToolResult: 1,
        path: "lib/alpha.ts",
        contents: "export const alpha = 1;\n",
      }),
      ...writeFileEvents({
        toolUseId: "tu-002",
        blockIndexToolUse: 2,
        blockIndexToolResult: 3,
        path: "lib/beta.ts",
        contents: "export const beta = 2;\n",
      }),
      messageStopEvent,
    ];

    clientMock.on(InvokeHarnessCommand).resolves({
      stream: makeStream(events),
    });

    const invocation = new ManagedHarnessEditorInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client: new BedrockAgentCoreClient({}),
    });

    const result = await invocation.runEditor(CONTEXT);

    expect(result.edits).toHaveLength(2);

    // First edit: lib/alpha.ts — new file (no prior readFile), so before = ""
    const alpha = result.edits[0]!;
    expect(alpha.path).toBe("lib/alpha.ts");
    // The diff should contain the new content lines
    expect(alpha.diff).toContain("+++ lib/alpha.ts");
    expect(alpha.diff).toContain("+export const alpha = 1;");

    // Second edit: lib/beta.ts — new file, before = ""
    const beta = result.edits[1]!;
    expect(beta.path).toBe("lib/beta.ts");
    expect(beta.diff).toContain("+++ lib/beta.ts");
    expect(beta.diff).toContain("+export const beta = 2;");
  });

  // -------------------------------------------------------------------------
  // Test 2: no module.writeFile results but a final event → empty edits
  // -------------------------------------------------------------------------

  it("returns empty edits when the stream has no module.writeFile results but ends with messageStop", async () => {
    // Stream with only a messageStop — the agent produced no file edits this turn.
    const events = [messageStopEvent];

    clientMock.on(InvokeHarnessCommand).resolves({
      stream: makeStream(events),
    });

    const invocation = new ManagedHarnessEditorInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client: new BedrockAgentCoreClient({}),
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
    });

    await expect(invocation.runEditor(CONTEXT)).rejects.toThrow(
      "ThrottlingException",
    );
  });

  // -------------------------------------------------------------------------
  // Test 4: stream ends before a final event → throws (malformed stream)
  // -------------------------------------------------------------------------

  it("throws when the stream ends without a messageStop event", async () => {
    // Stream with a writeFile call but no messageStop — truncated/malformed.
    const events = [
      ...writeFileEvents({
        toolUseId: "tu-003",
        blockIndexToolUse: 0,
        blockIndexToolResult: 1,
        path: "lib/gamma.ts",
        contents: "export const gamma = 3;\n",
      }),
      // Deliberately omit messageStopEvent
    ];

    clientMock.on(InvokeHarnessCommand).resolves({
      stream: makeStream(events),
    });

    const invocation = new ManagedHarnessEditorInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client: new BedrockAgentCoreClient({}),
    });

    await expect(invocation.runEditor(CONTEXT)).rejects.toThrow(
      /messageStop/,
    );
  });

  // -------------------------------------------------------------------------
  // Additional: diff correctly uses readFile "before" contents
  // -------------------------------------------------------------------------

  it("computes diff against readFile before-contents when the agent reads before writing", async () => {
    const beforeContents = "export const x = 0;\n";
    const afterContents = "export const x = 42;\n";

    // Simulate: agent reads lib/x.ts, then writes lib/x.ts with new contents.
    const readToolUseId = "tu-read-001";
    const writeToolUseId = "tu-write-001";

    const events: Record<string, unknown>[] = [
      // module.readFile tool-use
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: {
            toolUse: {
              toolUseId: readToolUseId,
              name: "module.readFile",
            },
          },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: {
            toolUse: { input: JSON.stringify({ path: "lib/x.ts" }) },
          },
        },
      },
      {
        contentBlockStop: { contentBlockIndex: 0 },
      },
      // module.readFile tool-result (returns the before contents)
      {
        contentBlockStart: {
          contentBlockIndex: 1,
          start: {
            toolResult: {
              toolUseId: readToolUseId,
              status: "success",
            },
          },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: {
            toolResult: [{ json: { contents: beforeContents, sha: "abc123" } }],
          },
        },
      },
      {
        contentBlockStop: { contentBlockIndex: 1 },
      },
      // module.writeFile tool-use
      {
        contentBlockStart: {
          contentBlockIndex: 2,
          start: {
            toolUse: {
              toolUseId: writeToolUseId,
              name: "module.writeFile",
            },
          },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 2,
          delta: {
            toolUse: {
              input: JSON.stringify({ path: "lib/x.ts", contents: afterContents }),
            },
          },
        },
      },
      {
        contentBlockStop: { contentBlockIndex: 2 },
      },
      // module.writeFile tool-result (success)
      {
        contentBlockStart: {
          contentBlockIndex: 3,
          start: {
            toolResult: {
              toolUseId: writeToolUseId,
              status: "success",
            },
          },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 3,
          delta: {
            toolResult: [{ json: { written: true } }],
          },
        },
      },
      {
        contentBlockStop: { contentBlockIndex: 3 },
      },
      messageStopEvent,
    ];

    clientMock.on(InvokeHarnessCommand).resolves({
      stream: makeStream(events),
    });

    const invocation = new ManagedHarnessEditorInvocation({
      harnessArn: HARNESS_ARN,
      sessionId: SESSION_ID,
      client: new BedrockAgentCoreClient({}),
    });

    const result = await invocation.runEditor(CONTEXT);

    expect(result.edits).toHaveLength(1);
    const edit = result.edits[0]!;
    expect(edit.path).toBe("lib/x.ts");
    // Diff should show the before line removed and after line added
    expect(edit.diff).toContain("-export const x = 0;");
    expect(edit.diff).toContain("+export const x = 42;");
  });

  // -------------------------------------------------------------------------
  // Additional: in-band error events are thrown
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
    });

    await expect(invocation.runEditor(CONTEXT)).rejects.toThrow(
      /InternalServerException/,
    );
  });
});
