#!/usr/bin/env ts-node
/**
 * sweep-previews.ts — Destroy abandoned CDK preview stacks.
 *
 * Lists all CloudFormation stacks tagged `agent-harness/env=preview` and
 * destroys any that are older than `preview.sweepMaxAgeHours` from
 * `agent-harness.config.json` (default 24 hours).
 *
 * Invoked by `.github/workflows/preview-sweep.yml` on a schedule and
 * optionally by operators for immediate cleanup.
 *
 * Requirements: 7.5, 10.2
 *
 * Usage
 * -----
 *   npx ts-node scripts/sweep-previews.ts
 *   npx ts-node scripts/sweep-previews.ts --dry-run
 *
 * Options
 *   --dry-run   List stacks that would be destroyed without destroying them.
 *   --region    AWS region to scan (overrides config; default: us-east-1).
 *   --max-age   Max age in hours (overrides config).
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface HarnessConfig {
  preview: {
    tagKey: string;
    envTagKey: string;
    sweepMaxAgeHours: number;
    sweepIntervalHours: number;
  };
  agentcore: {
    regionalRouting: string;
  };
}

function loadConfig(): HarnessConfig {
  const configPath = path.resolve(__dirname, "..", "agent-harness.config.json");
  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw) as HarnessConfig;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

let regionOverride: string | undefined;
let maxAgeOverride: number | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--region" && args[i + 1]) {
    regionOverride = args[i + 1];
    i++;
  }
  if (args[i] === "--max-age" && args[i + 1]) {
    maxAgeOverride = parseInt(args[i + 1]!, 10);
    i++;
  }
}

// ---------------------------------------------------------------------------
// CloudFormation helpers (using AWS CLI to avoid adding SDK dependency)
// ---------------------------------------------------------------------------

interface StackSummary {
  StackName: string;
  StackStatus: string;
  CreationTime: string;
  Tags?: Array<{ Key: string; Value: string }>;
}

function listPreviewStacks(region: string): StackSummary[] {
  try {
    const output = execSync(
      `aws cloudformation describe-stacks --region ${region} --output json`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const parsed = JSON.parse(output) as { Stacks: StackSummary[] };
    return parsed.Stacks.filter((stack) => {
      const tags = stack.Tags ?? [];
      return tags.some(
        (t) => t.Key === "agent-harness/env" && t.Value === "preview"
      );
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to list CloudFormation stacks: ${message}`);
    return [];
  }
}

function stackAgeHours(stack: StackSummary): number {
  const created = new Date(stack.CreationTime).getTime();
  const now = Date.now();
  return (now - created) / (1000 * 60 * 60);
}

function destroyStack(stackName: string, region: string): boolean {
  console.log(`  Destroying stack: ${stackName} ...`);
  try {
    execSync(
      `aws cloudformation delete-stack --stack-name ${stackName} --region ${region}`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    // Wait for deletion to complete (up to 10 minutes).
    execSync(
      `aws cloudformation wait stack-delete-complete --stack-name ${stackName} --region ${region}`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 }
    );
    console.log(`  ✓ Destroyed: ${stackName}`);
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ Failed to destroy ${stackName}: ${message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  const region = regionOverride ?? config.agentcore.regionalRouting ?? "us-east-1";
  const maxAgeHours = maxAgeOverride ?? config.preview.sweepMaxAgeHours ?? 24;

  console.log(
    `Preview sweep — region: ${region}, max age: ${maxAgeHours}h, dry-run: ${dryRun}`
  );
  console.log("Listing preview stacks...");

  const stacks = listPreviewStacks(region);

  if (stacks.length === 0) {
    console.log("No preview stacks found.");
    return;
  }

  console.log(`Found ${stacks.length} preview stack(s):`);

  const toDestroy: StackSummary[] = [];

  for (const stack of stacks) {
    const ageHours = stackAgeHours(stack);
    const sessionTag =
      stack.Tags?.find((t) => t.Key === "agent-harness/session")?.Value ??
      "(no session tag)";
    const status = stack.StackStatus;
    const ageStr = ageHours.toFixed(1);

    if (ageHours >= maxAgeHours) {
      console.log(
        `  [SWEEP] ${stack.StackName} | session: ${sessionTag} | age: ${ageStr}h | status: ${status}`
      );
      toDestroy.push(stack);
    } else {
      console.log(
        `  [KEEP]  ${stack.StackName} | session: ${sessionTag} | age: ${ageStr}h | status: ${status}`
      );
    }
  }

  if (toDestroy.length === 0) {
    console.log(`\nNo stacks older than ${maxAgeHours}h. Nothing to destroy.`);
    return;
  }

  console.log(
    `\n${toDestroy.length} stack(s) to destroy (older than ${maxAgeHours}h):`
  );

  if (dryRun) {
    for (const stack of toDestroy) {
      console.log(`  [DRY RUN] Would destroy: ${stack.StackName}`);
    }
    console.log("\nDry run complete. No stacks were destroyed.");
    return;
  }

  let destroyed = 0;
  let failed = 0;

  for (const stack of toDestroy) {
    const ok = destroyStack(stack.StackName, region);
    if (ok) {
      destroyed++;
    } else {
      failed++;
    }
  }

  console.log(
    `\nSweep complete. Destroyed: ${destroyed}, Failed: ${failed}.`
  );

  if (failed > 0) {
    console.error(
      `${failed} stack(s) failed to destroy. See the runbook (docs/runbook.md) for manual teardown steps.`
    );
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Sweep failed: ${message}`);
  process.exit(1);
});
