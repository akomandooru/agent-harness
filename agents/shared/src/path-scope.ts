/**
 * Path-scope enforcement.
 *
 * Implements Property 4 from `design.md`: no `module.writeFile` (and no other
 * file-touching tool) lands outside `module.path`, regardless of input.
 *
 * The check is the wrapper layer's defence-in-depth for Requirements 2.3
 * and 9.1/9.2. The IAM policy is the outer ring; this is the inner ring.
 *
 * The four rejection conditions, in order:
 *   1. Empty / non-string / absolute paths that fall outside the module root.
 *   2. Paths containing `..` segments (rejected before resolution; we don't
 *      want to rely on the resolver to flatten them).
 *   3. Paths that, once resolved (real path, including symlink resolution),
 *      do not have the module root as a prefix.
 *   4. Paths whose components are symlinks pointing outside the module root.
 *      Caught by the realpath resolution in step 3.
 *
 * Design note: we deliberately reject paths that don't yet exist *only* if
 * they fail one of the structural checks (1, 2). For step 3 we tolerate
 * "ENOENT" by resolving the parent directory and checking it; this lets
 * `module.writeFile` create new files. The parent must exist and must be
 * inside the module root.
 */

import { dirname, isAbsolute, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

import { PathScopeError } from "./errors";

/** Default real-path resolver. Tests inject a fake. */
const defaultResolver = (absolute: string): string => realpathSync.native(absolute);

/**
 * Validate that `pathArg` is inside `moduleRoot` and return the resolved
 * absolute path. Throws `PathScopeError` if any check fails.
 *
 * @param tool The tool name (for error messages).
 * @param moduleRoot Absolute, already-resolved module root. Caller must
 *                   ensure this is canonical (the orchestrator does).
 * @param pathArg The candidate path from the agent's tool call. Treated as
 *                untrusted: may be relative, absolute, contain `..`, or
 *                refer to a symlink.
 * @param resolver Optional path resolver. Defaults to `realpathSync.native`.
 *                 Tests use a stub.
 */
export function validatePathScope(
  tool: string,
  moduleRoot: string,
  pathArg: unknown,
  resolver: (absolutePath: string) => string = defaultResolver
): string {
  // Step 1: structural checks on the raw input.
  if (typeof pathArg !== "string") {
    throw new PathScopeError(tool, `path must be a string, got ${typeof pathArg}`);
  }
  if (pathArg.length === 0) {
    throw new PathScopeError(tool, "path must not be empty");
  }
  // Reject NUL bytes; these can confuse OS path handling and have no
  // legitimate use in source-tree paths.
  if (pathArg.includes("\0")) {
    throw new PathScopeError(tool, "path must not contain NUL bytes");
  }
  // Reject `..` segments unconditionally. We don't try to be clever about
  // "well, this `..` is balanced by a deeper segment so it's fine"; the
  // wrapper rejects the call and the agent must produce a non-traversal
  // path.
  if (containsParentTraversal(pathArg)) {
    throw new PathScopeError(
      tool,
      `path must not contain '..' segments: ${pathArg}`
    );
  }

  // Step 2: resolve to an absolute path. If the agent passed an absolute
  // path that lies outside the module root, this is where we catch it.
  const absolute = isAbsolute(pathArg)
    ? resolve(pathArg)
    : resolve(moduleRoot, pathArg);

  // Cheap pre-check on the lexical path before we hit the filesystem.
  if (!isWithinRoot(absolute, moduleRoot)) {
    throw new PathScopeError(
      tool,
      `resolved path is outside module root: ${absolute} (root=${moduleRoot})`
    );
  }

  // Step 3: real-path resolution. Catches symlinks that point outside the
  // module root. If the path doesn't exist, fall back to resolving the
  // parent (so writes to new files work, but the parent directory itself
  // must still resolve inside the module).
  const real = resolveReal(tool, absolute, resolver);

  if (!isWithinRoot(real, moduleRoot)) {
    throw new PathScopeError(
      tool,
      `real path is outside module root (symlink escape?): ` +
        `${real} (root=${moduleRoot})`
    );
  }

  return real;
}

/**
 * Returns true if `path` contains a `..` segment.
 *
 * Both `/` and the platform separator are checked because the input is
 * untrusted and may use either form.
 */
function containsParentTraversal(path: string): boolean {
  // Normalise both separators to forward slashes for a uniform check.
  const normalised = path.replace(/\\/g, "/");
  // Split on `/` and check every segment.
  return normalised.split("/").some((segment) => segment === "..");
}

/**
 * Lexical containment check. Both arguments are absolute paths.
 *
 * `path.relative(root, candidate)` is not used here because we want a
 * prefix check that's robust to differing separator styles; on Windows the
 * resolver may return `C:\\foo\\bar` while `moduleRoot` is `C:\\foo`.
 */
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

/**
 * Resolve `absolute` to its canonical real path. If the path doesn't exist,
 * resolve the parent directory and append the basename; the parent's
 * canonical form is enough to detect symlink escapes.
 */
function resolveReal(
  tool: string,
  absolute: string,
  resolver: (absolutePath: string) => string
): string {
  try {
    return resolver(absolute);
  } catch (err) {
    if (isEnoent(err)) {
      // Path doesn't exist; resolve its parent instead.
      const parent = dirname(absolute);
      let realParent: string;
      try {
        realParent = resolver(parent);
      } catch (parentErr) {
        const message =
          parentErr instanceof Error ? parentErr.message : String(parentErr);
        throw new PathScopeError(
          tool,
          `parent directory does not resolve (${parent}): ${message}`
        );
      }
      const basename = absolute.slice(parent.length + 1);
      return basename.length > 0 ? `${realParent}${sep}${basename}` : realParent;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new PathScopeError(
      tool,
      `path resolution failed for ${absolute}: ${message}`
    );
  }
}

interface ErrnoLike {
  readonly code?: string;
}

function isEnoent(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as ErrnoLike).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
