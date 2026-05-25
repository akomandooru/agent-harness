#!/usr/bin/env ts-node
/**
 * check-version-drift.ts — CI check for version pin consistency.
 *
 * Reads `agent-harness.config.json` and verifies that the versions declared
 * in the `versions` section match what is actually installed in the
 * workspace's `package.json` files.
 *
 * Exits non-zero if any drift is detected, so CI fails loudly rather than
 * silently shipping a template with mismatched version claims.
 *
 * Requirements: 10.5
 *
 * Usage
 * -----
 *   npx ts-node scripts/check-version-drift.ts
 *
 * What is checked
 * ---------------
 *   - aws-cdk-lib version in modules/fanout/package.json
 *   - aws-cdk (CLI) version in modules/fanout/package.json
 *   - cdk-nag version in infrastructure/package.json
 *   - typescript version in modules/fanout/package.json
 *   - jest version in modules/fanout/package.json
 *   - ts-jest version in modules/fanout/package.json
 *   - ts-node version in modules/fanout/package.json
 *   - @aws/agentcore (CLI) in root package.json matches versions.agentcoreSdk
 *   - @aws-sdk/client-bedrock-agentcore in agents/editor and
 *     harness/scheduled-reviewer matches versions.bedrockAgentCoreSdk
 *   - models.editor and models.reviewer match config.models.*
 *   - bedrockRegion matches config.agentcore.regionalRouting
 *
 * PLACEHOLDER versions are skipped until the package names are confirmed.
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface HarnessConfig {
  models: {
    editor: string;
    reviewer: string;
  };
  agentcore: {
    regionalRouting: string;
  };
  versions: {
    agentcoreSdk: string;
    bedrockAgentCoreSdk: string;
    awsCdkLib: string;
    awsCdk: string;
    cdkNag: string;
    typescript: string;
    jest: string;
    tsJest: string;
    tsNode: string;
    models: {
      editor: string;
      reviewer: string;
    };
    bedrockRegion: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..");

function readJson<T>(filePath: string): T {
  const abs = path.resolve(ROOT, filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`File not found: ${abs}`);
  }
  return JSON.parse(fs.readFileSync(abs, "utf8")) as T;
}

function resolvedVersion(pkg: PackageJson, name: string): string | undefined {
  return (
    pkg.dependencies?.[name] ??
    pkg.devDependencies?.[name]
  );
}

/**
 * Strip leading `^`, `~`, `>=`, `>`, `<=`, `<` from a semver range so we
 * can compare the base version. Exact pins (no prefix) pass through unchanged.
 */
