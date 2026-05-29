/**
 * Unit tests for the reviewer's tool catalogue.
 *
 * Covers the verification matrix from tasks.md task 5.3:
 *   - All three catalogue tools are present with the right names.
 *   - `referenceChecklistTool` returns `{items}` for `Security` and
 *     `Reliability`; throws for unknown pillars (`UnknownPillarError`
 *     surfaced as a `handler-error` outcome by the shared wrapper).
 *   - `registerTool` accepts catalogue tool names and rejects others.
 *     Rejection cases include `module.writeFile`, `cdk.deploy`,
 *     `pr.open`, and other write/deploy/PR surface that must never reach
 *     the reviewer.
 *   - The catalogue does not include any writeFile, listFiles, cdk,
 *     sensor, preview, or pr tools.
 *   - `module.readFile` and `module.diff` retain read-only behaviour
 *     (smoke-tested via the wrapper using the same fixture pattern as
 *     the editor's tests).
 *
 * The tests run the catalogue through the shared wrapper (`wrapTool`) so
 * the schema validation, path-scope enforcement, and session logging
 * paths are exercised end-to-end. No mocks; the tools run against a real
 * temp directory.
 */

import { exec as execCb } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  PathScopeError,
  wrapTool,
  type SessionSink,
  type ToolInvocationRecord,
  type WrapperRuntime,
} from "@agent-harness/shared";

import {
  REVIEWER_TOOL_NAMES,
  UnknownToolError,
  diffTool,
  readFileTool,
  referenceChecklistTool,
  registerTool,
  reviewerToolCatalogue,
} from "../tools";

const exec = promisify(execCb);

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

class InMemorySink implements SessionSink {
  public records: ToolInvocationRecord[] = [];
  public async appendToolRecord(record: ToolInvocationRecord): Promise<void> {
    this.records.push(record);
  }
}

interface Fixture {
  readonly root: string;
  readonly sink: InMemorySink;
  readonly runtime: WrapperRuntime;
}

async function makeFixture(): Promise<Fixture> {
  // realpath the temp dir so the wrapper's symlink resolution doesn't trip
  // on macOS's `/var` -> `/private/var` symlink.
  const base = realpathSync(
    await fs.mkdtemp(join(tmpdir(), "agent-harness-reviewer-")),
  );
  const sink = new InMemorySink();
  const runtime: WrapperRuntime = {
    moduleRoot: base,
    sessionSink: sink,
    sessionId: "session-test",
    iterationIndex: 0,
  };
  return { root: base, sink, runtime };
}

