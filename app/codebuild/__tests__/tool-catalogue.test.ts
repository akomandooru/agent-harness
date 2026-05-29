import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodeBuildToolCatalogue } from "../tool-catalogue";
import { ToolExecutor } from "../../orchestrator/tool-executor";

describe("createCodeBuildToolCatalogue", () => {
  let moduleRoot: string;
  let cleanup: () => void;

  beforeEach(() => {
    moduleRoot = join(tmpdir(), `tool-catalogue-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(moduleRoot, { recursive: true });
    cleanup = () => rmSync(moduleRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("registers exactly three tools", () => {
    const catalogue = createCodeBuildToolCatalogue({ moduleRoot });
    expect(catalogue.get("module_readFile")).toBeDefined();
    expect(catalogue.get("module_writeFile")).toBeDefined();
    expect(catalogue.get("module_listFiles")).toBeDefined();
  });

  it("returns undefined for unregistered tools", () => {
    const catalogue = createCodeBuildToolCatalogue({ moduleRoot });
    expect(catalogue.get("module_deleteFile")).toBeUndefined();
    expect(catalogue.get("unknownTool")).toBeUndefined();
  });

  describe("unregistered tool via ToolExecutor", () => {
    it("returns error toolResult with 'Tool not registered: {toolName}'", async () => {
      const catalogue = createCodeBuildToolCatalogue({ moduleRoot });
      const executor = new ToolExecutor(catalogue);
      const result = await executor.executeOne({
        toolUseId: "test-1",
        name: "nonExistentTool",
        input: {},
      });
      expect(result.status).toBe("error");
      expect(result.content).toBe("Tool not registered: nonExistentTool");
    });
  });

  describe("module_readFile", () => {
    it("reads file contents relative to moduleRoot", async () => {
      writeFileSync(join(moduleRoot, "hello.txt"), "world", "utf8");
      const catalogue = createCodeBuildToolCatalogue({ moduleRoot });
      const handler = catalogue.get("module_readFile")!;
      const result = await handler({ path: "hello.txt" });
      expect(result).toEqual({ content: "world", path: "hello.txt" });
    });

    it("reads files in subdirectories", async () => {
      mkdirSync(join(moduleRoot, "src"), { recursive: true });
      writeFileSync(join(moduleRoot, "src", "index.ts"), "export {};", "utf8");
      const catalogue = createCodeBuildToolCatalogue({ moduleRoot });
      const handler = catalogue.get("module_readFile")!;
      const result = await handler({ path: "src/index.ts" });
      expect(result).toEqual({ content: "export {};", path: "src/index.ts" });
    });

    it("rejects paths with .. segments", async () => {
      const catalogue = createCodeBuildToolCatalogue({ moduleRoot });
      const handler = catalogue.get("module_readFile")!;
      await expect(handler({ path: "../etc/passwd" })).rejects.toThrow("must not contain '..' segments");
    });

    it("rejects absolute paths", async () => {
      const catalogue = createCodeBuildToolCatalogue({ moduleRoot });
      const handler = catalogue.get("module_readFile")!;
      await expect(handler({ path: "/etc/passwd" })).rejects.toThrow("must be relative to module root");
    });
  });

  describe("module_writeFile", () => {
    it("writes file contents relative to moduleRoot", async () => {
      const catalogue = createCodeBuildToolCatalogue({ moduleRoot });
      const handler = catalogue.get("module_writeFile")!;
      const result = await handler({ path: "output.txt", content: "hello" });
      expect(result).toEqual({ written: true, path: "output.txt" });

      const { readFileSync } = require("node:fs");
      expect(readFileSync(join(moduleRoot, "output.txt"), "utf8")).toBe("hello");
    });

    it("creates parent directories as needed", async () => {
      const catalogue = createCodeBuildToolCatalogue({ moduleRoot });
      const handler = catalogue.get("module_writeFile")!;
      await handler({ path: "deep/nested/dir/file.ts", content: "content" });

      const { readFileSync } = require("node:fs");
      expect(readFileSync(join(moduleRoot, "deep/nested/dir/file.ts"), "utf8")).toBe("content");
    });

    it("rejects when content is missing", async () => {
      const catalogue = createCodeBuildToolCatalogue({ moduleRoot });
      const handler = catalogue.get("module_writeFile")!;
      await expect(handler({ path: "file.txt" })).rejects.toThrow("content is required");
    });
  });

  describe("module_listFiles", () => {
    it("lists all files when no pattern specified", async () => {
      mkdirSync(join(moduleRoot, "src"), { recursive: true });
      writeFileSync(join(moduleRoot, "index.ts"), "", "utf8");
      writeFileSync(join(moduleRoot, "src/util.ts"), "", "utf8");
      const catalogue = createCodeBuildToolCatalogue({ moduleRoot });
      const handler = catalogue.get("module_listFiles")!;
      const result = (await handler({})) as { paths: string[] };
      expect(result.paths).toContain("index.ts");
      expect(result.paths).toContain("src/util.ts");
    });

    it("filters by glob pattern", async () => {
      mkdirSync(join(moduleRoot, "src"), { recursive: true });
      writeFileSync(join(moduleRoot, "readme.md"), "", "utf8");
      writeFileSync(join(moduleRoot, "src/app.ts"), "", "utf8");
      writeFileSync(join(moduleRoot, "src/app.js"), "", "utf8");
      const catalogue = createCodeBuildToolCatalogue({ moduleRoot });
      const handler = catalogue.get("module_listFiles")!;
      const result = (await handler({ pattern: "**/*.ts" })) as { paths: string[] };
      expect(result.paths).toContain("src/app.ts");
      expect(result.paths).not.toContain("readme.md");
      expect(result.paths).not.toContain("src/app.js");
    });

    it("returns paths relative to moduleRoot", async () => {
      mkdirSync(join(moduleRoot, "lib"), { recursive: true });
      writeFileSync(join(moduleRoot, "lib/helper.ts"), "", "utf8");
      const catalogue = createCodeBuildToolCatalogue({ moduleRoot });
      const handler = catalogue.get("module_listFiles")!;
      const result = (await handler({ pattern: "**/*" })) as { paths: string[] };
      for (const p of result.paths) {
        expect(p).not.toContain(moduleRoot);
        expect(p.startsWith("/")).toBe(false);
      }
    });
  });
});
