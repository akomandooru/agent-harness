/**
 * Unit + integration tests for the editor agent definition and the
 * tool-catalogue factory.
 *
 * Covers the verification matrix from tasks.md task 6.2:
 *   - `loadEditorAgentDefinition()` returns the expected shape (model
 *     pulled from `agent-harness.config.json` `models.editor`, system
 *     prompt body with the YAML frontmatter parsed off, version
 *     string captured, full editor tool catalogue attached).
 *   - `buildEditorToolCatalogue` returns 15 tools with the right
 *     names in the design's catalogue order.
 *   - Smoke test: create a temp module root, write a file via
 *     `module.writeFile` and read it back via `module.readFile`,
 *     confirm the contents round-trip through the wrapped tools the
 *     factory returned.
 *
 * The smoke test is the load-bearing test for this task. It exercises
 * the actual catalogue produced by `buildEditorToolCatalogue` (not the
 * raw tool exports) end-to-end through the shared wrapper, so a
 * future refactor that drops a tool, breaks the catalogue assembly,
 * or rejects valid file inputs would fail here.
 */

import { promises as fs, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  wrapTool,
  type SessionSink,
  type ToolDefinition,
  type ToolInvocationRecord,
  type WrapperRuntime,
} from "@agent-harness/shared";
import type {
  PostDeployInput,
  PostDeployOutput,
} from "@agent-harness/post-deploy";

import { RecordedReviewerInvocation } from "../../reviewer/agent";

import {
  EDITOR_TOOL_NAMES,
  buildEditorToolCatalogue,
  loadEditorAgentDefinition,
  parseEditorSystemPromptFrontmatter,
  type EditorToolCatalogueDependencies,
  type EditorTools,
} from "../agent";
import type {
  PostDeployContext,
  PostDeployRunner,
} from "../tools/post-deploy";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

class InMemorySink implements SessionSink {
  public records: ToolInvocationRecord[] = [];
  public async appendToolRecord(record: ToolInvocationRecord): Promise<void> {
    this.records.push(record);
  }
}

interface CatalogueFixture {
  readonly catalogue: EditorTools;
  readonly postDeployContext: PostDeployContext;
  readonly postDeployCalls: PostDeployInput[];
}

/**
 * Build a catalogue with stubbed runners/clients. The stubs are
 * deliberately minimal: tests that need richer behaviour can replace
 * any of them, but the smoke test only exercises the file tools, so
 * a no-op `cdkRunner`, `sensorRunner`, etc. is enough.
 */
function makeCatalogueFixture(): CatalogueFixture {
  const postDeployContext: PostDeployContext = {
    sessionId: "session-test-editor-agent",
  };
  const postDeployCalls: PostDeployInput[] = [];
  const postDeployRunner: PostDeployRunner = async (input) => {
    postDeployCalls.push(input);
    return {
      outcome: "pass",
      report: { sessionId: input.sessionId },
    } satisfies PostDeployOutput;
  };

  const deps: EditorToolCatalogueDependencies = {
    postDeployRunner,
    postDeployContext,
    reviewerInvocation: new RecordedReviewerInvocation(),
  };
  const catalogue = buildEditorToolCatalogue(deps);
  return { catalogue, postDeployContext, postDeployCalls };
}

