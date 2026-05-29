#!/usr/bin/env ts-node
/**
 * test-create-harness.ts — Sanity check for SDK-direct harness creation.
 *
 * Tests whether `bedrock-agentcore-control:CreateHarness` accepts a custom
 * inline function tool with a JSON Schema for its input. If this works, we
 * can bypass the `agentcore` CLI entirely and define the editor and reviewer
 * harnesses in TypeScript using `@aws-sdk/client-bedrock-agentcore-control`.
 *
 * Usage:
 *   npx ts-node scripts/test-create-harness.ts \
 *     --account-id 123456789012 \
 *     --region us-east-1 \
 *     --execution-role arn:aws:iam::123456789012:role/agent-harness-editor
 */

import {
  BedrockAgentCoreControlClient,
  CreateHarnessCommand,
  DeleteHarnessCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface Args {
  accountId: string;
  region: string;
  executionRoleArn: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--account-id") { args.accountId = value; i++; }
    else if (flag === "--region") { args.region = value; i++; }
    else if (flag === "--execution-role") { args.executionRoleArn = value; i++; }
  }
  if (!args.accountId || !args.region || !args.executionRoleArn) {
    console.error(
      "Usage: npx ts-node scripts/test-create-harness.ts \\\n" +
      "  --account-id <12-digit-id> \\\n" +
      "  --region <aws-region> \\\n" +
      "  --execution-role <iam-role-arn>"
    );
    process.exit(1);
  }
  return args as Args;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  console.log("Test parameters:");
  console.log("  Account:        " + args.accountId);
  console.log("  Region:         " + args.region);
  console.log("  Execution role: " + args.executionRoleArn);
  console.log("");

  const client = new BedrockAgentCoreControlClient({ region: args.region });

  const harnessName = `test_inline_function_${Date.now()}`;

  // Use proper SDK types — no `as never` casts.
  // Field names verified against
  // node_modules/@aws-sdk/client-bedrock-agentcore-control/dist-types/models/models_0.d.ts:
  //
  //   CreateHarnessRequest
  //     - harnessName: string
  //     - executionRoleArn: string
  //     - model: HarnessModelConfiguration { bedrockModelConfig: HarnessBedrockModelConfig { modelId } }
  //     - systemPrompt: HarnessSystemContentBlock[]  ({ text: string }[])
  //     - tools: HarnessTool[]
  //         - type: HarnessToolType ("InlineFunction" | "AgentCoreBrowser" | ...)
  //         - name?: string
  //         - config?: HarnessToolConfiguration { inlineFunction: { description, inputSchema } }
  //     - maxIterations?, maxTokens?, timeoutSeconds?
  const command = new CreateHarnessCommand({
    harnessName,
    executionRoleArn: args.executionRoleArn,
    model: {
      bedrockModelConfig: {
        modelId: "us.anthropic.claude-sonnet-4-5-v1:0",
      },
    },
    systemPrompt: [
      { text: "You are a test agent. Just call the readFile tool with path=test.txt and stop." },
    ],
    tools: [
      {
        type: "inline_function",
        name: "module_readFile",
        config: {
          inlineFunction: {
            description: "Read the contents of a file in the module.",
            inputSchema: {
              type: "object",
              properties: {
                path: { type: "string", description: "Relative path to the file." },
              },
              required: ["path"],
            },
          },
        },
      },
    ],
    maxIterations: 1,
    maxTokens: 1000,
    timeoutSeconds: 60,
  });

  console.log("Calling CreateHarness...");
  console.log("");

  let harnessId: string | undefined;
  try {
    const result = await client.send(command);
    harnessId = result.harness?.harnessId;
    const harnessArn = result.harness?.arn;
    console.log("✓ CreateHarness succeeded.");
    console.log("  Harness ID:  " + harnessId);
    console.log("  Harness ARN: " + harnessArn);
    console.log("");
    console.log("Result:");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("✗ CreateHarness failed.");
    console.error("");
    if (err instanceof Error) {
      console.error("Error name:    " + err.name);
      console.error("Error message: " + err.message);
      const awsErr = err as Error & { $metadata?: { httpStatusCode?: number } };
      if (awsErr.$metadata?.httpStatusCode) {
        console.error("HTTP status:   " + awsErr.$metadata.httpStatusCode);
      }
    } else {
      console.error(String(err));
    }
    process.exit(1);
  }

  // Clean up: delete the test harness
  if (harnessId) {
    console.log("");
    console.log("Cleaning up: deleting test harness...");
    try {
      await client.send(new DeleteHarnessCommand({ harnessId }));
      console.log("✓ Test harness deleted.");
    } catch (err) {
      console.error("Warning: could not delete test harness " + harnessId);
      console.error("  " + (err instanceof Error ? err.message : String(err)));
      console.error("  Delete it manually via the AWS console or `agentcore` CLI.");
    }
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
