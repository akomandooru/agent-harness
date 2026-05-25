/**
 * File-tool wrappers for the editor agent.
 *
 * Implements the four `module.*` tools from `design.md`'s tool catalogue:
 *   - `module.readFile`   `{path}` -> `{contents, sha}`
 *   - `module.writeFile`  `{path, contents}` -> `{written, newSha}`
 *   - `module.listFiles`  `{glob}` -> `{paths[]}`
 *   - `module.diff`       `{}` -> `{diff}` (text diff vs. base ref)
 *
 * The shared wrapper (`@agent-harness/shared`) handles input/output schema
 * validation, path-scope enforcement (when `pathField` is declared), session
 * logging, secret redaction, and cost accounting. This module wires those
 * pieces and provides handlers that perform the actual filesystem and git
 * work.
 *
 * Path-scope policy lives in two places by intent:
 *   - The wrapper's `validatePathScope` (for `pathField` tools): enforces
 *     module-root containment, `..` rejection, symlink-escape detection.
 *   - This file (for `module.listFiles`): enforces glob-pattern hygiene
 *     (no `..`, no absolute paths) plus a post-resolution containment check
 *     on every match. `listFiles` doesn't fit the `pathField` model because
 *     its input is a glob, not a single path, but the same security
 *     invariant must hold.
 *
 * The oversized-write guard is enforced here in the handler (`MAX_WRITE_BYTES`)
 * rather than in runtime config because it's a wrapper-layer policy: the
 * editor agent can't talk the wrapper into writing a 2 GiB file by passing
 * a different option, only by reaching the underlying filesystem directly,
 * which it cannot.
 *
 * SHA computation hashes file contents with SHA-256. The handler returns the
 * SHA on every read so the editor can detect concurrent modification before
 * issuing a `writeFile`; the wrapper does not enforce optimistic locking
 * itself (the editor is the only writer in a given iteration), but the SHA
 * is on the contract for the iteration after a deploy.
 */

