#!/usr/bin/env ts-node
/**
 * check-terminology.ts — CI guard for correct AgentCore terminology.
 *
 * Greps for the literal string "AgentCore Harness" (without "Managed") in the
 * three public-facing documents that must use "AgentCore Managed Harness":
 *
 *   - README.md
 *   - docs/quickstart.md
 *   - post-draft.md
 *
 * Exits non-zero if any match is found, so CI fails loudly rather than
 * silently shipping docs with the old terminology.
 *
 * Excluded files (intentionally not checked):
 *   - harness-engineering-primer.md  — uses "harness" in the engineering-harness
 *     sense, not the AgentCore product sense; the phrase "AgentCore Harness"
 *     does not appear there but the file is excluded by design to avoid
 *     false positives if the primer ever discusses the product by name.
 *   - CHANGELOG* — historical entries may legitimately reference the old name.
 *
 * Requirements: 1.1
 *
 * Usage
 * -----
 *   npx ts-node scripts/check-terminology.ts
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..");

/**
 * Files to check. Paths are relative to the repo root.
 * harness-engineering-primer.md and CHANGELOG* are intentionally excluded.
 */
const FILES_TO_CHECK: string[] = [
  "README.md",
  "docs/quickstart.md",
];

/**
 * The pattern that must NOT appear in the checked files.
 *
 * Matches "AgentCore Harness" that is NOT preceded by "Managed " (case-sensitive).
 * Uses a negative lookbehind so "AgentCore Managed Harness" is allowed but
 * bare "AgentCore Harness" is flagged.
 */
const FORBIDDEN_PATTERN = /(?<!Managed )AgentCore Harness/g;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Match {
  file: string;
  line: number;
  text: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkFile(relativePath: string): Match[] {
  const absolutePath = resolve(REPO_ROOT, relativePath);

  if (!existsSync(absolutePath)) {
    // File doesn't exist — skip silently (it may not have been created yet).
    console.warn(`  SKIP  ${relativePath} (file not found)`);
    return [];
  }

  const content = readFileSync(absolutePath, "utf8");
  const lines = content.split("\n");
  const matches: Match[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Reset lastIndex before each exec loop (global flag retains state).
    FORBIDDEN_PATTERN.lastIndex = 0;
    if (FORBIDDEN_PATTERN.test(line)) {
      matches.push({
        file: relativePath,
        line: i + 1, // 1-indexed for human readability
        text: line.trim(),
      });
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): number {
  console.log(
    'Checking for bare "AgentCore Harness" (without "Managed") in docs...\n'
  );

  const allMatches: Match[] = [];

  for (const file of FILES_TO_CHECK) {
    const matches = checkFile(file);
    if (matches.length === 0) {
      console.log(`  OK    ${file}`);
    } else {
      for (const m of matches) {
        console.error(`  FAIL  ${m.file}:${m.line}: ${m.text}`);
        allMatches.push(m);
      }
    }
  }

  console.log("");

  if (allMatches.length === 0) {
    console.log(
      '✓ No bare "AgentCore Harness" occurrences found. Terminology is correct.'
    );
    return 0;
  }

  console.error(
    `✗ Found ${allMatches.length} occurrence(s) of "AgentCore Harness" without "Managed":`
  );
  for (const m of allMatches) {
    console.error(`  ${m.file}:${m.line}`);
    console.error(`    ${m.text}`);
  }
  console.error(
    '\nReplace each occurrence with "AgentCore Managed Harness" to fix.'
  );
  return 1;
}

process.exit(main());
