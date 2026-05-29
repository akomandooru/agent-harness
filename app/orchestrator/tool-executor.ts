/**
 * Tool catalogue and executor for inline_function tool-use blocks.
 *
 * The ToolExecutor dispatches tool-use blocks (type: "tool_use") to
 * registered handlers in the ToolCatalogue. It produces toolResult blocks
 * with status "success" (JSON-serialized output) or "error" (error message).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A tool handler accepts arbitrary parsed input and returns an arbitrary
 * result. The executor JSON-serializes the output into the toolResult.
 */
export type ToolHandler = (input: unknown) => Promise<unknown>;

/**
 * Registry of tool handlers keyed by tool name.
 */
export interface ToolCatalogue {
  /** Look up a tool handler by name. Returns undefined if not registered. */
  get(toolName: string): ToolHandler | undefined;
}

/**
 * A tool-use block extracted from an assistant message.
 */
export interface ToolUseBlock {
  readonly toolUseId: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * The result of executing a single tool-use block.
 */
export interface ToolResultBlock {
  readonly toolUseId: string;
  readonly status: "success" | "error";
  readonly content: string;
}

// ---------------------------------------------------------------------------
// MapToolCatalogue — simple Map-based implementation
// ---------------------------------------------------------------------------

/**
 * A simple Map-backed ToolCatalogue implementation.
 */
export class MapToolCatalogue implements ToolCatalogue {
  private readonly handlers: Map<string, ToolHandler>;

  constructor(handlers?: Map<string, ToolHandler> | Record<string, ToolHandler>) {
    if (handlers instanceof Map) {
      this.handlers = new Map(handlers);
    } else if (handlers !== undefined) {
      this.handlers = new Map(Object.entries(handlers));
    } else {
      this.handlers = new Map();
    }
  }

  get(toolName: string): ToolHandler | undefined {
    return this.handlers.get(toolName);
  }

  /** Register a handler for a tool name. */
  register(toolName: string, handler: ToolHandler): void {
    this.handlers.set(toolName, handler);
  }
}

// ---------------------------------------------------------------------------
// ToolExecutor
// ---------------------------------------------------------------------------

/**
 * Dispatches tool-use blocks to registered handlers in the catalogue.
 *
 * For each block:
 * - If the tool is registered and the handler succeeds → status "success"
 *   with JSON-serialized output.
 * - If the tool is registered and the handler throws → status "error"
 *   with the error message.
 * - If the tool is not registered → status "error" with a
 *   "tool not registered" message.
 */
export class ToolExecutor {
  private readonly catalogue: ToolCatalogue;

  constructor(catalogue: ToolCatalogue) {
    this.catalogue = catalogue;
  }

  /**
   * Execute a single tool-use block and return the corresponding result.
   */
  async executeOne(block: ToolUseBlock): Promise<ToolResultBlock> {
    const handler = this.catalogue.get(block.name);

    if (handler === undefined) {
      console.log(`[tool-executor] tool not registered: ${block.name} (toolUseId=${block.toolUseId})`);
      return {
        toolUseId: block.toolUseId,
        status: "error",
        content: `Tool not registered: ${block.name}`,
      };
    }

    console.log(`[tool-executor] executing tool: ${block.name} (toolUseId=${block.toolUseId})`);
    try {
      const output = await handler(block.input);
      return {
        toolUseId: block.toolUseId,
        status: "success",
        content: JSON.stringify(output),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[tool-executor] tool ${block.name} threw: ${message}`);
      return {
        toolUseId: block.toolUseId,
        status: "error",
        content: message,
      };
    }
  }

  /**
   * Execute multiple tool-use blocks sequentially and return all results.
   * Order of results matches order of input blocks.
   */
  async executeAll(blocks: ToolUseBlock[]): Promise<ToolResultBlock[]> {
    const results: ToolResultBlock[] = [];
    for (const block of blocks) {
      results.push(await this.executeOne(block));
    }
    return results;
  }
}
