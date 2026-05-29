#!/usr/bin/env node
/**
 * Unified CDK app entry point for the Agent Harness infrastructure.
 *
 * Provisions the CodeBuild orchestrator project with IAM permissions
 * for AgentCore harness invocation and CDK preview deployments.
 *
 * Requirements: 10.1, 10.2
 */

import * as cdk from "aws-cdk-lib";
import { CodeBuildOrchestratorStack } from "./codebuild-orchestrator-stack";

const app = new cdk.App();

// ---------------------------------------------------------------------------
// Context values -- configurable via cdk.json or CLI:
//   cdk deploy --context editorHarnessArn=arn:aws:... --context reviewerHarnessArn=arn:aws:...
// ---------------------------------------------------------------------------

const editorHarnessArn = app.node.tryGetContext("editorHarnessArn");
const reviewerHarnessArn = app.node.tryGetContext("reviewerHarnessArn");

if (!editorHarnessArn || !reviewerHarnessArn) {
  throw new Error(
    "Missing required CDK context values. Provide editorHarnessArn and reviewerHarnessArn " +
      'via cdk.json context or CLI: --context editorHarnessArn="arn:..." --context reviewerHarnessArn="arn:..."'
  );
}

// ---------------------------------------------------------------------------
// Stack: CodeBuild Orchestrator
// ---------------------------------------------------------------------------

new CodeBuildOrchestratorStack(app, "AgentHarnessCodeBuildStack", {
  editorHarnessArn,
  reviewerHarnessArn,
  description:
    "CodeBuild orchestrator project with IAM role for bounded-loop agent harness execution.",
});
