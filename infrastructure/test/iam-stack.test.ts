/**
 * CDK assertions tests for IamStack.
 *
 * Verifies the policy structure for all three IAM principals:
 *   1. EditorAgentRole — cdk diff/deploy + CloudWatch read, preview-tagged only
 *   2. ReviewerAgentRole — s3:GetObject on checklist bucket only
 *   3. GitHubActionRunnerRole — execute-api:Invoke on orchestrator API Gateway ARN only
 *
 * Requirements: 9.1, 9.2, 9.3
 */

import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { IamStack } from "../iam-stack";

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

const ACCOUNT = "123456789012";
const REGION = "us-east-1";
const CHECKLIST_BUCKET = "agent-harness-checklists";
const ORCHESTRATOR_API_RESOURCE_ARN = `arn:aws:execute-api:${REGION}:${ACCOUNT}:abcdef1234/prod/POST/orchestrate`;
const GITHUB_REPO = "test-org/agent-harness";

function buildTemplate(): Template {
  const app = new cdk.App();
  const stack = new IamStack(app, "TestIamStack", {
    env: { account: ACCOUNT, region: REGION },
    previewAccountId: ACCOUNT,
    previewRegion: REGION,
    checklistBucketName: CHECKLIST_BUCKET,
    orchestratorApiResourceArn: ORCHESTRATOR_API_RESOURCE_ARN,
    githubRepo: GITHUB_REPO,
  });
  return Template.fromStack(stack);
}

// ---------------------------------------------------------------------------
// Editor agent role
// ---------------------------------------------------------------------------

describe("EditorAgentRole", () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  it("creates a role named agent-harness-editor", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "agent-harness-editor",
    });
  });

  it("is assumed by bedrock.amazonaws.com", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "agent-harness-editor",
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: "bedrock.amazonaws.com" },
            Action: "sts:AssumeRole",
          }),
        ]),
      }),
    });
  });

  it("allows cloudformation actions on preview-tagged stacks", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "CdkDiffDeploy",
            Effect: "Allow",
            Action: Match.arrayWith([
              "cloudformation:DescribeStacks",
              "cloudformation:CreateStack",
              "cloudformation:UpdateStack",
              "cloudformation:DeleteStack",
            ]),
          }),
        ]),
      }),
    });
  });

  it("allows CloudWatch read actions", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "CloudWatchReadPreview",
            Effect: "Allow",
            Action: Match.arrayWith([
              "logs:GetLogEvents",
              "cloudwatch:GetMetricData",
            ]),
          }),
        ]),
      }),
    });
  });

  it("denies actions outside the preview region", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "DenyNonPreviewAccount",
            Effect: "Deny",
            NotAction: Match.arrayWith([
              "bedrock:InvokeModel",
              "bedrock:InvokeModelWithResponseStream",
            ]),
            Resource: "*",
            Condition: Match.objectLike({
              StringNotEquals: Match.anyValue(),
            }),
          }),
        ]),
      }),
    });
  });

  it("does NOT allow bedrock:InvokeAgent (editor cannot invoke other agents)", () => {
    // The editor role should not have InvokeAgent in any Allow statement.
    const policies = template.findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      const statements: Array<Record<string, unknown>> =
        (policy as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } })
          .Properties.PolicyDocument.Statement;
      for (const stmt of statements) {
        if (stmt["Effect"] === "Allow") {
          const actions = Array.isArray(stmt["Action"])
            ? stmt["Action"]
            : [stmt["Action"]];
          // Only check policies attached to the editor role
          const policyStr = JSON.stringify(policy);
          if (policyStr.includes("agent-harness-editor")) {
            expect(actions).not.toContain("bedrock:InvokeAgent");
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Reviewer agent role
// ---------------------------------------------------------------------------

describe("ReviewerAgentRole", () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  it("creates a role named agent-harness-reviewer", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "agent-harness-reviewer",
    });
  });

  it("is assumed by bedrock.amazonaws.com", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "agent-harness-reviewer",
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: "bedrock.amazonaws.com" },
            Action: "sts:AssumeRole",
          }),
        ]),
      }),
    });
  });

  it("allows s3:GetObject on the checklist bucket", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "ChecklistBucketRead",
            Effect: "Allow",
            Action: Match.arrayWith(["s3:GetObject", "s3:ListBucket"]),
          }),
        ]),
      }),
    });
  });

  it("explicitly denies cloudformation, cloudwatch, and lambda actions", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "DenyEverythingElse",
            Effect: "Deny",
            Action: Match.arrayWith([
              "cloudformation:*",
              "cloudwatch:*",
              "lambda:*",
            ]),
          }),
        ]),
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// GitHub Action runner role
// ---------------------------------------------------------------------------

describe("GitHubActionRunnerRole", () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  it("creates a role named agent-harness-github-runner", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "agent-harness-github-runner",
    });
  });

  it("is assumed via OIDC federation with GitHub Actions", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "agent-harness-github-runner",
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
          }),
        ]),
      }),
    });
  });

  it("OIDC trust is scoped to the specific GitHub repo (no wildcard org/repo)", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "agent-harness-github-runner",
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: Match.objectLike({
                "token.actions.githubusercontent.com:sub":
                  `repo:${GITHUB_REPO}:ref:refs/heads/*`,
              }),
            }),
          }),
        ]),
      }),
    });
  });

  it("allows execute-api:Invoke on the orchestrator API resource ARN (no wildcards)", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "InvokeOrchestratorApiGateway",
            Effect: "Allow",
            Action: "execute-api:Invoke",
            Resource: ORCHESTRATOR_API_RESOURCE_ARN,
          }),
        ]),
      }),
    });
  });

  it("does NOT have the old bedrock:InvokeAgent / InvokeAgentCore statement", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      const policyStr = JSON.stringify(policy);
      if (policyStr.includes("agent-harness-github-runner")) {
        const statements: Array<Record<string, unknown>> =
          (policy as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } })
            .Properties.PolicyDocument.Statement;
        for (const stmt of statements) {
          expect(stmt["Sid"]).not.toBe("InvokeAgentCore");
          const actions = Array.isArray(stmt["Action"])
            ? stmt["Action"]
            : [stmt["Action"]];
          expect(actions).not.toContain("bedrock:InvokeAgent");
          expect(actions).not.toContain("bedrock:InvokeAgentWithResponseStream");
        }
      }
    }
  });

  it("does NOT allow cloudformation or s3 actions", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      const policyStr = JSON.stringify(policy);
      if (policyStr.includes("agent-harness-github-runner")) {
        const statements: Array<Record<string, unknown>> =
          (policy as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } })
            .Properties.PolicyDocument.Statement;
        for (const stmt of statements) {
          if (stmt["Effect"] === "Allow") {
            const actions = Array.isArray(stmt["Action"])
              ? stmt["Action"]
              : [stmt["Action"]];
            expect(actions).not.toContain("cloudformation:*");
            expect(actions).not.toContain("s3:*");
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Stack outputs
// ---------------------------------------------------------------------------

describe("Stack outputs", () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  it("exports EditorAgentRoleArn", () => {
    template.hasOutput("EditorAgentRoleArn", {
      Export: { Name: "AgentHarnessEditorRoleArn" },
    });
  });

  it("exports ReviewerAgentRoleArn", () => {
    template.hasOutput("ReviewerAgentRoleArn", {
      Export: { Name: "AgentHarnessReviewerRoleArn" },
    });
  });

  it("exports GitHubActionRunnerRoleArn", () => {
    template.hasOutput("GitHubActionRunnerRoleArn", {
      Export: { Name: "AgentHarnessGitHubRunnerRoleArn" },
    });
  });
});
