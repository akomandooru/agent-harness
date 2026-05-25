#!/usr/bin/env ts-node
/**
 * agent-stop.ts — CLI kill-switch equivalent for the agent harness.
 *
 * Applies the `agent-stop` label to a GitHub issue or PR, which signals
 * the in-flight loop to halt at its next stop-condition check.
 *
 * The label IS the signal. The stop-condition checker in
 * harness/loop/src/stop-conditions.ts polls
 * KillSwitchPoll.isAgentStopLabelApplied, which checks for the presence
 * of the `agent-stop` label on the issue or PR.
 *
 * Requirements: 10.1
 *
 * Usage
 * -----
 *   # Apply agent-stop to an issue:
 *   npx ts-node scripts/agent-stop.ts --issue <number>
 *
 *   # Apply agent-stop to a pull request:
 *   npx ts-node scripts/agent-stop.ts --pr <number>
 *
 *   # One-liner via the GitHub CLI (no Node required):
 *   gh issue edit <number> --add-label agent-stop
 *   gh pr edit <number> --add-label agent-stop
 *
 * Prerequisites
 * -------------
 *   - GitHub CLI (`gh`) installed and authenticated, OR
 *   - GITHUB_TOKEN environment variable set with `issues:write` scope.
 *
 * The script shells out to `gh` so it does not need a separate npm
 * dependency for the GitHub API. If `gh` is not available, the script
 * prints the equivalent one-liner and exits non-zero.
 */

import { execSync, ExecSyncOptionsWithStringEncoding } from "child_process";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function printUsage(): void {
  console.log(`
agent-stop — apply the agent-stop kill-switch label

Usage:
  npx ts-node scripts/agent-stop.ts --issue <number>
  npx ts-node scripts/agent-stop.ts --pr <number>

Options:
  --issue <number>   Apply agent-stop to the given issue number
  --pr <number>      Apply agent-stop to the given pull request number
  --help             Print this message

One-liner equivalents (GitHub CLI):
  gh issue edit <number> --add-label agent-stop
  gh pr edit <number> --add-label agent-stop

The label presence is the signal. The in-flight loop polls for it at
each stop-condition check and halts with reason "kill-switch" when found.
`);
}

if (args.includes("--help") || args.length === 0) {
  printUsage();
  process.exit(0);
}

let issueNumber: number | null = null;
let prNumber: number | null = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--issue" && args[i + 1] !== undefined) {
    issueNumber = parseInt(args[i + 1]!, 10);
    i++;
  } else if (args[i] === "--pr" && args[i + 1] !== undefined) {
    prNumber = parseInt(args[i + 1]!, 10);
    i++;
  }
}

if (issueNumber === null && prNumber === null) {
  console.error("Error: provide --issue <number> or --pr <number>.");
  printUsage();
  process.exit(1);
}

if (issueNumber !== null && isNaN(issueNumber)) {
  console.error(`Error: --issue value is not a valid number.`);
  process.exit(1);
}

if (prNumber !== null && isNaN(prNumber)) {
  console.error(`Error: --pr value is not a valid number.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Check for gh CLI
// ---------------------------------------------------------------------------

function ghAvailable(): boolean {
  try {
    execSync("gh --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!ghAvailable()) {
  console.error(
    "Error: GitHub CLI (`gh`) is not installed or not in PATH.\n" +
      "Install it from https://cli.github.com/ or apply the label manually:\n"
  );
  if (issueNumber !== null) {
    console.error(`  gh issue edit ${issueNumber} --add-label agent-stop`);
  }
  if (prNumber !== null) {
    console.error(`  gh pr edit ${prNumber} --add-label agent-stop`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Apply the label
// ---------------------------------------------------------------------------

const execOpts: ExecSyncOptionsWithStringEncoding = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
};

function applyLabel(type: "issue" | "pr", number: number): void {
  const cmd = `gh ${type} edit ${number} --add-label agent-stop`;
  console.log(`Running: ${cmd}`);
  try {
    const out = execSync(cmd, execOpts);
    if (out.trim()) {
      console.log(out.trim());
    }
    console.log(
      `✓ agent-stop label applied to ${type} #${number}. ` +
        `The in-flight loop will halt at its next stop-condition check.`
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error applying label to ${type} #${number}: ${message}`);
    process.exit(1);
  }
}

if (issueNumber !== null) {
  applyLabel("issue", issueNumber);
}

if (prNumber !== null) {
  applyLabel("pr", prNumber);
}
