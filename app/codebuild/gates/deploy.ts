import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execWithTimeout } from "../exec";

export interface DeployResult {
  success: boolean;
  stackOutputs: Record<string, string>;
  error?: string;
}

/**
 * Parses CDK outputs JSON format into a flat key-value record.
 *
 * CDK --outputs-file produces: { StackName: { OutputKey: OutputValue, ... }, ... }
 * This flattens all stacks into a single Record<string, string>.
 */
export function parseCdkOutputs(cdkOutputJson: string): Record<string, string> {
  const parsed = JSON.parse(cdkOutputJson) as Record<string, Record<string, string>>;
  const result: Record<string, string> = {};

  for (const stackName of Object.keys(parsed)) {
    const outputs = parsed[stackName];
    if (outputs && typeof outputs === "object") {
      for (const [key, value] of Object.entries(outputs)) {
        result[key] = value;
      }
    }
  }

  return result;
}

/**
 * Runs `npx cdk deploy --require-approval never` as a subprocess and
 * extracts stack outputs from the CDK outputs file.
 *
 * On failure, returns the deploy error output for the editor to consume.
 */
export async function runDeploy(options: {
  moduleRoot: string;
  timeout?: number;
}): Promise<DeployResult> {
  const { moduleRoot, timeout = 300_000 } = options;
  const outputsFile = "cdk-outputs.json";

  const result = await execWithTimeout(
    "npx",
    ["cdk", "deploy", "--require-approval", "never", "--outputs-file", outputsFile],
    { cwd: moduleRoot, timeout }
  );

  if (result.exitCode !== 0) {
    return {
      success: false,
      stackOutputs: {},
      error: result.stderr || result.stdout,
    };
  }

  // Read and parse the CDK outputs file
  try {
    const outputsPath = join(moduleRoot, outputsFile);
    const outputsContent = await readFile(outputsPath, "utf-8");
    const stackOutputs = parseCdkOutputs(outputsContent);

    return { success: true, stackOutputs };
  } catch (err) {
    // Deploy succeeded but outputs file couldn't be read — still a success
    return { success: true, stackOutputs: {} };
  }
}