async function cleanup(fixture: Fixture): Promise<void> {
  // Windows can hold transient locks on freshly-touched files (especially
  // git's pack files). Retry a handful of times before giving up; mirrors
  // the editor's test cleanup.
  const attempts = 5;
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rm(fixture.root, {
        recursive: true,
        force: true,
        maxRetries: 5,
      });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function writeFixtureFile(
  root: string,
  relPath: string,
  contents: string,
): Promise<void> {
  const absolute = join(root, relPath);
  await fs.mkdir(join(absolute, ".."), { recursive: true });
  await fs.writeFile(absolute, contents, "utf8");
}

async function gitInit(root: string): Promise<void> {
  await exec("git init -q -b main", { cwd: root });
  await exec(`git config user.email "test@example.com"`, { cwd: root });
  await exec(`git config user.name "Test"`, { cwd: root });
  await exec("git config commit.gpgsign false", { cwd: root });
  await exec("git add -A", { cwd: root });
  await exec(`git commit -q -m "initial"`, { cwd: root });
}

// ---------------------------------------------------------------------------
// Catalogue declaration
// ---------------------------------------------------------------------------

describe("reviewerToolCatalogue", () => {
  test("contains exactly the three reviewer tools by name", () => {
    const names = reviewerToolCatalogue.map((tool) => tool.name).sort();
    expect(names).toEqual(
      ["module.diff", "module.readFile", "reference.checklist"].sort(),
    );
  });

  test("REVIEWER_TOOL_NAMES matches the catalogue", () => {
    const fromCatalogue = new Set(
      reviewerToolCatalogue.map((tool) => tool.name),
    );
    expect(REVIEWER_TOOL_NAMES).toEqual(fromCatalogue);
  });

  test("named exports correspond to the catalogue entries", () => {
    expect(readFileTool.name).toBe("module.readFile");
    expect(diffTool.name).toBe("module.diff");
    expect(referenceChecklistTool.name).toBe("reference.checklist");

    const namesInCatalogue = new Set(
      reviewerToolCatalogue.map((tool) => tool.name),
    );
    expect(namesInCatalogue.has(readFileTool.name)).toBe(true);
    expect(namesInCatalogue.has(diffTool.name)).toBe(true);
    expect(namesInCatalogue.has(referenceChecklistTool.name)).toBe(true);
  });

  test("the catalogue is a strict subset of the editor's surface", () => {
    // The reviewer's catalogue must not include any write, list, cdk,
    // sensor, preview, post-deploy, or PR tools. Encoding this as a
    // negative test catches the failure mode the task brief calls out
    // ("don't accidentally include write tools") even if a future change
    // imports them by name.
    const forbiddenSubstrings = [
      "writeFile",
      "listFiles",
      "cdk.",
      "sensor.",
      "preview.",
      "postDeploy.",
      "pr.",
      "reviewer.",
    ];
    for (const tool of reviewerToolCatalogue) {
      for (const forbidden of forbiddenSubstrings) {
        expect(tool.name).not.toContain(forbidden);
      }
    }
  });

  test("each catalogue tool declares input and output schemas", () => {
    // Every tool that flows through `wrapTool` needs both schemas; assert
    // here so a future refactor that strips a schema is caught at the
    // catalogue layer rather than only in the wrapper.
    for (const tool of reviewerToolCatalogue) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
    }
  });

  test("only the read-side path tool declares pathField", () => {
    // `module.readFile` is the only catalogue tool with a path argument;
    // `module.diff` and `reference.checklist` take no paths. If a future
    // change adds a path field to the wrong tool, the wrapper's path
    // validator runs against a non-path input and the bug is hard to spot.
    const byName = new Map(reviewerToolCatalogue.map((t) => [t.name, t]));
    expect(byName.get("module.readFile")?.pathField).toBe("path");
    expect(byName.get("module.diff")?.pathField).toBeUndefined();
    expect(byName.get("reference.checklist")?.pathField).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// registerTool
// ---------------------------------------------------------------------------

describe("registerTool", () => {
  test.each([
    "module.readFile",
    "module.diff",
    "reference.checklist",
  ])("accepts catalogue tool name %s and returns the matching definition", (name) => {
    const tool = registerTool(name);
    expect(tool.name).toBe(name);
  });

  test.each([
    // Editor-only write surface. Must never reach the reviewer.
    "module.writeFile",
    "module.listFiles",
    // Editor-only deploy surface.
    "cdk.diff",
    "cdk.deploy",
    // Editor-only sensor surface (sensors run for the editor's benefit).
    "sensor.cdkNag",
    "sensor.tsc",
    "sensor.eslint",
    "sensor.unitTests",
    // Editor-only observation surface.
    "preview.cwLogs",
    "preview.cwMetrics",
    // Editor-only post-deploy and PR surface.
    "postDeploy.invoke",
    "pr.open",
    // Reviewer cannot recursively invoke itself.
    "reviewer.invoke",
    // Made-up names; rejection must be by membership, not by string match.
    "shell.exec",
    "github.commentOnIssue",
    "",
    // Case-sensitive: registered names are exact strings, not folded.
    "Module.readFile",
    "MODULE.READFILE",
  ])("rejects non-catalogue name %s", (name) => {
    expect(() => registerTool(name)).toThrow(UnknownToolError);
  });

  test("UnknownToolError names the offending tool and lists the allowed set", () => {
    try {
      registerTool("module.writeFile");
      throw new Error("expected registerTool to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownToolError);
      expect((err as UnknownToolError).tool).toBe("module.writeFile");
      const message = (err as Error).message;
      expect(message).toContain("module.writeFile");
      expect(message).toContain("module.readFile");
      expect(message).toContain("module.diff");
      expect(message).toContain("reference.checklist");
    }
  });

  test("the catalogue is frozen against runtime mutation", () => {
    // Strict mode in TypeScript triggers a TypeError on assignment to a
    // frozen array. Casting away `readonly` mimics what a forker might
    // do by mistake; the freeze is what stops the mutation from landing.
    const mutableView = reviewerToolCatalogue as unknown as Array<unknown>;
    expect(() => {
      mutableView.push({ name: "evil.write" });
    }).toThrow(TypeError);
    // The catalogue length is unchanged after the failed push.
    expect(reviewerToolCatalogue).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// reference.checklist
// ---------------------------------------------------------------------------

describe("reference.checklist", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(async () => {
    await cleanup(fixture);
  });

  test("returns Security checklist items for `Security`", async () => {
    const wrapped = wrapTool(referenceChecklistTool);

    const result = await wrapped({ pillar: "Security" }, fixture.runtime);

    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.pillar).toBe("Security");
    }
    expect(fixture.sink.records[0]?.outcome).toBe("ok");
  });

  test("returns Reliability checklist items for `Reliability`", async () => {
    const wrapped = wrapTool(referenceChecklistTool);

    const result = await wrapped({ pillar: "Reliability" }, fixture.runtime);

    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.pillar).toBe("Reliability");
    }
  });

  test("returns an empty array for a recognised but unpopulated pillar", async () => {
    const wrapped = wrapTool(referenceChecklistTool);

    const result = await wrapped(
      { pillar: "Cost Optimization" },
      fixture.runtime,
    );

    expect(result.items).toEqual([]);
    expect(fixture.sink.records[0]?.outcome).toBe("ok");
  });

  test("rejects unknown pillar names with a handler-error outcome", async () => {
    const wrapped = wrapTool(referenceChecklistTool);

    await expect(
      wrapped({ pillar: "Resilience" }, fixture.runtime),
    ).rejects.toThrow(/Unknown Well-Architected pillar/);

    // The shared wrapper records the call as a `handler-error` because
    // `getChecklist` throws synchronously rather than a wrapper-class
    // rejection.
    expect(fixture.sink.records[0]?.outcome).toBe("handler-error");
  });

  test("rejects empty pillar input via the input schema", async () => {
    const wrapped = wrapTool(referenceChecklistTool);

    // The schema requires `pillar` to be a non-empty string. The wrapper
    // rejects before the handler runs.
    await expect(
      wrapped({ pillar: "" }, fixture.runtime),
    ).rejects.toThrow(/input schema rejected/);

    expect(fixture.sink.records[0]?.outcome).toBe("input-schema-error");
  });

  test("rejects extra input properties via the input schema", async () => {
    const wrapped = wrapTool(referenceChecklistTool);

    await expect(
      wrapped(
        { pillar: "Security", extra: "no" } as unknown as { pillar: string },
        fixture.runtime,
      ),
    ).rejects.toThrow(/input schema rejected/);
  });
});

// ---------------------------------------------------------------------------
// module.readFile (read-only smoke)
// ---------------------------------------------------------------------------

describe("module.readFile (reviewer-side)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(async () => {
    await cleanup(fixture);
  });

  test("returns contents and SHA-256 for a file inside the module root", async () => {
    const contents = "export const x = 1;\n";
    await writeFixtureFile(fixture.root, "lib/x.ts", contents);

    const wrapped = wrapTool(readFileTool);
    const result = await wrapped({ path: "lib/x.ts" }, fixture.runtime);

    expect(result.contents).toBe(contents);
    expect(result.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.sink.records[0]?.outcome).toBe("ok");
  });

  test("rejects out-of-scope paths via the shared wrapper", async () => {
    const wrapped = wrapTool(readFileTool);

    await expect(
      wrapped({ path: "../escape.ts" }, fixture.runtime),
    ).rejects.toBeInstanceOf(PathScopeError);

    expect(fixture.sink.records[0]?.outcome).toBe("path-scope-error");
  });
});

// ---------------------------------------------------------------------------
// module.diff (read-only smoke)
// ---------------------------------------------------------------------------

describe("module.diff (reviewer-side)", () => {
  // git init + four git commands per `beforeEach` is slow on Windows;
  // bump the per-test timeout the same way the editor's tests do.
  jest.setTimeout(30000);

  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
    await writeFixtureFile(fixture.root, "lib/a.ts", "export const a = 1;\n");
    await gitInit(fixture.root);
  });

  afterEach(async () => {
    await cleanup(fixture);
  });

  test("returns an empty diff against a clean working tree", async () => {
    const wrapped = wrapTool(diffTool);

    const result = await wrapped({}, fixture.runtime);

    expect(result.diff).toBe("");
    expect(fixture.sink.records[0]?.outcome).toBe("ok");
  });

  test("returns the text diff after a working-tree edit", async () => {
    await fs.writeFile(
      join(fixture.root, "lib/a.ts"),
      "export const a = 2;\n",
      "utf8",
    );

    const wrapped = wrapTool(diffTool);
    const result = await wrapped({}, fixture.runtime);

    expect(result.diff).toMatch(/diff --git a\/lib\/a\.ts b\/lib\/a\.ts/);
    expect(result.diff).toMatch(/-export const a = 1;/);
    expect(result.diff).toMatch(/\+export const a = 2;/);
  });
});
