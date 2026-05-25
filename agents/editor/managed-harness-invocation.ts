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
 *        configured editor harness via `InvokeHarnessCommand`.
 *     2. Walk the streaming response. For each `module.writeFile` call the
 *        agent makes (visible as a `contentBlockStart` with a tool-use
 *        block start, `contentBlockDelta` events that accumulate the JSON
 *        input, and a matching `contentBlockStart` with a tool-result
 *        block start whose status is `success`), record `{path, diff}`
 *        into the accumulator. The diff is computed from the prior
 *        contents (captured from any preceding `module.readFile` for the
 *        same path, or empty if the path was never read this turn) versus
 *        the new contents the agent passed to `writeFile`.
 *     3. Other tool calls (`cdk.diff`, `sensor.tsc`, `reviewer.invoke`, …)
 *        are ignored: they have already executed inside the harness and
 *        they do not mutate the orchestrator-visible working tree.
 *     4. Require a `messageStop` event to mark the end of the agent's
 *        final message before the stream closes. Streams that end
 *        without one — or that surface an `internalServerException`,
 *        `validationException`, or `runtimeClientError` event — are
 *        treated as malformed and the call throws rather than returning
 *        an empty `EditorResult`.
 *     5. Return `EditorResult { edits }`.
 *
 * What it deliberately doesn't do
 *
 *   - It does not catch SDK throws and convert them into empty results.
 *     A network failure, throttling, access-denied, or validation error
 *     propagates so `runLoop()` can record the iteration as failed and
 *     evaluate stop conditions. The Lambda handler in
 *     `app/orchestrator/index.ts` translates the eventual outcome into
 *     a 5xx response.
 *
 *   - It does not register or override the harness's tool catalogue or
 *     system prompt. Both are baked into the harness deployment
 *     (`app/editor/harness.json` + `agentcore deploy`); the orchestrator
 *     only invokes.
 *
 *   - It does not reach into the orchestrator's local filesystem to
 *     diff against the working tree. The Lambda has no working copy of
 *     the module under maintenance — only what the harness streams back
 *     in tool events. If the agent never read a file before writing it,
 *     "before contents" is the empty string for diff purposes.
 *
 * Lifecycle
 *
 *   The orchestrator constructs one `ManagedHarnessEditorInvocation` per
 *   session. The `BedrockAgentCoreClient` is reused across iterations
 *   (connection pooling); the `harnessArn` and `sessionId` are stable for
 *   the lifetime of the session.
 *
 * Requirements: 3.2, 3.3, 3.4, 3.5
 */

import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
  type HarnessContentBlockDeltaEvent,
  type HarnessContentBlockStartEvent,
  type InvokeHarnessStreamOutput,
} from "@aws-sdk/client-bedrock-agentcore";

import type { EditorResult, LoopContext } from "@agent-harness/loop/src/run";

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
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

/**
 * Implements the `LoopGates.runEditor` contract from
 * `@agent-harness/loop/src/run` by invoking the editor Managed Harness
 * via `bedrock-agentcore:InvokeHarness`.
 *
 * Hand the bound method directly to `LoopGates`:
 *
 *   const editorInvocation = new ManagedHarnessEditorInvocation({
 *     harnessArn: process.env.EDITOR_HARNESS_ARN!,
 *     sessionId: session.trigger.session.id,
 *   });
 *
 *   const gates: LoopGates = {
 *     runEditor: (ctx) => editorInvocation.runEditor(ctx),
 *     // ...
 *   };
 */
export class ManagedHarnessEditorInvocation {
  private readonly client: BedrockAgentCoreClient;
  private readonly harnessArn: string;
  private readonly sessionId: string;

  public constructor(options: ManagedHarnessEditorInvocationOptions) {
    this.harnessArn = options.harnessArn;
    this.sessionId = options.sessionId;
    this.client = options.client ?? new BedrockAgentCoreClient({});
  }

