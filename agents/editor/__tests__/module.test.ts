/**
 * Unit tests for the `module.*` file-tool wrappers.
 *
 * Covers the verification matrix from tasks.md task 3.2:
 *   - Happy paths for all four tools.
 *   - readFile rejects out-of-scope paths (handled by the shared wrapper;
 *     we confirm rejection happens, no need to re-test wrapper internals).
 *   - writeFile rejects oversized writes.
 *   - listFiles rejects globs containing `..` or absolute paths.
 *   - listFiles returns paths relative to the module root.
 *   - diff returns the text diff vs. the base ref (fixture git repo).
 *   - SHA computation matches a known fixture.
 *
 * Each test creates a temp module root populated with fixture files and
 * points `WrapperRuntime.moduleRoot` at it, exactly the way the runtime
 * harness will at deploy time. No mocks; the wrappers run against real
 * filesystem and git.
 */

import { exec as execCb } from "node:child_process";
import { createHash } from "node:crypto";
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
  MAX_WRITE_BYTES,
  diffTool,
  listFilesTool,
  readFileTool,
  writeFileTool,
} from "../tools/module";

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
  // realpathSync canonicalises the temp path so the wrapper's symlink
  // resolution doesn't trip on macOS's `/var` -> `/private/var` symlink.
  const base = realpathSync(
    await fs.mkdtemp(join(tmpdir(), "agent-harness-editor-"))
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
  // Windows can hold a transient lock on freshly-touched files (especially
  // git's `.git/objects/pack`), causing EBUSY on the first rmdir. Retry a
  // handful of times before giving up.
  const attempts = 5;
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 5 });
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
  contents: string
): Promise<void> {
  const absolute = join(root, relPath);
  await fs.mkdir(join(absolute, ".."), { recursive: true });
  await fs.writeFile(absolute, contents, "utf8");
}

/**
 * Initialise a git repo at `root`, configure local user, and commit the
 * existing tree. After this, `git diff HEAD` returns the empty diff against
 * a clean working tree.
 */
async function gitInit(root: string): Promise<void> {
  await exec("git init -q -b main", { cwd: root });
  await exec(`git config user.email "test@example.com"`, { cwd: root });
  await exec(`git config user.name "Test"`, { cwd: root });
  // Disable signing so the commit lands without GPG configured.
  await exec("git config commit.gpgsign false", { cwd: root });
  await exec("git add -A", { cwd: root });
  await exec(`git commit -q -m "initial"`, { cwd: root });
}

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

describe("module.readFile", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(async () => {
    await cleanup(fixture);
  });

  it("returns contents and SHA-256 for a file inside the module root", async () => {
    const contents = "export const x = 1;\n";
    await writeFixtureFile(fixture.root, "lib/x.ts", contents);

    const wrapped = wrapTool(readFileTool);
    const result = await wrapped({ path: "lib/x.ts" }, fixture.runtime);

    expect(result.contents).toBe(contents);
    expect(result.sha).toBe(
      createHash("sha256").update(Buffer.from(contents, "utf8")).digest("hex")
    );
    expect(fixture.sink.records[0]?.outcome).toBe("ok");
  });

  it("computes the SHA for a known fixture as expected", async () => {
    // Known fixture: the SHA-256 of "hello\n" is well-defined.
    await writeFixtureFile(fixture.root, "hello.txt", "hello\n");
    const expectedSha = createHash("sha256")
      .update(Buffer.from("hello\n", "utf8"))
      .digest("hex");

    const wrapped = wrapTool(readFileTool);
    const result = await wrapped({ path: "hello.txt" }, fixture.runtime);

    expect(result.sha).toBe(expectedSha);
    // Sanity: the canonical SHA-256 of "hello\n" is fixed across all
    // implementations. Pin the literal to catch any future regression in
    // the hashing helper.
    expect(result.sha).toBe(
      "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
    );
  });

  it("rejects out-of-scope paths via the shared wrapper", async () => {
    const wrapped = wrapTool(readFileTool);

    await expect(
      wrapped({ path: "../escape.ts" }, fixture.runtime)
    ).rejects.toBeInstanceOf(PathScopeError);

    expect(fixture.sink.records[0]?.outcome).toBe("path-scope-error");
  });
});