/** Look up a tool from the catalogue by its declared name. */
function getTool(
  catalogue: EditorTools,
  name: string,
): ToolDefinition<unknown, unknown> {
  const found = catalogue.find((t) => t.name === name);
  if (found === undefined) {
    throw new Error(
      `Test fixture error: tool ${JSON.stringify(name)} not in catalogue`,
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// parseEditorSystemPromptFrontmatter
// ---------------------------------------------------------------------------

describe("parseEditorSystemPromptFrontmatter", () => {
  test("extracts the version and the body from a well-formed frontmatter", () => {
    const markdown =
      "---\n" +
      "prompt: agents/editor/system.md\n" +
      "version: 1.0.0\n" +
      "---\n" +
      "\n" +
      "# Editor agent\n" +
      "\n" +
      "Body content.\n";

    const parsed = parseEditorSystemPromptFrontmatter(markdown);

    expect(parsed.version).toBe("1.0.0");
    expect(parsed.body).toBe("# Editor agent\n\nBody content.\n");
  });

  test("tolerates a leading BOM and CRLF line endings", () => {
    const markdown =
      "\uFEFF---\r\n" +
      "version: 2.5.7\r\n" +
      "---\r\n" +
      "Body line\r\n";

    const parsed = parseEditorSystemPromptFrontmatter(markdown);

    expect(parsed.version).toBe("2.5.7");
    expect(parsed.body).toBe("Body line\r\n");
  });

  test("strips matching quotes from the version scalar", () => {
    const markdown =
      "---\n" + 'version: "1.2.3"\n' + "---\n" + "Body\n";

    expect(parseEditorSystemPromptFrontmatter(markdown).version).toBe(
      "1.2.3",
    );
  });

  test("throws when the frontmatter delimiter is missing", () => {
    expect(() =>
      parseEditorSystemPromptFrontmatter("# No frontmatter here\n"),
    ).toThrow(/frontmatter/i);
  });

  test("throws when the closing delimiter is missing", () => {
    expect(() =>
      parseEditorSystemPromptFrontmatter(
        "---\nversion: 1.0.0\n# never closed\n",
      ),
    ).toThrow(/closing/i);
  });

  test("throws when the version field is absent", () => {
    expect(() =>
      parseEditorSystemPromptFrontmatter(
        "---\nprompt: agents/editor/system.md\n---\nBody\n",
      ),
    ).toThrow(/version/);
  });

  test("rejects malformed frontmatter lines", () => {
    expect(() =>
      parseEditorSystemPromptFrontmatter(
        "---\nversion 1.0.0\n---\nBody\n",
      ),
    ).toThrow(/malformed/);
  });
});

// ---------------------------------------------------------------------------
// loadEditorAgentDefinition
// ---------------------------------------------------------------------------

describe("loadEditorAgentDefinition", () => {
  test("loads the on-disk editor system.md and config defaults via dependencies", () => {
    const fixture = makeCatalogueFixture();

    const definition = loadEditorAgentDefinition({
      tools: fixture.catalogue,
    });

    // Model id comes from `agent-harness.config.json` `models.editor`.
    expect(typeof definition.model).toBe("string");
    expect(definition.model.length).toBeGreaterThan(0);

    // System prompt version was parsed from the YAML frontmatter and
    // matches the value pinned in `system.md`.
    expect(definition.systemPromptVersion).toBe("1.0.0");

    // Body has the frontmatter stripped: it should not begin with `---`,
    // and should contain the section headers from the prompt.
    expect(definition.systemPrompt.startsWith("---")).toBe(false);
    expect(definition.systemPrompt).toContain(
      "# Editor agent — system prompt",
    );
    expect(definition.systemPrompt).toContain("## Tool access");

    // Tool catalogue passed through unchanged.
    expect(definition.tools).toBe(fixture.catalogue);
  });

  test("builds the catalogue from `dependencies` when no `tools` is provided", () => {
    const postDeployContext: PostDeployContext = {
      sessionId: "session-test-editor-agent-deps",
    };
    const postDeployRunner: PostDeployRunner = async () => ({
      outcome: "pass",
      report: {},
    });
    const definition = loadEditorAgentDefinition({
      dependencies: {
        postDeployRunner,
        postDeployContext,
        reviewerInvocation: new RecordedReviewerInvocation(),
      },
    });

    // The factory built the catalogue itself; it has the right size.
    expect(definition.tools).toHaveLength(EDITOR_TOOL_NAMES.length);
  });

  test("reads model id and system prompt from injected paths", async () => {
    const tempRoot = await fs.mkdtemp(
      join(tmpdir(), "agent-harness-editor-load-"),
    );
    try {
      const promptPath = join(tempRoot, "system.md");
      const configPath = join(tempRoot, "agent-harness.config.json");

      await fs.writeFile(
        promptPath,
        "---\nversion: 9.9.9\n---\nFixture body\n",
        "utf8",
      );
      await fs.writeFile(
        configPath,
        JSON.stringify({
          models: {
            editor: "anthropic.claude-sonnet-test-editor",
            reviewer: "anthropic.claude-sonnet-test-reviewer",
          },
        }),
        "utf8",
      );

      const fixture = makeCatalogueFixture();
      const definition = loadEditorAgentDefinition({
        systemPromptPath: promptPath,
        configPath,
        tools: fixture.catalogue,
      });

      expect(definition.model).toBe("anthropic.claude-sonnet-test-editor");
      expect(definition.systemPromptVersion).toBe("9.9.9");
      expect(definition.systemPrompt).toBe("Fixture body\n");
      expect(definition.tools).toBe(fixture.catalogue);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("throws when the config is missing the editor model id", async () => {
    const tempRoot = await fs.mkdtemp(
      join(tmpdir(), "agent-harness-editor-load-bad-"),
    );
    try {
      const promptPath = join(tempRoot, "system.md");
      const configPath = join(tempRoot, "agent-harness.config.json");
      await fs.writeFile(
        promptPath,
        "---\nversion: 1.0.0\n---\nBody\n",
        "utf8",
      );
      // Config missing models.editor.
      await fs.writeFile(
        configPath,
        JSON.stringify({ models: { reviewer: "x" } }),
        "utf8",
      );

      const fixture = makeCatalogueFixture();
      expect(() =>
        loadEditorAgentDefinition({
          systemPromptPath: promptPath,
          configPath,
          tools: fixture.catalogue,
        }),
      ).toThrow(/models\.editor/);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("throws when the config is not valid JSON", async () => {
    const tempRoot = await fs.mkdtemp(
      join(tmpdir(), "agent-harness-editor-load-badjson-"),
    );
    try {
      const promptPath = join(tempRoot, "system.md");
      const configPath = join(tempRoot, "agent-harness.config.json");
      await fs.writeFile(
        promptPath,
        "---\nversion: 1.0.0\n---\nBody\n",
        "utf8",
      );
      await fs.writeFile(configPath, "{ not json", "utf8");

      const fixture = makeCatalogueFixture();
      expect(() =>
        loadEditorAgentDefinition({
          systemPromptPath: promptPath,
          configPath,
          tools: fixture.catalogue,
        }),
      ).toThrow(/JSON/);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("throws when neither `tools` nor `dependencies` is supplied", () => {
    expect(() => loadEditorAgentDefinition({})).toThrow(
      /missing tool catalogue/i,
    );
  });

  test("throws when both `tools` and `dependencies` are supplied", () => {
    const fixture = makeCatalogueFixture();
    expect(() =>
      loadEditorAgentDefinition({
        tools: fixture.catalogue,
        dependencies: {
          postDeployRunner: async () => ({ outcome: "pass", report: {} }),
          postDeployContext: { sessionId: "session-x" },
          reviewerInvocation: new RecordedReviewerInvocation(),
        },
      }),
    ).toThrow(/either 'tools'.*'dependencies'/i);
  });
});

// ---------------------------------------------------------------------------
// buildEditorToolCatalogue
// ---------------------------------------------------------------------------

describe("buildEditorToolCatalogue", () => {
  test("returns 15 tools with the design's catalogue names in order", () => {
    const fixture = makeCatalogueFixture();

    const names = fixture.catalogue.map((t) => t.name);

    // The design's Tool catalogue table for the editor lists 15 tools.
    expect(fixture.catalogue).toHaveLength(15);
    expect(names).toEqual([...EDITOR_TOOL_NAMES]);
  });

  test("the catalogue is frozen and cannot be mutated by callers", () => {
    const fixture = makeCatalogueFixture();

    // Frozen arrays throw in strict mode when push() is attempted.
    expect(() => {
      (fixture.catalogue as unknown as Array<unknown>).push("smuggled-tool");
    }).toThrow();
  });

  test("each tool has a JSON schema for input and output", () => {
    const fixture = makeCatalogueFixture();
    for (const tool of fixture.catalogue) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
      expect(typeof tool.handler).toBe("function");
    }
  });

  test("does NOT include a tool to merge a PR (Requirement 2.3)", () => {
    const fixture = makeCatalogueFixture();
    const names = fixture.catalogue.map((t) => t.name);
    // Defence-in-depth assertion: the design forbids any merge tool. A
    // future refactor that accidentally added one would fail here.
    expect(names).not.toContain("pr.merge");
    expect(names.some((n) => /merge/i.test(n))).toBe(false);
  });

  test("does NOT include any tool with `prod`, `production`, or `live` in the name", () => {
    const fixture = makeCatalogueFixture();
    const forbidden = /(prod|production|live)/i;
    for (const tool of fixture.catalogue) {
      expect(tool.name).not.toMatch(forbidden);
    }
  });

  test("does NOT include any tool whose name implies repository-settings access", () => {
    const fixture = makeCatalogueFixture();
    const forbiddenNames = [
      "github.settings",
      "github.branchProtection",
      "github.secrets",
      "github.webhooks",
      "repo.settings",
    ];
    const names = new Set(fixture.catalogue.map((t) => t.name));
    for (const forbidden of forbiddenNames) {
      expect(names.has(forbidden)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Smoke test: write-then-read through the catalogued tools
// ---------------------------------------------------------------------------

describe("editor agent smoke test: writeFile -> readFile round trip", () => {
  test("contents written via module.writeFile match contents read via module.readFile", async () => {
    // realpathSync canonicalises the temp path so the wrapper's symlink
    // resolution doesn't trip on macOS's `/var` -> `/private/var`
    // symlink.
    const moduleRoot = realpathSync(
      await fs.mkdtemp(join(tmpdir(), "agent-harness-editor-smoke-")),
    );
    try {
      // Pre-create the lib/ directory: the writeFile wrapper does not
      // auto-create directories (matches `tools/module.ts`'s docs;
      // module structure is fixed by the steering file).
      await fs.mkdir(join(moduleRoot, "lib"));

      const sink = new InMemorySink();
      const runtime: WrapperRuntime = {
        moduleRoot,
        sessionSink: sink,
        sessionId: "session-test-editor-smoke",
        iterationIndex: 0,
      };

      const fixture = makeCatalogueFixture();

      // Pull module.writeFile and module.readFile out of the
      // catalogue (not the raw imports); this exercises the
      // catalogue-assembly path that production will use.
      const writeFile = getTool(fixture.catalogue, "module.writeFile");
      const readFile = getTool(fixture.catalogue, "module.readFile");

      const wrappedWrite = wrapTool(writeFile);
      const wrappedRead = wrapTool(readFile);

      const expectedContents = "export const counter = 42;\n";
      const writeResult = (await wrappedWrite(
        { path: "lib/counter.ts", contents: expectedContents } as unknown,
        runtime,
      )) as { written: boolean; newSha: string };

      expect(writeResult.written).toBe(true);
      expect(writeResult.newSha).toMatch(/^[0-9a-f]{64}$/);

      const readResult = (await wrappedRead(
        { path: "lib/counter.ts" } as unknown,
        runtime,
      )) as { contents: string; sha: string };

      expect(readResult.contents).toBe(expectedContents);
      // The SHA returned by readFile must match the SHA returned by
      // writeFile for the same bytes.
      expect(readResult.sha).toBe(writeResult.newSha);

      // The session sink recorded one ok record per call.
      expect(sink.records).toHaveLength(2);
      expect(sink.records[0]?.tool).toBe("module.writeFile");
      expect(sink.records[0]?.outcome).toBe("ok");
      expect(sink.records[1]?.tool).toBe("module.readFile");
      expect(sink.records[1]?.outcome).toBe("ok");

      // The bytes on disk match the bytes the agent thinks it wrote.
      const onDisk = await fs.readFile(
        join(moduleRoot, "lib", "counter.ts"),
        "utf8",
      );
      expect(onDisk).toBe(expectedContents);
    } finally {
      await fs.rm(moduleRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// EDITOR_TOOL_NAMES (sanity)
// ---------------------------------------------------------------------------

describe("EDITOR_TOOL_NAMES", () => {
  test("declares the 15 tools from the design's catalogue", () => {
    expect(EDITOR_TOOL_NAMES).toHaveLength(15);
    // Pin a few load-bearing names so a refactor that drops one is
    // caught here directly rather than via the catalogue test.
    expect(EDITOR_TOOL_NAMES).toContain("module.writeFile");
    expect(EDITOR_TOOL_NAMES).toContain("module.readFile");
    expect(EDITOR_TOOL_NAMES).toContain("cdk.deploy");
    expect(EDITOR_TOOL_NAMES).toContain("postDeploy.invoke");
    expect(EDITOR_TOOL_NAMES).toContain("reviewer.invoke");
    expect(EDITOR_TOOL_NAMES).toContain("pr.open");
  });

  test("is frozen", () => {
    expect(() => {
      (EDITOR_TOOL_NAMES as unknown as Array<string>).push("smuggled");
    }).toThrow();
  });
});
