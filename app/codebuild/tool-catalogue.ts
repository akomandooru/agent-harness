/**
 * CodeBuild tool catalogue — registers module filesystem tools with
 * underscore naming convention for Bedrock's tool naming requirements.
 *
 * The catalogue exposes exactly three tools:
 *   - `module_readFile`  — reads a file relative to the module root
 *   - `module_writeFile` — writes a file relative to the module root
 *   - `module_listFiles` — lists files matching a glob pattern
 *
 * Unregistered tool names produce an error toolResult with
 * "Tool not registered: {toolName}".
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import fg from "fast-glob";

import { MapToolCatalogue, type ToolHandler } from "../orchestrator/tool-executor";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

interface ReadFileInput {
  readonly path: string;
}

interface ListFilesInput {
  readonly pattern?: string;
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Resolve a relative path against the module root and ensure it stays
 * within the root directory (prevents directory traversal).
 */
function resolveAndValidate(moduleRoot: string, filePath: string): string {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("path is required and must be a non-empty string");
  }

  // Reject absolute paths
  if (filePath.startsWith("/") || /^[a-zA-Z]:/.test(filePath)) {
    throw new Error(`path must be relative to module root: ${filePath}`);
  }

  // Reject paths with .. segments
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new Error(`path must not contain '..' segments: ${filePath}`);
  }

  const absolute = resolve(moduleRoot, filePath);

  // Verify resolved path is within the module root
  const rel = relative(moduleRoot, absolute);
  if (rel.startsWith("..") || rel.startsWith(`.${sep}`)) {
    throw new Error(`path resolves outside module root: ${filePath}`);
  }

  return absolute;
}

// ---------------------------------------------------------------------------
// Tool handler factories
// ---------------------------------------------------------------------------

function createReadFileHandler(moduleRoot: string): ToolHandler {
  return async (input: unknown) => {
    const { path: filePath } = input as ReadFileInput;
    const absolute = resolveAndValidate(moduleRoot, filePath);
    const content = readFileSync(absolute, "utf8");
    return { content, path: filePath };
  };
}

function createWriteFileHandler(moduleRoot: string): ToolHandler {
  return async (input: unknown) => {
    const raw = input as Record<string, unknown>;
    // The model may send content as "content" or "contents" (plural)
    const filePath = (raw.path ?? raw.file_path ?? raw.filePath) as string | undefined;
    const content = (raw.content ?? raw.contents ?? raw.file_content ?? raw.text) as string | undefined;

    if (!filePath) {
      throw new Error("path is required");
    }

    if (content === undefined || content === null) {
      // Log the raw input for debugging
      console.log(`[module_writeFile] content missing. Raw input keys: ${Object.keys(raw).join(", ")}. Raw: ${JSON.stringify(raw).slice(0, 200)}`);
      throw new Error("content is required");
    }

    const absolute = resolveAndValidate(moduleRoot, filePath);

    // Ensure parent directories exist
    const dir = resolve(absolute, "..");
    mkdirSync(dir, { recursive: true });

    writeFileSync(absolute, content, "utf8");
    return { written: true, path: filePath };
  };
}

function createListFilesHandler(moduleRoot: string): ToolHandler {
  return async (input: unknown) => {
    const { pattern } = (input ?? {}) as ListFilesInput;
    const globPattern = pattern || "**/*";

    const matches = await fg(globPattern, {
      cwd: moduleRoot,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      absolute: false,
    });

    // Normalise to forward slashes and sort for deterministic output
    const paths = matches
      .map((m) => m.split(sep).join("/"))
      .sort();

    return { paths };
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a MapToolCatalogue with exactly three module filesystem tools
 * registered using underscore naming convention.
 */
export function createCodeBuildToolCatalogue(options: { moduleRoot: string }): MapToolCatalogue {
  const catalogue = new MapToolCatalogue();

  catalogue.register("module_readFile", createReadFileHandler(options.moduleRoot));
  catalogue.register("module_writeFile", createWriteFileHandler(options.moduleRoot));
  catalogue.register("module_listFiles", createListFilesHandler(options.moduleRoot));

  return catalogue;
}