  /**
   * Implements `LoopGates.runEditor`. Sends the supplied context to the
   * editor Managed Harness, walks the streaming response, and returns
   * the edits the agent produced via `module.writeFile`.
   */
  public async runEditor(context: LoopContext): Promise<EditorResult> {
    // 1. Serialise the LoopContext as a single user message. The harness
    //    has its system prompt and tool catalogue baked in; the user
    //    turn only carries the trigger and history the agent needs to
    //    plan this iteration's edits.
    const userMessage = JSON.stringify({
      trigger: context.trigger,
      history: context.history,
    });

    const command = new InvokeHarnessCommand({
      harnessArn: this.harnessArn,
      runtimeSessionId: this.sessionId,
      messages: [
        {
          role: "user",
          content: [{ text: userMessage }],
        },
      ],
    });

    // 2. Issue the InvokeHarness call. SDK throws (network, throttling,
    //    access-denied, validation) propagate without being caught; the
    //    bounded loop treats them as a sensor-class failure. Returning
    //    an empty EditorResult on failure would silently mask real
    //    problems, which is exactly what Requirement 3.5 forbids.
    const response = await this.client.send(command);

    if (response.stream === undefined) {
      throw new Error(
        "ManagedHarnessEditorInvocation: InvokeHarness response did not " +
          "include a stream. This indicates a malformed SDK response.",
      );
    }

    // 3. Walk the stream and accumulate edits.
    const edits = await this.walkStream(response.stream);

    return { edits };
  }

  // -------------------------------------------------------------------------
  // Stream walker
  // -------------------------------------------------------------------------

  /**
   * Walk the streaming response from `InvokeHarness`, collecting the
   * `module.writeFile` calls the agent issued and producing
   * `EditorResult.edits` from them.
   *
   * The SDK exposes a tagged-union event stream. We track three kinds of
   * blocks across `contentBlockStart`, `contentBlockDelta`, and
   * `contentBlockStop` events, indexed by `contentBlockIndex`:
   *
   *   - tool-use blocks for `module.writeFile` — capture path + new
   *     contents from the accumulating JSON input deltas.
   *   - tool-use blocks for `module.readFile` — capture the path so we
   *     can pair its later `module.readFile` tool-result with the path.
   *   - tool-result blocks — match by `toolUseId` to the prior tool-use
   *     and (a) for `module.readFile` results, parse `contents` from the
   *     JSON output and remember it as "before" contents for that path;
   *     (b) for `module.writeFile` results, finalise the edit record.
   *
   * `messageStop` is required: a stream that closes without one is
   * malformed and we throw rather than returning a partial result.
   */
  private async walkStream(
    stream: AsyncIterable<InvokeHarnessStreamOutput>,
  ): Promise<ReadonlyArray<{ readonly path: string; readonly diff: string }>> {
    /**
     * Per-block-index state for the in-flight content blocks. Indexed by
     * `contentBlockIndex` because the same logical conversation slot
     * receives a `start`, zero-or-more `delta`s, then a `stop` event,
     * and the index is what threads them together.
     */
    interface ToolUseBlock {
      readonly kind: "tool-use";
      readonly toolUseId: string;
      readonly toolName: string;
      /** Accumulated JSON-string fragments from `delta.toolUse.input`. */
      inputFragments: string[];
    }
    interface ToolResultBlock {
      readonly kind: "tool-result";
      readonly toolUseId: string;
      /** Whether the tool succeeded; ignored for non-success results. */
      success: boolean;
      /** Accumulated JSON output fragments. */
      jsonFragments: unknown[];
      textFragments: string[];
    }
    type ActiveBlock = ToolUseBlock | ToolResultBlock;

    const activeBlocks = new Map<number, ActiveBlock>();

    /** toolUseId -> (toolName, parsedInput) for completed tool-uses. */
    const completedToolUses = new Map<
      string,
      { readonly toolName: string; readonly input: WriteFileInput | ReadFileInput | UnknownInput }
    >();

    /**
     * path -> "before" contents observed so far this turn. Populated by
     * `module.readFile` results; default is `""` for paths the agent
     * never read before writing.
     */
    const beforeContents = new Map<string, string>();

    /** Accumulated edits in the order their `module.writeFile` results landed. */
    const edits: Array<{ path: string; diff: string }> = [];

    let sawMessageStop = false;

    for await (const event of stream) {
      // Surface server-side errors. The SDK delivers these as in-band
      // events on the stream rather than as throws; we re-throw to keep
      // the contract uniform with how SDK throws are handled.
      if (event.internalServerException !== undefined) {
        throw new Error(
          `ManagedHarnessEditorInvocation: InternalServerException from harness: ${
            event.internalServerException.message ?? "(no message)"
          }`,
        );
      }
      if (event.validationException !== undefined) {
        throw new Error(
          `ManagedHarnessEditorInvocation: ValidationException from harness: ${
            event.validationException.message
          } (reason=${event.validationException.reason})`,
        );
      }
      if (event.runtimeClientError !== undefined) {
        throw new Error(
          `ManagedHarnessEditorInvocation: RuntimeClientError from harness: ${
            event.runtimeClientError.message ?? "(no message)"
          }`,
        );
      }

      if (event.contentBlockStart !== undefined) {
        this.handleContentBlockStart(event.contentBlockStart, activeBlocks);
        continue;
      }
      if (event.contentBlockDelta !== undefined) {
        this.handleContentBlockDelta(event.contentBlockDelta, activeBlocks);
        continue;
      }
      if (event.contentBlockStop !== undefined) {
        const idx = event.contentBlockStop.contentBlockIndex;
        if (idx === undefined) continue;
        const block = activeBlocks.get(idx);
        if (block === undefined) continue;
        activeBlocks.delete(idx);

        if (block.kind === "tool-use") {
          // Parse the accumulated input JSON and remember it for when
          // the matching tool-result lands.
          const inputJson = block.inputFragments.join("");
          let parsedInput: WriteFileInput | ReadFileInput | UnknownInput;
          try {
            parsedInput = JSON.parse(inputJson) as
              | WriteFileInput
              | ReadFileInput
              | UnknownInput;
          } catch {
            // Tool input that doesn't parse is most likely a tool we do
            // not care about. Record it as opaque so the later result
            // resolution still finds the toolName but produces no edit.
            parsedInput = {} as UnknownInput;
          }
          completedToolUses.set(block.toolUseId, {
            toolName: block.toolName,
            input: parsedInput,
          });
        } else {
          // tool-result block stopped: pair with the tool-use, update
          // beforeContents (for readFile) or push an edit (for writeFile).
          const toolUse = completedToolUses.get(block.toolUseId);
          if (toolUse === undefined) continue;
          this.applyToolResult(toolUse, block, beforeContents, edits);
        }
        continue;
      }
      if (event.messageStop !== undefined) {
        sawMessageStop = true;
        // Don't break: the harness may emit a `metadata` event after
        // the final `messageStop` (token usage, latency). Keep draining
        // until the iterator naturally ends.
        continue;
      }
      // Other event kinds (messageStart, metadata) carry no information
      // we need at this layer; ignore them.
    }

    if (!sawMessageStop) {
      throw new Error(
        "ManagedHarnessEditorInvocation: harness stream ended without a " +
          "messageStop event. Treating as a malformed response rather than " +
          "returning an empty EditorResult.",
      );
    }

    return edits;
  }