// ---------------------------------------------------------------------------
// writeFile
// ---------------------------------------------------------------------------

describe("module.writeFile", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(async () => {
    await cleanup(fixture);
  });

  it("writes a new file and returns the new SHA", async () => {
    const wrapped = wrapTool(writeFileTool);
    const contents = "export const y = 2;\n";
    // Pre-create the parent directory: the wrapper's path validator
    // resolves the realpath of the parent, which has to exist. The
    // handler intentionally doesn't auto-create directories (see comment
    // in tools/module.ts) — module structure is fixed by the steering
    // file, and unexpected new directories are usually a sign the agent
    // has lost the plot.
    await fs.mkdir(join(fixture.root, "lib"));

    const result = await wrapped(
      { path: "lib/y.ts", contents },
      fixture.runtime
    );

    expect(result.written).toBe(true);
    expect(result.newSha).toBe(
      createHash("sha256").update(Buffer.from(contents, "utf8")).digest("hex")
    );
    const onDisk = await fs.readFile(join(fixture.root, "lib/y.ts"), "utf8");
    expect(onDisk).toBe(contents);
    expect(fixture.sink.records[0]?.outcome).toBe("ok");
  });

  it("overwrites an existing file", async () => {
    await writeFixtureFile(fixture.root, "a.ts", "old\n");
    const wrapped = wrapTool(writeFileTool);

    await wrapped({ path: "a.ts", contents: "new\n" }, fixture.runtime);

    const onDisk = await fs.readFile(join(fixture.root, "a.ts"), "utf8");
    expect(onDisk).toBe("new\n");
  });

  it("rejects writes larger than MAX_WRITE_BYTES", async () => {
    const wrapped = wrapTool(writeFileTool);
    const tooLarge = "x".repeat(MAX_WRITE_BYTES + 1);

    await expect(
      wrapped({ path: "big.ts", contents: tooLarge }, fixture.runtime)
    ).rejects.toThrow(/exceeds MAX_WRITE_BYTES/);

    expect(fixture.sink.records[0]?.outcome).toBe("handler-error");
    // Confirm nothing landed on disk when the wrapper rejects.
    await expect(
      fs.access(join(fixture.root, "big.ts"))
    ).rejects.toThrow();
  });

  it("accepts writes exactly at the limit", async () => {
    const wrapped = wrapTool(writeFileTool);
    const atLimit = "x".repeat(MAX_WRITE_BYTES);

    const result = await wrapped(
      { path: "max.ts", contents: atLimit },
      fixture.runtime
    );

    expect(result.written).toBe(true);
  });

  it("rejects out-of-scope paths via the shared wrapper", async () => {
    const wrapped = wrapTool(writeFileTool);

    await expect(
      wrapped(
        { path: "../escape.ts", contents: "hi" },
        fixture.runtime
      )
    ).rejects.toBeInstanceOf(PathScopeError);
  });
});

// ---------------------------------------------------------------------------
// listFiles
// ---------------------------------------------------------------------------