import { exec as execCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import fg from "fast-glob";

import {
  PathScopeError,
  type ToolDefinition,
} from "@agent-harness/shared";

const exec = promisify(execCb);

/**
 * Maximum size of a single `module.writeFile` call, in bytes.
 *
 * 1 MiB. The reference module is sub-500 lines of TypeScript and the editor
 * works at file granularity; a real edit is kilobytes, not megabytes. This
 * is a runaway-write guard, not a tuning knob, so it lives as a constant
 * here rather than in `agent-harness.config.json`. If a forker's module
 * legitimately exceeds this, raise the constant and update the comment;
 * doing so is a code change, which is the point.
 */
export const MAX_WRITE_BYTES = 1024 * 1024;

/** Default base ref for `module.diff`. The editor compares against `HEAD`. */
const DEFAULT_DIFF_BASE_REF = "HEAD";

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

interface ReadFileInput {
  readonly path: string;
}

interface ReadFileOutput {
  readonly contents: string;
  readonly sha: string;
}

export const readFileTool: ToolDefinition<ReadFileInput, ReadFileOutput> = {
  name: "module.readFile",
  description: "Read a UTF-8 file inside the module root.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      contents: { type: "string" },
      sha: { type: "string", pattern: "^[0-9a-f]{64}$" },
    },
    required: ["contents", "sha"],
    additionalProperties: false,
  },
  pathField: "path",
  handler: async (_input, ctx) => {
    // The wrapper has already validated the path; `ctx.resolvedPath` is the
    // canonical absolute path inside `moduleRoot`.
    const absolute = ctx.resolvedPath as string;
    const buffer = await fs.readFile(absolute);
    const contents = buffer.toString("utf8");
    return {
      output: {
        contents,
        sha: sha256(buffer),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// writeFile
// ---------------------------------------------------------------------------

interface WriteFileInput {
  readonly path: string;
  readonly contents: string;
}

interface WriteFileOutput {
  readonly written: true;
  readonly newSha: string;
}

export const writeFileTool: ToolDefinition<WriteFileInput, WriteFileOutput> = {
  name: "module.writeFile",
  description: "Write a UTF-8 file inside the module root.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
      contents: { type: "string" },
    },
    required: ["path", "contents"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      written: { type: "boolean", const: true },
      newSha: { type: "string", pattern: "^[0-9a-f]{64}$" },
    },
    required: ["written", "newSha"],
    additionalProperties: false,
  },
  pathField: "path",
  handler: async (input, ctx) => {
    const absolute = ctx.resolvedPath as string;
    const buffer = Buffer.from(input.contents, "utf8");
    if (buffer.byteLength > MAX_WRITE_BYTES) {
      // Reuse `PathScopeError` here would be wrong (this isn't a path
      // problem), so let it surface as a handler error: the wrapper records
      // it under outcome `handler-error` with the size in the message.
      throw new Error(
        `module.writeFile rejected: contents (${buffer.byteLength} bytes) ` +
          `exceeds MAX_WRITE_BYTES (${MAX_WRITE_BYTES} bytes)`
      );
    }
    // The wrapper resolved the path inside the module root. We assume the
    // parent directory exists; we don't auto-create directories because the
    // module structure is fixed by the steering file and unexpected new
    // directories are usually a sign the agent has lost the plot.
    await fs.writeFile(absolute, buffer);
    return {
      output: {
        written: true,
        newSha: sha256(buffer),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// listFiles
// ---------------------------------------------------------------------------

interface ListFilesInput {
  readonly glob: string;
}

interface ListFilesOutput {
  readonly paths: string[];
}

export const listFilesTool: ToolDefinition<ListFilesInput, ListFilesOutput> = {
  name: "module.listFiles",
  description:
    "List files matching a glob, scoped to the module root. Returns paths " +
    "relative to the module root.",
  inputSchema: {
    type: "object",
    properties: {
      glob: { type: "string", minLength: 1 },
    },
    required: ["glob"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["paths"],
    additionalProperties: false,
  },
  // No `pathField`: the wrapper can't validate a glob the same way it
  // validates a single path. We do the equivalent enforcement here.
  handler: async (input, ctx) => {
    const moduleRoot = ctx.resolvedModuleRoot as string;
    const pattern = input.glob;

    // Glob-pattern hygiene: reject anything that could leak outside the
    // module root before we even invoke fast-glob.
    rejectUnsafeGlob(pattern);

    // fast-glob with `cwd: moduleRoot` confines matches to the module
    // tree. We still verify each match resolves inside the module root in
    // case fast-glob's behaviour ever changes or a future option is
    // mis-set; defence in depth.
    const matches = await fg(pattern, {
      cwd: moduleRoot,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      // Returning relative paths matches the spec'd output and keeps the
      // session record portable across machines.
      absolute: false,
      // Use forward slashes everywhere so the agent (and tests) get a
      // stable shape regardless of host OS.
      // fast-glob always returns forward slashes, but we normalise in the
      // verifier below to be sure.
    });

    const paths: string[] = [];
    for (const match of matches) {
      const absolute = resolve(moduleRoot, match);
      if (!isWithinRoot(absolute, moduleRoot)) {
        // A match somehow resolved outside the root; treat as a path-scope
        // violation rather than swallowing.
        throw new PathScopeError(
          "module.listFiles",
          `glob match resolves outside module root: ${absolute}`
        );
      }
      // Normalise to forward slashes and compute relative-to-root.
      const rel = relative(moduleRoot, absolute).split(sep).join("/");
      paths.push(rel);
    }
    // Sort for deterministic output; agents and tests both benefit.
    paths.sort();
    return { output: { paths } };
  },
};

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

interface DiffInput {
  // Empty by design; the diff is always against the configured base ref.
}

interface DiffOutput {
  readonly diff: string;
}

export const diffTool: ToolDefinition<DiffInput, DiffOutput> = {
  name: "module.diff",
  description:
    "Return a text diff of the module's working tree vs. the base git ref.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      diff: { type: "string" },
    },
    required: ["diff"],
    additionalProperties: false,
  },
  // No `pathField`; the diff command takes no path argument from the agent.
  handler: async (_input, ctx) => {
    const moduleRoot = ctx.resolvedModuleRoot as string;
    // `git diff <base>` includes both staged and unstaged working-tree
    // changes; the editor and reviewer want the full picture of what the
    // current iteration would land. Limit to the module root via pathspec
    // so unrelated repository changes (e.g., spec edits) don't bleed in.
    const args = [
      "diff",
      "--no-color",
      "--no-ext-diff",
      DEFAULT_DIFF_BASE_REF,
      "--",
      ".",
    ];
    const { stdout } = await exec(`git ${args.join(" ")}`, {
      cwd: moduleRoot,
      // Diffs of even a moderate module can be hundreds of KiB. Allow up
      // to 10 MiB, well above realistic iteration deltas.
      maxBuffer: 10 * 1024 * 1024,
    });
    return { output: { diff: stdout } };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Reject globs that could leak outside the module root.
 *
 * The wrapper's `validatePathScope` does the same job for single paths;
 * this is the glob-shaped equivalent. Rejection categories:
 *   - absolute paths (Unix `/foo/bar`, Windows `C:\foo\bar`)
 *   - any segment equal to `..`
 *   - leading `~` (tilde expansion would go outside the module)
 *   - NUL bytes
 */
function rejectUnsafeGlob(pattern: string): void {
  if (pattern.includes("\0")) {
    throw new PathScopeError(
      "module.listFiles",
      "glob must not contain NUL bytes"
    );
  }
  if (pattern.startsWith("~")) {
    throw new PathScopeError(
      "module.listFiles",
      `glob must not begin with '~': ${pattern}`
    );
  }
  if (isAbsolute(pattern)) {
    throw new PathScopeError(
      "module.listFiles",
      `glob must not be an absolute path: ${pattern}`
    );
  }
  // Normalise both separator styles before splitting so Windows-style globs
  // (`lib\\foo\\..\\bar`) are caught as well as Unix-style.
  const normalised = pattern.replace(/\\/g, "/");
  if (normalised.split("/").some((segment) => segment === "..")) {
    throw new PathScopeError(
      "module.listFiles",
      `glob must not contain '..' segments: ${pattern}`
    );
  }
}

/** Lexical containment check, mirroring `path-scope.ts`. */
function isWithinRoot(absolute: string, moduleRoot: string): boolean {
  const a = trimTrailingSep(absolute);
  const r = trimTrailingSep(moduleRoot);
  if (a === r) return true;
  return a.startsWith(r + sep);
}

function trimTrailingSep(p: string): string {
  if (p.length > 1 && p.endsWith(sep)) return p.slice(0, -1);
  return p;
}