  /**
   * Handle a `contentBlockStart` event. Tool-use and tool-result blocks
   * start an entry in the per-index active-block map; other start kinds
   * are ignored.
   */
  private handleContentBlockStart(
    event: HarnessContentBlockStartEvent,
    activeBlocks: Map<
      number,
      | { readonly kind: "tool-use"; readonly toolUseId: string; readonly toolName: string; inputFragments: string[] }
      | { readonly kind: "tool-result"; readonly toolUseId: string; success: boolean; jsonFragments: unknown[]; textFragments: string[] }
    >,
  ): void {
    const idx = event.contentBlockIndex;
    if (idx === undefined) return;
    const start = event.start;
    if (start === undefined) return;

    if (start.toolUse !== undefined) {
      const { toolUseId, name } = start.toolUse;
      if (toolUseId === undefined || name === undefined) return;
      activeBlocks.set(idx, {
        kind: "tool-use",
        toolUseId,
        toolName: name,
        inputFragments: [],
      });
      return;
    }
    if (start.toolResult !== undefined) {
      const { toolUseId, status } = start.toolResult;
      if (toolUseId === undefined) return;
      activeBlocks.set(idx, {
        kind: "tool-result",
        toolUseId,
        success: status === "success",
        jsonFragments: [],
        textFragments: [],
      });
      return;
    }
  }

  /**
   * Handle a `contentBlockDelta` event by appending fragments to the
   * matching active block. Text-only deltas (model thoughts) and
   * reasoning-content deltas are ignored: they don't contribute to
   * edits.
   */
  private handleContentBlockDelta(
    event: HarnessContentBlockDeltaEvent,
    activeBlocks: Map<
      number,
      | { readonly kind: "tool-use"; readonly toolUseId: string; readonly toolName: string; inputFragments: string[] }
      | { readonly kind: "tool-result"; readonly toolUseId: string; success: boolean; jsonFragments: unknown[]; textFragments: string[] }
    >,
  ): void {
    const idx = event.contentBlockIndex;
    if (idx === undefined) return;
    const block = activeBlocks.get(idx);
    if (block === undefined) return;
    const delta = event.delta;
    if (delta === undefined) return;

    if (block.kind === "tool-use") {
      // Tool-use input deltas are JSON-string fragments; concatenate
      // them in order and parse on `contentBlockStop`.
      if (delta.toolUse !== undefined && delta.toolUse.input !== undefined) {
        block.inputFragments.push(delta.toolUse.input);
      }
      return;
    }

    // tool-result block: collect both `text` and `json` fragments. The
    // editor's tool wrappers in this repo emit JSON outputs (e.g.,
    // module.readFile returns `{contents, sha}`), but we keep the text
    // path so a forker who registers a text-emitting tool still works.
    if (delta.toolResult !== undefined) {
      for (const trDelta of delta.toolResult) {
        if (trDelta.text !== undefined) {
          block.textFragments.push(trDelta.text);
        } else if (trDelta.json !== undefined) {
          block.jsonFragments.push(trDelta.json);
        }
      }
    }
  }