describe("module.listFiles", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
    // Populate a small tree.
    await writeFixtureFile(fixture.root, "lib/a.ts", "// a\n");
    await writeFixtureFile(fixture.root, "lib/b.ts", "// b\n");
    await writeFixtureFile(fixture.root, "test/a.test.ts", "// test\n");
    await writeFixtureFile(fixture.root, "README.md", "# readme\n");
  });

  afterEach(async () => {
    await cleanup(fixture);
  });

  it("returns paths relative to the module root, sorted, with forward slashes", async () => {
    const wrapped = wrapTool(listFilesTool);

    const result = await wrapped({ glob: "**/*.ts" }, fixture.runtime);

    expect(result.paths).toEqual([
      "lib/a.ts",
      "lib/b.ts",
      "test/a.test.ts",
    ]);
    // No path starts with `/` or a drive letter — these are relative.
    for (const p of result.paths) {
      expect(p.startsWith("/")).toBe(false);
      expect(/^[A-Za-z]:/.test(p)).toBe(false);
    }
  });

  it("returns an empty array when no files match", async () => {
    const wrapped = wrapTool(listFilesTool);

    const result = await wrapped({ glob: "**/*.go" }, fixture.runtime);

    expect(result.paths).toEqual([]);
  });

  it("rejects globs containing '..'", async () => {
    const wrapped = wrapTool(listFilesTool);

    await expect(
      wrapped({ glob: "../**/*" }, fixture.runtime)
    ).rejects.toBeInstanceOf(PathScopeError);

    // The wrapper preserves the outcome on `ToolWrapperError` subclasses,
    // so `path-scope-error` (not `handler-error`) is logged even though
    // the rejection happened inside the handler.
    expect(fixture.sink.records[0]?.outcome).toBe("path-scope-error");
    expect(fixture.sink.records[0]?.error).toMatch(/\.\./);
  });

  it("rejects globs that are absolute Unix paths", async () => {
    const wrapped = wrapTool(listFilesTool);

    await expect(
      wrapped({ glob: "/etc/**" }, fixture.runtime)
    ).rejects.toBeInstanceOf(PathScopeError);
  });

  it("rejects globs that begin with `~`", async () => {
    const wrapped = wrapTool(listFilesTool);

    await expect(
      wrapped({ glob: "~/secrets/**" }, fixture.runtime)
    ).rejects.toBeInstanceOf(PathScopeError);
  });

  it("rejects backslash-style `..` segments", async () => {
    const wrapped = wrapTool(listFilesTool);

    await expect(
      wrapped({ glob: "lib\\..\\..\\etc" }, fixture.runtime)
    ).rejects.toBeInstanceOf(PathScopeError);
  });
});

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

describe("module.diff", () => {
  // Git init + four git commands per `beforeEach` can take a while on
  // Windows, where each `git` invocation spins up a new process. Bump the
  // per-test timeout above Jest's 5 s default.
  jest.setTimeout(30000);

  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
    // Seed a baseline file and commit it; subsequent edits show up in `git
    // diff HEAD`.
    await writeFixtureFile(fixture.root, "lib/a.ts", "export const a = 1;\n");
    await gitInit(fixture.root);
  });

  afterEach(async () => {
    await cleanup(fixture);
  });

  it("returns an empty diff against a clean working tree", async () => {
    const wrapped = wrapTool(diffTool);

    const result = await wrapped({}, fixture.runtime);

    expect(result.diff).toBe("");
    expect(fixture.sink.records[0]?.outcome).toBe("ok");
  });

  it("returns the text diff after a working-tree edit", async () => {
    await fs.writeFile(
      join(fixture.root, "lib/a.ts"),
      "export const a = 2;\n",
      "utf8"
    );

    const wrapped = wrapTool(diffTool);
    const result = await wrapped({}, fixture.runtime);

    // Don't pin the full diff text (git's exact whitespace varies by
    // version); assert the meaningful parts.
    expect(result.diff).toMatch(/diff --git a\/lib\/a\.ts b\/lib\/a\.ts/);
    expect(result.diff).toMatch(/-export const a = 1;/);
    expect(result.diff).toMatch(/\+export const a = 2;/);
  });

  it("includes new untracked files when staged via git add", async () => {
    // Untracked files don't appear in `git diff HEAD` until staged. The
    // wrapper's contract leaves staging to the editor (which uses
    // writeFile + a separate git plumbing path); this test pins that
    // behaviour so a future change to include `--no-renames --` etc. is a
    // conscious decision.
    await writeFixtureFile(fixture.root, "lib/b.ts", "export const b = 3;\n");
    await exec("git add lib/b.ts", { cwd: fixture.root });

    const wrapped = wrapTool(diffTool);
    const result = await wrapped({}, fixture.runtime);

    expect(result.diff).toMatch(/diff --git a\/lib\/b\.ts b\/lib\/b\.ts/);
    expect(result.diff).toMatch(/\+export const b = 3;/);
  });
});