function stripRange(version: string): string {
  return version.replace(/^[~^>=<]+/, "");
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

interface DriftResult {
  field: string;
  expected: string;
  actual: string | undefined;
  source: string;
}

const drifts: DriftResult[] = [];

function check(
  field: string,
  expected: string,
  actual: string | undefined,
  source: string
): void {
  if (expected.startsWith("PLACEHOLDER")) {
    // Not yet pinned; skip.
    console.log(`  SKIP  ${field} (PLACEHOLDER — not yet pinned)`);
    return;
  }
  if (actual === undefined) {
    drifts.push({ field, expected, actual: "(not found)", source });
    console.log(`  DRIFT ${field}: expected ${expected}, not found in ${source}`);
    return;
  }
  const strippedActual = stripRange(actual);
  const strippedExpected = stripRange(expected);
  if (strippedActual !== strippedExpected) {
    drifts.push({ field, expected, actual, source });
    console.log(
      `  DRIFT ${field}: config says ${expected}, ${source} has ${actual}`
    );
  } else {
    console.log(`  OK    ${field}: ${expected}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  console.log("Checking version drift against agent-harness.config.json...\n");

  const config = readJson<HarnessConfig>("agent-harness.config.json");
  const fanoutPkg = readJson<PackageJson>("modules/fanout/package.json");
  const infraPkg = readJson<PackageJson>("infrastructure/package.json");
  const rootPkg = readJson<PackageJson>("package.json");
  const editorPkg = readJson<PackageJson>("agents/editor/package.json");
  const scheduledReviewerPkg = readJson<PackageJson>(
    "harness/scheduled-reviewer/package.json"
  );

  const v = config.versions;

  // @aws/agentcore CLI (preview) — pinned in the root package.json
  check(
    "versions.agentcoreSdk",
    v.agentcoreSdk,
    resolvedVersion(rootPkg, "@aws/agentcore"),
    "package.json"
  );

  // @aws-sdk/client-bedrock-agentcore — pinned in every package that calls
  // InvokeHarness. Drift in any of them is reported separately so the
  // operator can see exactly which package.json needs the bump.
  check(
    "versions.bedrockAgentCoreSdk (agents/editor)",
    v.bedrockAgentCoreSdk,
    resolvedVersion(editorPkg, "@aws-sdk/client-bedrock-agentcore"),
    "agents/editor/package.json"
  );
  check(
    "versions.bedrockAgentCoreSdk (harness/scheduled-reviewer)",
    v.bedrockAgentCoreSdk,
    resolvedVersion(scheduledReviewerPkg, "@aws-sdk/client-bedrock-agentcore"),
    "harness/scheduled-reviewer/package.json"
  );

  // aws-cdk-lib
  check(
    "versions.awsCdkLib",
    v.awsCdkLib,
    resolvedVersion(fanoutPkg, "aws-cdk-lib"),
    "modules/fanout/package.json"
  );

  // aws-cdk CLI
  check(
    "versions.awsCdk",
    v.awsCdk,
    resolvedVersion(fanoutPkg, "aws-cdk"),
    "modules/fanout/package.json"
  );

  // cdk-nag (in infrastructure)
  check(
    "versions.cdkNag",
    v.cdkNag,
    resolvedVersion(infraPkg, "cdk-nag"),
    "infrastructure/package.json"
  );

  // typescript
  check(
    "versions.typescript",
    v.typescript,
    resolvedVersion(fanoutPkg, "typescript"),
    "modules/fanout/package.json"
  );

  // jest
  check(
    "versions.jest",
    v.jest,
    resolvedVersion(fanoutPkg, "jest"),
    "modules/fanout/package.json"
  );

  // ts-jest
  check(
    "versions.tsJest",
    v.tsJest,
    resolvedVersion(fanoutPkg, "ts-jest"),
    "modules/fanout/package.json"
  );

  // ts-node
  check(
    "versions.tsNode",
    v.tsNode,
    resolvedVersion(fanoutPkg, "ts-node"),
    "modules/fanout/package.json"
  );

  // Model identifiers: versions.models must match config.models
  if (v.models.editor !== config.models.editor) {
    drifts.push({
      field: "versions.models.editor",
      expected: v.models.editor,
      actual: config.models.editor,
      source: "agent-harness.config.json (models.editor)",
    });
    console.log(
      `  DRIFT versions.models.editor: versions block says ${v.models.editor}, models block says ${config.models.editor}`
    );
  } else {
    console.log(`  OK    versions.models.editor: ${v.models.editor}`);
  }

  if (v.models.reviewer !== config.models.reviewer) {
    drifts.push({
      field: "versions.models.reviewer",
      expected: v.models.reviewer,
      actual: config.models.reviewer,
      source: "agent-harness.config.json (models.reviewer)",
    });
    console.log(
      `  DRIFT versions.models.reviewer: versions block says ${v.models.reviewer}, models block says ${config.models.reviewer}`
    );
  } else {
    console.log(`  OK    versions.models.reviewer: ${v.models.reviewer}`);
  }

  // Bedrock region: versions.bedrockRegion must match agentcore.regionalRouting
  if (v.bedrockRegion !== config.agentcore.regionalRouting) {
    drifts.push({
      field: "versions.bedrockRegion",
      expected: v.bedrockRegion,
      actual: config.agentcore.regionalRouting,
      source: "agent-harness.config.json (agentcore.regionalRouting)",
    });
    console.log(
      `  DRIFT versions.bedrockRegion: versions block says ${v.bedrockRegion}, agentcore block says ${config.agentcore.regionalRouting}`
    );
  } else {
    console.log(`  OK    versions.bedrockRegion: ${v.bedrockRegion}`);
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  console.log("");

  if (drifts.length === 0) {
    console.log("✓ No version drift detected.");
    process.exit(0);
  } else {
    console.error(`✗ ${drifts.length} version drift(s) detected:`);
    for (const d of drifts) {
      console.error(
        `  - ${d.field}: expected "${d.expected}", got "${d.actual ?? "(not found)"}" in ${d.source}`
      );
    }
    console.error(
      "\nUpdate agent-harness.config.json versions section or the relevant package.json to resolve drift."
    );
    process.exit(1);
  }
}

main();
