import {
  ToolExecutor,
  MapToolCatalogue,
  type ToolHandler,
  type ToolUseBlock,
} from "../tool-executor";

describe("ToolExecutor", () => {
  let catalogue: MapToolCatalogue;
  let executor: ToolExecutor;

  beforeEach(() => {
    catalogue = new MapToolCatalogue();
    executor = new ToolExecutor(catalogue);
  });

  describe("executeOne", () => {
    it("returns success with JSON-serialized output when handler succeeds", async () => {
      const handler: ToolHandler = async (input) => ({ echoed: input });
      catalogue.register("echo", handler);

      const block: ToolUseBlock = {
        toolUseId: "tu-001",
        name: "echo",
        input: { message: "hello" },
      };

      const result = await executor.executeOne(block);

      expect(result).toEqual({
        toolUseId: "tu-001",
        status: "success",
        content: JSON.stringify({ echoed: { message: "hello" } }),
      });
    });

    it("returns error with error message when handler throws", async () => {
      const handler: ToolHandler = async () => {
        throw new Error("disk full");
      };
      catalogue.register("failing-tool", handler);

      const block: ToolUseBlock = {
        toolUseId: "tu-002",
        name: "failing-tool",
        input: {},
      };

      const result = await executor.executeOne(block);

      expect(result).toEqual({
        toolUseId: "tu-002",
        status: "error",
        content: "disk full",
      });
    });

    it("returns error when tool name is not registered", async () => {
      const block: ToolUseBlock = {
        toolUseId: "tu-003",
        name: "nonexistent-tool",
        input: { foo: "bar" },
      };

      const result = await executor.executeOne(block);

      expect(result).toEqual({
        toolUseId: "tu-003",
        status: "error",
        content: "Tool not registered: nonexistent-tool",
      });
    });

    it("handles non-Error throws by converting to string", async () => {
      const handler: ToolHandler = async () => {
        throw "string error";
      };
      catalogue.register("string-throw", handler);

      const block: ToolUseBlock = {
        toolUseId: "tu-004",
        name: "string-throw",
        input: null,
      };

      const result = await executor.executeOne(block);

      expect(result).toEqual({
        toolUseId: "tu-004",
        status: "error",
        content: "string error",
      });
    });

    it("preserves toolUseId in all cases", async () => {
      const handler: ToolHandler = async () => 42;
      catalogue.register("num", handler);

      const block: ToolUseBlock = {
        toolUseId: "unique-id-xyz",
        name: "num",
        input: undefined,
      };

      const result = await executor.executeOne(block);
      expect(result.toolUseId).toBe("unique-id-xyz");
    });
  });

  describe("executeAll", () => {
    it("executes multiple blocks and returns results in order", async () => {
      catalogue.register("add", async (input) => {
        const { a, b } = input as { a: number; b: number };
        return a + b;
      });
      catalogue.register("fail", async () => {
        throw new Error("boom");
      });

      const blocks: ToolUseBlock[] = [
        { toolUseId: "t1", name: "add", input: { a: 1, b: 2 } },
        { toolUseId: "t2", name: "fail", input: {} },
        { toolUseId: "t3", name: "unknown", input: {} },
      ];

      const results = await executor.executeAll(blocks);

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ toolUseId: "t1", status: "success", content: "3" });
      expect(results[1]).toEqual({ toolUseId: "t2", status: "error", content: "boom" });
      expect(results[2]).toEqual({ toolUseId: "t3", status: "error", content: "Tool not registered: unknown" });
    });

    it("returns empty array for empty input", async () => {
      const results = await executor.executeAll([]);
      expect(results).toEqual([]);
    });
  });
});

describe("MapToolCatalogue", () => {
  it("can be constructed from a Record", () => {
    const handler: ToolHandler = async () => "ok";
    const catalogue = new MapToolCatalogue({ myTool: handler });
    expect(catalogue.get("myTool")).toBe(handler);
  });

  it("can be constructed from a Map", () => {
    const handler: ToolHandler = async () => "ok";
    const map = new Map([["myTool", handler]]);
    const catalogue = new MapToolCatalogue(map);
    expect(catalogue.get("myTool")).toBe(handler);
  });

  it("returns undefined for unregistered tools", () => {
    const catalogue = new MapToolCatalogue();
    expect(catalogue.get("nope")).toBeUndefined();
  });
});