  /**
   * Apply a finished tool-result to the accumulators.
   *
   *   - `module.readFile` (success): remember the read file's contents
   *     so a later `module.writeFile` for the same path can compute a
   *     diff against real before-contents.
   *   - `module.writeFile` (success): push a `{path, diff}` entry into
   *     `edits`, computing the diff from the stored before-contents
   *     (defaulting to `""` when unseen) versus the input contents.
   *   - any other tool, or a non-success result: ignored.
   */
  private applyToolResult(
    toolUse: { readonly toolName: string; readonly input: WriteFileInput | ReadFileInput | UnknownInput },
    block: { readonly toolUseId: string; success: boolean; jsonFragments: unknown[]; textFragments: string[] },
    beforeContents: Map<string, string>,
    edits: Array<{ path: string; diff: string }>,
  ): void {
    if (!block.success) return;

    if (toolUse.toolName === "module.readFile") {
      const path = (toolUse.input as ReadFileInput).path;
      if (typeof path !== "string" || path.length === 0) return;
      const output = this.parseToolResultJson(block);
      if (output === null || typeof output !== "object") return;
      const contents = (output as { contents?: unknown }).contents;
      if (typeof contents === "string") {
        beforeContents.set(path, contents);
      }
      return;
    }

    if (toolUse.toolName === "module.writeFile") {
      const input = toolUse.input as WriteFileInput;
      if (typeof input.path !== "string" || input.path.length === 0) return;
      if (typeof input.contents !== "string") return;
      const before = beforeContents.get(input.path) ?? "";
      const after = input.contents;
      // Update beforeContents so a subsequent writeFile for the same
      // path in this turn diffs against the most recent state.
      beforeContents.set(input.path, after);
      edits.push({
        path: input.path,
        diff: computeUnifiedDiff(input.path, before, after),
      });
      return;
    }

    // Other tools: ignored at this layer per the design's accumulation
    // rule. They have already executed inside the harness; their results
    // are not orchestrator-visible.
  }

  /**
   * Parse a tool-result block's accumulated output as JSON. Prefers
   * structured `json` fragments (the editor's tools emit JSON); falls
   * back to concatenated text fragments parsed as JSON. Returns `null`
   * if no parseable output is available.
   */
  private parseToolResultJson(block: {
    jsonFragments: unknown[];
    textFragments: string[];
  }): unknown {
    // Prefer the most recent json fragment: the editor's tools emit one
    // structured output per call.
    if (block.jsonFragments.length > 0) {
      return block.jsonFragments[block.jsonFragments.length - 1];
    }
    if (block.textFragments.length === 0) return null;
    const text = block.textFragments.join("");
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface WriteFileInput {
  readonly path?: string;
  readonly contents?: string;
}

interface ReadFileInput {
  readonly path?: string;
}

type UnknownInput = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Diff helper
// ---------------------------------------------------------------------------

/**
 * Build a minimal unified-diff-style string from `before` and `after`.
 *
 * The orchestrator does not have a working git tree (it runs in Lambda),
 * so we cannot delegate to `git diff`. The output here is a textual
 * representation suitable for the session record, the partial-PR body,
 * and the reviewer harness's `diff` input — all of which want a human-
 * readable diff string, not a parseable patch.
 *
 * The output mirrors a simplified unified-diff: one header line, a single
 * hunk header, and `-` / `+` markers per line. New files (no before
 * contents) emit `+` lines only; deleted files (the agent writing an
 * empty string over real contents) emit `-` lines only.
 *
 * No external dependency is taken: a few-line accumulator keeps this
 * package's dependency surface narrow.
 */
function computeUnifiedDiff(
  path: string,
  before: string,
  after: string,
): string {
  if (before === after) {
    // The agent wrote identical contents; record the no-op so the loop
    // sees the call but the diff is empty.
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
