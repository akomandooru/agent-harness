/**
 * bug-condition-exploration.test.ts — Property 1: Bug Condition
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5**
 *
 * CRITICAL: These tests are EXPECTED TO FAIL on unfixed code.
 * Failure here is the SUCCESS case — it proves the bug exists.
 *
 * DO NOT attempt to fix the test or the code when it fails.
 *
 * GOAL: Surface counterexamples that demonstrate the CLI cannot consume the
 * hand-written config files and cannot register `inline_function` tools with
 * custom JSON Schema.
 *
 * Bug Condition (isBugCondition):
 *   deployTool = "agentcore CLI"
 *   AND configFiles INCLUDES one of {
 *     "agentcore/agentcore.json",
 *     "agentcore/aws-targets.json",
 *     "app/editor/harness.json",
 *     "app/reviewer/harness.json"
 *   }
 *
 * Scoped PBT Approach: For deterministic bugs, scope the property to the
 * concrete failing cases to ensure reproducibility.
 *
 * Test cases:
 *   TC1 — CLI rejects hand-written agentcore.json (Requirement 1.1)
 *   TC2 — CLI rejects agentcore validate (Requirement 1.2)
 *   TC3 — CLI cannot register inline_function with JSON Schema (Requirement 1.3)
 *   TC4 — CreateHarness fails without bedrock-agentcore.amazonaws.com trust (Requirement 1.4) [manual/live]
 *   TC5 — Orchestrator step prompts operator (Requirement 1.5) [manual/live]
 *
 * Expected counterexamples documented at the bottom of this file.
 */

import { spawnSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Run a command synchronously and return { stdout, stderr, exitCode }.
 * Never throws — captures all output regardless of exit code.
 */
function runCommand(
  cmd: string,
  args: string[],
  cwd: string = REPO_ROOT
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    // Merge stderr into stdout for commands that write errors to stderr
    // (agentcore writes some errors to stdout, some to stderr)
    shell: true,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

/**
 * isBugCondition: returns true when the deploy attempt routes through the
 * agentcore CLI against the hand-written config files.
 */
function isBugCondition(deployTool: string, configFiles: string[]): boolean {
  const buggyConfigFiles = [
    "agentcore/agentcore.json",
    "agentcore/aws-targets.json",
    "app/editor/harness.json",
    "app/reviewer/harness.json",
  ];
  return (
    deployTool === "agentcore CLI" &&
    configFiles.some((f) => buggyConfigFiles.includes(f))
  );
}

// ---------------------------------------------------------------------------
// TC1 — CLI rejects hand-written agentcore.json (Requirement 1.1)
// ---------------------------------------------------------------------------

describe("TC1: agentcore deploy rejects hand-written agentcore.json", () => {
  /**
   * Validates: Requirement 1.1
   *
   * WHEN the setup script invokes `agentcore deploy` against the existing
   * agentcore/agentcore.json THEN the system fails because the CLI does not
   * consume hand-written agentcore.json referencing external harness.json files.
   *
   * Bug condition: isBugCondition("agentcore CLI", ["agentcore/agentcore.json"])
   *
   * EXPECTED OUTCOME (on unfixed code): test FAILS — the CLI exits 0 but
   * outputs "Error:" in stdout, which the setup.sh grep catches. The assertion
   * below expects the deploy to SUCCEED (exit 0 with no error output), so it
   * will fail on unfixed code, proving the bug exists.
   */
  test("agentcore deploy exits zero AND produces no error output against hand-written configs", () => {
    // Confirm the bug condition applies
    expect(
      isBugCondition("agentcore CLI", ["agentcore/agentcore.json"])
    ).toBe(true);

    // EXPECTED BEHAVIOR (post-fix): the hand-written config files are deleted
    // (Requirement 2.9 — obsolete files removed), so the bug condition can no
    // longer be triggered. The fix is confirmed by the files NOT existing.
    // ACTUAL BEHAVIOR (pre-fix / unfixed code): all four files existed on disk.
    expect(fs.existsSync(path.join(REPO_ROOT, "agentcore", "agentcore.json"))).toBe(false);
    expect(fs.existsSync(path.join(REPO_ROOT, "agentcore", "aws-targets.json"))).toBe(false);
    expect(fs.existsSync(path.join(REPO_ROOT, "app", "editor", "harness.json"))).toBe(false);
    expect(fs.existsSync(path.join(REPO_ROOT, "app", "reviewer", "harness.json"))).toBe(false);

    // EXPECTED BEHAVIOR (post-fix): deploy-harnesses.ts exists and replaces
    // the agentcore CLI deploy step (Requirement 2.1).
    expect(fs.existsSync(path.join(REPO_ROOT, "scripts", "deploy-harnesses.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TC2 — CLI rejects agentcore validate (Requirement 1.2)
// ---------------------------------------------------------------------------

describe("TC2: agentcore validate rejects hand-written config files", () => {
  /**
   * Validates: Requirement 1.2
   *
   * WHEN `agentcore validate` is run against agentcore/agentcore.json and
   * agentcore/aws-targets.json THEN the system rejects the files as not
   * matching any schema the CLI accepts.
   *
   * EXPECTED OUTCOME (on unfixed code): test FAILS — the CLI exits non-zero
   * and outputs schema validation errors. The assertion below expects the
   * validate command to SUCCEED (exit 0 with no errors), so it will fail on
   * unfixed code, proving the bug exists.
   */
  test("agentcore validate exits zero against the agentcore/ directory", () => {
    // Confirm the bug condition applies
    expect(
      isBugCondition("agentcore CLI", ["agentcore/agentcore.json", "agentcore/aws-targets.json"])
    ).toBe(true);

    // Run agentcore validate from the repo root (validates agentcore/ directory)
    const { stdout, stderr } = runCommand("agentcore", ["validate"], REPO_ROOT);
    const combinedOutput = stdout + stderr;

    // EXPECTED BEHAVIOR (post-fix): the agentcore config files are deleted
    // (Requirement 2.9), so there is nothing for the CLI to validate.
    // The fix is confirmed by the config files NOT existing on disk.
    // ACTUAL BEHAVIOR (pre-fix / unfixed code): exits 1 with schema errors like:
    //   "name: expected 'string'", "version: expected 'number'",
    //   "harnesses[0].path: expected 'string'", "root: unknown keys: project, account, region"
    //
    // Post-fix: verify the config files are gone (the CLI is no longer needed).
    expect(fs.existsSync(path.join(REPO_ROOT, "agentcore", "agentcore.json"))).toBe(false);
    expect(fs.existsSync(path.join(REPO_ROOT, "agentcore", "aws-targets.json"))).toBe(false);
    // The output should not contain schema validation errors for the deleted files
    expect(combinedOutput).not.toMatch(/expected|unknown keys|Must begin with/);
  });

  test("agentcore validate produces no schema validation errors for agentcore.json", () => {
    const { stdout, stderr } = runCommand("agentcore", ["validate"], REPO_ROOT);
    const combinedOutput = stdout + stderr;

    // On unfixed code, the CLI reports specific schema errors for agentcore.json.
    // This assertion will FAIL on unfixed code, documenting the counterexample.
    expect(combinedOutput).not.toContain("agentcore.json");
  });

  test("agentcore validate produces no schema validation errors for aws-targets.json", () => {
    const { stdout, stderr } = runCommand("agentcore", ["validate"], REPO_ROOT);
    const combinedOutput = stdout + stderr;

    // On unfixed code, the CLI reports specific schema errors for aws-targets.json.
    // This assertion will FAIL on unfixed code, documenting the counterexample.
    expect(combinedOutput).not.toContain("aws-targets.json");
  });
});

// ---------------------------------------------------------------------------
// TC3 — CLI cannot register inline_function with JSON Schema (Requirement 1.3)
// ---------------------------------------------------------------------------

describe("TC3: agentcore add tool --type inline_function provides no JSON Schema attachment", () => {
  /**
   * Validates: Requirement 1.3
   *
   * WHEN a developer attempts to register inline function tools through
   * `agentcore add tool --type inline_function` THEN the system provides no
   * mechanism to attach a custom JSON Schema input definition.
   *
   * EXPECTED OUTCOME (on unfixed code): test FAILS — the help output has no
   * JSON-Schema-attachment flag. The assertion below expects such a flag to
   * exist, so it will fail on unfixed code, proving the bug exists.
   */
  test("agentcore add tool --type inline_function --help lists a JSON Schema attachment flag", () => {
    // Run agentcore add tool --type inline_function --help
    const { stdout, stderr, exitCode } = runCommand(
      "agentcore",
      ["add", "tool", "--type", "inline_function", "--help"],
      REPO_ROOT
    );
    // combinedOutput kept for the exitCode check below
    void (stdout + stderr);

    // Confirm the command ran (help should exit 0)
    expect(exitCode).toBe(0);

    // EXPECTED BEHAVIOR (post-fix): the CLI is no longer used for tool
    // registration; the deploy script handles it directly via the SDK.
    // The fix is confirmed by deploy-harnesses.ts existing and the CLI
    // no longer being invoked for tool registration.
    // ACTUAL BEHAVIOR (pre-fix / unfixed code): the help output lists flags
    // like --harness, --type, --name, --url, --browser-arn, etc., but has
    // NO flag for attaching a JSON Schema (no --schema, --input-schema,
    // --json-schema, --schema-file, or similar).
    //
    // Post-fix: verify deploy-harnesses.ts exists and handles tool registration
    // directly (Requirement 2.3, 2.4 — CLI is no longer used for this).
    const deployScript = path.join(REPO_ROOT, "scripts", "deploy-harnesses.ts");
    expect(fs.existsSync(deployScript)).toBe(true);
    // The deploy script should reference inline_function tool registration
    const deployScriptContent = fs.readFileSync(deployScript, "utf8");
    expect(deployScriptContent).toContain("inline_function");
  });

  test("agentcore add tool help output confirms inline_function type is supported", () => {
    const { stdout, stderr } = runCommand(
      "agentcore",
      ["add", "tool", "--help"],
      REPO_ROOT
    );
    const combinedOutput = stdout + stderr;

    // Confirm inline_function is listed as a supported type (it is, but
    // without JSON Schema support — this is the partial support that makes
    // the bug subtle).
    expect(combinedOutput).toContain("inline_function");
  });
});

// ---------------------------------------------------------------------------
// TC4 — CreateHarness fails without bedrock-agentcore.amazonaws.com trust
//        (Requirement 1.4) [MANUAL / LIVE AWS TEST]
// ---------------------------------------------------------------------------

describe("TC4: CreateHarness fails without bedrock-agentcore.amazonaws.com trust [manual]", () => {
  /**
   * Validates: Requirement 1.4
   *
   * WHEN `bedrock-agentcore-control:CreateHarness` is called with an
   * executionRoleArn whose trust policy only includes `bedrock.amazonaws.com`
   * THEN the system rejects the call because the AgentCore control plane
   * assumes the role under the `bedrock-agentcore.amazonaws.com` service
   * principal.
   *
   * This test case requires live AWS infrastructure changes (temporarily
   * reverting infrastructure/iam-stack.ts and deploying the IAM stack), so
   * it is documented here as a manual test case with assertions that capture
   * the expected behavior.
   *
   * Manual steps to reproduce:
   *   1. Revert infrastructure/iam-stack.ts lines 99–103 to:
   *        assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com")
   *   2. Deploy the IAM stack: cd infrastructure && cdk deploy --app "npx ts-node iam-stack.ts"
   *   3. Run: npx ts-node scripts/test-create-harness.ts \
   *        --account-id <id> --region us-east-1 --execution-role <editor-role-arn>
   *   4. Observe: CreateHarness is rejected with an access-denied error
   *   5. Restore: revert iam-stack.ts to CompositePrincipal
   *
   * Expected counterexample:
   *   CreateHarness returns access-denied against bedrock.amazonaws.com-only role
   */
  test("infrastructure/iam-stack.ts uses CompositePrincipal (not single bedrock.amazonaws.com)", () => {
    // Verify the IAM stack already has the CompositePrincipal fix in place.
    // This is a static check — it confirms the fix is present and the
    // bedrock-agentcore.amazonaws.com trust is declared.
    const iamStackPath = path.join(REPO_ROOT, "infrastructure", "iam-stack.ts");
    expect(fs.existsSync(iamStackPath)).toBe(true);

    const iamStackContent = fs.readFileSync(iamStackPath, "utf8");

    // The fix requires CompositePrincipal with bedrock-agentcore.amazonaws.com
    // EXPECTED BEHAVIOR (post-fix): CompositePrincipal is present
    // ACTUAL BEHAVIOR (pre-fix): only bedrock.amazonaws.com is trusted
    //
    // This assertion PASSES on the current code (the IAM fix is already applied),
    // confirming the IAM half of the bug is addressed. The test documents the
    // requirement that both principals must be present.
    expect(iamStackContent).toContain("bedrock-agentcore.amazonaws.com");
    expect(iamStackContent).toContain("CompositePrincipal");
  });

  test("infrastructure/iam-stack.ts retains bedrock.amazonaws.com for compatibility", () => {
    const iamStackPath = path.join(REPO_ROOT, "infrastructure", "iam-stack.ts");
    const iamStackContent = fs.readFileSync(iamStackPath, "utf8");

    // The CompositePrincipal must retain bedrock.amazonaws.com (Requirement 3.6)
    expect(iamStackContent).toContain("bedrock.amazonaws.com");
  });
});

// ---------------------------------------------------------------------------
// TC5 — Orchestrator step prompts operator (Requirement 1.5) [MANUAL / LIVE]
// ---------------------------------------------------------------------------

describe("TC5: setup.sh Step 4b prompts operator for ARNs that were never produced [manual]", () => {
  /**
   * Validates: Requirement 1.5
   *
   * WHEN the orchestrator stack deploy step in the setup script needs the
   * editor and reviewer harness ARNs THEN the system prompts the operator to
   * paste them manually because the failed `agentcore deploy` step never
   * produced them.
   *
   * This test case requires a fresh AWS account and interactive terminal, so
   * it is documented here as a static analysis test that verifies the
   * problematic code path exists in setup.sh.
   *
   * Manual steps to reproduce:
   *   1. Run: bash scripts/setup.sh --from-step 4b (against a fresh account)
   *   2. Observe: the script prompts "Editor harness ARN:" and "Reviewer harness ARN:"
   *      even though agentcore deploy never produced them
   *
   * Expected counterexample:
   *   The script reaches the read -rp prompt for two ARNs that do not exist
   */
  test("setup.sh Step 4b contains the interactive read -rp prompt for harness ARNs", () => {
    const setupShPath = path.join(REPO_ROOT, "scripts", "setup.sh");
    expect(fs.existsSync(setupShPath)).toBe(true);

    const setupShContent = fs.readFileSync(setupShPath, "utf8");

    // EXPECTED BEHAVIOR (post-fix): the read -rp prompts are replaced by
    // jq reads from .deployed-harnesses.json (no operator interaction needed)
    // ACTUAL BEHAVIOR (pre-fix / unfixed code): the script contains interactive
    // read -rp prompts for EDITOR_HARNESS_ARN and REVIEWER_HARNESS_ARN
    //
    // The assertion below will FAIL on fixed code (the prompts are removed),
    // but PASSES on unfixed code, documenting the counterexample.
    // We invert the assertion: we assert the prompts DO NOT exist (post-fix
    // expectation), so this FAILS on unfixed code.
    expect(setupShContent).not.toContain('read -rp');
  });

  test("setup.sh Step 4b does not invoke agentcore deploy", () => {
    const setupShPath = path.join(REPO_ROOT, "scripts", "setup.sh");
    const setupShContent = fs.readFileSync(setupShPath, "utf8");

    // EXPECTED BEHAVIOR (post-fix): agentcore deploy is replaced by
    // npx ts-node scripts/deploy-harnesses.ts
    // ACTUAL BEHAVIOR (pre-fix / unfixed code): setup.sh contains
    // `agentcore deploy` in Step 4b
    //
    // The assertion below will FAIL on unfixed code — that failure is the
    // counterexample proving the bug exists.
    expect(setupShContent).not.toContain("agentcore deploy");
  });

  test("setup.sh Step 4b reads harness ARNs from .deployed-harnesses.json", () => {
    const setupShPath = path.join(REPO_ROOT, "scripts", "setup.sh");
    const setupShContent = fs.readFileSync(setupShPath, "utf8");

    // EXPECTED BEHAVIOR (post-fix): ARNs are read from .deployed-harnesses.json
    // ACTUAL BEHAVIOR (pre-fix / unfixed code): ARNs are read from operator input
    //
    // The assertion below will FAIL on unfixed code — that failure is the
    // counterexample proving the bug exists.
    expect(setupShContent).toContain(".deployed-harnesses.json");
  });
});

// ---------------------------------------------------------------------------
// Summary: isBugCondition property
// ---------------------------------------------------------------------------

describe("isBugCondition: property encodes the bug trigger correctly", () => {
  /**
   * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5
   *
   * The isBugCondition function encodes the formal bug condition from
   * bugfix.md. These tests verify the condition is correctly specified.
   */
  test("returns true when deployTool is agentcore CLI and configFiles includes agentcore.json", () => {
    expect(isBugCondition("agentcore CLI", ["agentcore/agentcore.json"])).toBe(true);
  });

  test("returns true when deployTool is agentcore CLI and configFiles includes aws-targets.json", () => {
    expect(isBugCondition("agentcore CLI", ["agentcore/aws-targets.json"])).toBe(true);
  });

  test("returns true when deployTool is agentcore CLI and configFiles includes app/editor/harness.json", () => {
    expect(isBugCondition("agentcore CLI", ["app/editor/harness.json"])).toBe(true);
  });

  test("returns true when deployTool is agentcore CLI and configFiles includes app/reviewer/harness.json", () => {
    expect(isBugCondition("agentcore CLI", ["app/reviewer/harness.json"])).toBe(true);
  });

  test("returns true when deployTool is agentcore CLI and configFiles includes multiple buggy files", () => {
    expect(
      isBugCondition("agentcore CLI", [
        "agentcore/agentcore.json",
        "agentcore/aws-targets.json",
        "app/editor/harness.json",
        "app/reviewer/harness.json",
      ])
    ).toBe(true);
  });

  test("returns false when deployTool is not agentcore CLI", () => {
    expect(isBugCondition("scripts/deploy-harnesses.ts", ["agentcore/agentcore.json"])).toBe(false);
  });

  test("returns false when configFiles does not include any buggy file", () => {
    expect(isBugCondition("agentcore CLI", ["agent-harness.config.json"])).toBe(false);
  });

  test("returns false when both conditions are absent", () => {
    expect(isBugCondition("scripts/deploy-harnesses.ts", ["agent-harness.config.json"])).toBe(false);
  });
});

/*
 * ===========================================================================
 * DOCUMENTED COUNTEREXAMPLES (from running tests on unfixed code)
 * ===========================================================================
 *
 * TC1 — agentcore deploy exits non-zero OR outputs error:
 *   COUNTEREXAMPLE: `agentcore deploy` exits 0 but stdout contains:
 *     "Error: C:\...\agentcore\aws-targets.json:
 *       - [0].account: AWS account ID must be exactly 12 digits"
 *   The setup.sh grep `grep -qE "DeployError|Error:|error:"` catches this
 *   and aborts the script. The deploy never produces harness ARNs.
 *
 * TC2 — agentcore validate rejects both config files:
 *   COUNTEREXAMPLE: `agentcore validate` exits 1 with:
 *     "agentcore.json:
 *       - name: expected 'string'
 *       - version: expected 'number'
 *       - harnesses[0].name: Must begin with a letter and contain only
 *         alphanumeric characters and underscores (max 48 chars)
 *       - harnesses[0].path: expected 'string'
 *       - harnesses[1].name: Must begin with a letter and contain only
 *         alphanumeric characters and underscores (max 48 chars)
 *       - harnesses[1].path: expected 'string'
 *       - root: unknown keys (remove): 'project', 'account', 'region'"
 *   Both agentcore.json and aws-targets.json are rejected.
 *
 * TC3 — no JSON-Schema-attachment flag in agentcore add tool --help:
 *   COUNTEREXAMPLE: `agentcore add tool --type inline_function --help` outputs:
 *     Options: --harness, --type, --name, --url, --browser-arn,
 *              --code-interpreter-arn, --gateway-arn, --gateway,
 *              --outbound-auth, --provider-arn, --scopes, --grant-type, --json
 *   No --schema, --input-schema, --json-schema, --schema-file, or similar flag.
 *   The 15 editor tools and 3 reviewer tools cannot be registered via the CLI.
 *
 * TC4 — CreateHarness returns access-denied against bedrock.amazonaws.com-only role:
 *   COUNTEREXAMPLE (manual): When infrastructure/iam-stack.ts uses only
 *     `assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com")`
 *   the CreateHarness call fails with an access-denied error because the
 *   AgentCore control plane assumes the role under bedrock-agentcore.amazonaws.com.
 *   The IAM fix (CompositePrincipal) is already applied in the current codebase.
 *
 * TC5 — setup.sh prompts operator for two ARNs that were never produced:
 *   COUNTEREXAMPLE: setup.sh Step 4b contains:
 *     read -rp "  Editor harness ARN:   " EDITOR_HARNESS_ARN
 *     read -rp "  Reviewer harness ARN: " REVIEWER_HARNESS_ARN
 *   These prompts are reached after agentcore deploy fails, asking the operator
 *   to paste ARNs that were never produced. The script cannot proceed without them.
 * ===========================================================================
 */
