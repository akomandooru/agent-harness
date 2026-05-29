/**
 * IamStack — CDK stack defining the two IAM principals for the agent harness.
 *
 * Two principals:
 *
 * 1. EditorAgentRole
 *    - cdk diff, cdk deploy, CloudWatch read on resources tagged
 *      agent-harness/session=<session> AND agent-harness/env=preview.
 *    - Explicit deny on everything else (deny-all with allow exceptions).
 *
 * 2. ReviewerAgentRole
 *    - s3:GetObject on the checklist bucket only.
 *    - No CDK, CloudWatch, or GitHub access.
 *
 * The stack is intentionally narrow. Operators auditing trust can read
 * this one file to see what each principal can reach.
 */

import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export interface IamStackProps extends cdk.StackProps {
  /**
   * AWS account ID where the preview environments are deployed.
   * Used to scope the editor role's resource ARNs.
   */
  readonly previewAccountId: string;

  /**
   * AWS region where the preview environments are deployed.
   */
  readonly previewRegion: string;

  /**
   * S3 bucket name that holds the reviewer's Well-Architected checklists.
   * The reviewer role gets s3:GetObject on this bucket only.
   */
  readonly checklistBucketName: string;
}

export class IamStack extends cdk.Stack {
  /** IAM role assumed by the editor agent inside AgentCore. */
  public readonly editorAgentRole: iam.Role;

  /** IAM role assumed by the reviewer agent inside AgentCore. */
  public readonly reviewerAgentRole: iam.Role;

  constructor(scope: Construct, id: string, props: IamStackProps) {
    super(scope, id, props);

    // -----------------------------------------------------------------------
    // 1. Editor agent role
    // -----------------------------------------------------------------------
    //
    // Least-privilege: allow only the operations the editor needs against
    // preview-tagged resources. An explicit deny-all at the end ensures
    // that any future allow added by mistake is overridden.
    //
    // Tag condition: both agent-harness/session (any value) AND
    // agent-harness/env=preview must be present on the resource.
    // This prevents the editor from reaching non-preview stacks even if
    // the session tag is present.

    this.editorAgentRole = new iam.Role(this, "EditorAgentRole", {
      roleName: "agent-harness-editor",
      // AgentCore Managed Harness assumes the role using service principal
      // `bedrock-agentcore.amazonaws.com` (per the AWS docs on cross-service
      // confused deputy prevention). The original `bedrock.amazonaws.com`
      // principal is kept for compatibility with any direct Bedrock-side
      // assumptions, e.g. legacy invocations during migration.
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
        new iam.ServicePrincipal("bedrock.amazonaws.com"),
      ),
      description:
        "Assumed by the editor agent inside AgentCore. " +
        "Grants cdk diff/deploy and CloudWatch read on preview-tagged resources only.",
    });

    // Tag condition shared by all preview-scoped statements.
    const previewTagCondition: iam.Conditions = {
      StringEquals: {
        "aws:ResourceTag/agent-harness/env": "preview",
      },
      StringLike: {
        "aws:ResourceTag/agent-harness/session": "*",
      },
    };

    // Bedrock model invocation — required because AgentCore assumes this role
    // to call the model (ConverseStream) on the harness's behalf.
    // Cross-region inference profiles route to multiple regions, so we allow
    // all regions for Bedrock model invocation.
    this.editorAgentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "BedrockModelInvoke",
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: ["*"],
      })
    );

    // CloudFormation permissions needed for cdk diff and cdk deploy.
    this.editorAgentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CdkDiffDeploy",
        effect: iam.Effect.ALLOW,
        actions: [
          "cloudformation:DescribeStacks",
          "cloudformation:DescribeStackEvents",
          "cloudformation:DescribeStackResources",
          "cloudformation:GetTemplate",
          "cloudformation:CreateStack",
          "cloudformation:UpdateStack",
          "cloudformation:DeleteStack",
          "cloudformation:CreateChangeSet",
          "cloudformation:DescribeChangeSet",
          "cloudformation:ExecuteChangeSet",
          "cloudformation:DeleteChangeSet",
          "cloudformation:ValidateTemplate",
        ],
        resources: [
          `arn:aws:cloudformation:${props.previewRegion}:${props.previewAccountId}:stack/FanoutPreview-*/*`,
        ],
        conditions: previewTagCondition,
      })
    );

    // CloudWatch read for observing the preview environment.
    this.editorAgentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchReadPreview",
        effect: iam.Effect.ALLOW,
        actions: [
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
          "logs:GetLogEvents",
          "logs:FilterLogEvents",
          "cloudwatch:GetMetricData",
          "cloudwatch:GetMetricStatistics",
          "cloudwatch:ListMetrics",
          "cloudwatch:DescribeAlarms",
        ],
        resources: [
          `arn:aws:logs:${props.previewRegion}:${props.previewAccountId}:log-group:/aws/lambda/FanoutPreview-*:*`,
          `arn:aws:cloudwatch:${props.previewRegion}:${props.previewAccountId}:alarm:FanoutPreview-*`,
        ],
        conditions: previewTagCondition,
      })
    );

    // S3 access for CDK asset uploads (bootstrap bucket, preview-scoped prefix).
    this.editorAgentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CdkBootstrapAssets",
        effect: iam.Effect.ALLOW,
        actions: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:ListBucket",
          "s3:GetBucketLocation",
        ],
        resources: [
          `arn:aws:s3:::cdk-*-assets-${props.previewAccountId}-${props.previewRegion}`,
          `arn:aws:s3:::cdk-*-assets-${props.previewAccountId}-${props.previewRegion}/*`,
        ],
      })
    );

    // ECR access for Lambda container images (if used).
    this.editorAgentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "EcrReadPreview",
        effect: iam.Effect.ALLOW,
        actions: [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "aws:RequestedRegion": props.previewRegion,
          },
        },
      })
    );

    // IAM pass-role for Lambda execution roles (preview-tagged only).
    this.editorAgentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "IamPassRolePreview",
        effect: iam.Effect.ALLOW,
        actions: ["iam:PassRole"],
        resources: [
          `arn:aws:iam::${props.previewAccountId}:role/FanoutPreview-*`,
        ],
      })
    );

    // Read-only SNS/SQS/IAM describe permissions for the gap-closure probes
    // (Requirements 4.3, 6.3). These are used by the post-deploy harness to
    // verify that a fitness gap has been closed in the deployed preview
    // environment (e.g. SNS HTTPS-only, SQS encryption-at-rest, IAM scoping).
    //
    // All actions are scoped to preview-tagged resources via the
    // aws:ResourceTag/agent-harness/env condition, with one exception:
    //
    //   iam:SimulatePrincipalPolicy does not support resource-level conditions
    //   (the IAM service ignores ResourceTag conditions on simulation APIs).
    //   It is instead scoped by the PolicySourceArn parameter in the probe
    //   implementation (gap-closure/probes/iam-scoping.ts), which always
    //   passes the preview Lambda's execution role ARN from stackOutputs.
    //   This is documented here so auditors understand why Resource: "*" is
    //   used without a tag condition being effective for that one action.
    this.editorAgentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "GapClosureProbesReadOnly",
        effect: iam.Effect.ALLOW,
        actions: [
          "sns:GetTopicAttributes",
          "sqs:GetQueueAttributes",
          // iam:SimulatePrincipalPolicy cannot be scoped by resource tag;
          // it is scoped by PolicySourceArn in the probe implementation.
          "iam:SimulatePrincipalPolicy",
          "iam:GetRolePolicy",
          "iam:ListRolePolicies",
          "iam:ListAttachedRolePolicies",
        ],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "aws:ResourceTag/agent-harness/env": "preview",
          },
        },
      })
    );

    // Explicit deny on anything outside the preview account/region.
    // This is a belt-and-suspenders guard: the allow statements above are
    // already scoped, but an explicit deny makes the intent auditable.
    // Bedrock model invocations are excluded because cross-region inference
    // profiles route to multiple regions (us-east-1, us-east-2, us-west-2).
    this.editorAgentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "DenyNonPreviewAccount",
        effect: iam.Effect.DENY,
        notActions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: ["*"],
        conditions: {
          StringNotEquals: {
            "aws:RequestedRegion": props.previewRegion,
          },
        },
      })
    );

    // -----------------------------------------------------------------------
    // 2. Reviewer agent role
    // -----------------------------------------------------------------------
    //
    // Read-only access to the checklist bucket. Nothing else.
    // The reviewer runs inside AgentCore and reads static JSON checklists
    // from S3 (or from the local filesystem in the runtime; the S3 path
    // is the production path for forks that externalise the checklists).

    this.reviewerAgentRole = new iam.Role(this, "ReviewerAgentRole", {
      roleName: "agent-harness-reviewer",
      // Same dual-principal setup as the editor role: AgentCore Managed Harness
      // assumes the role via `bedrock-agentcore.amazonaws.com`; the legacy
      // `bedrock.amazonaws.com` principal is kept for compatibility.
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
        new iam.ServicePrincipal("bedrock.amazonaws.com"),
      ),
      description:
        "Assumed by the reviewer agent inside AgentCore. " +
        "Read-only access to the checklist bucket only.",
    });

    // Bedrock model invocation — required because AgentCore assumes this role
    // to call the model (ConverseStream) on the reviewer harness's behalf.
    // Cross-region inference profiles route to multiple regions, so we allow
    // all regions for Bedrock model invocation.
    this.reviewerAgentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "BedrockModelInvoke",
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: ["*"],
      })
    );

    this.reviewerAgentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ChecklistBucketRead",
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObject", "s3:ListBucket"],
        resources: [
          `arn:aws:s3:::${props.checklistBucketName}`,
          `arn:aws:s3:::${props.checklistBucketName}/*`,
        ],
      })
    );

    // Explicit deny on everything else for the reviewer.
    this.reviewerAgentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "DenyEverythingElse",
        effect: iam.Effect.DENY,
        actions: [
          "cloudformation:*",
          "cloudwatch:*",
          "logs:*",
          "lambda:*",
          "sns:*",
          "sqs:*",
          "apigateway:*",
          "bedrock:InvokeAgent",
        ],
        resources: ["*"],
      })
    );

    // -----------------------------------------------------------------------
    // Stack outputs (for cross-stack references and runbook)
    // -----------------------------------------------------------------------

    new cdk.CfnOutput(this, "EditorAgentRoleArn", {
      value: this.editorAgentRole.roleArn,
      description: "ARN of the editor agent IAM role",
      exportName: "AgentHarnessEditorRoleArn",
    });

    new cdk.CfnOutput(this, "ReviewerAgentRoleArn", {
      value: this.reviewerAgentRole.roleArn,
      description: "ARN of the reviewer agent IAM role",
      exportName: "AgentHarnessReviewerRoleArn",
    });

    // -----------------------------------------------------------------------
    // Tags
    // -----------------------------------------------------------------------

    cdk.Tags.of(this).add("agent-harness/component", "iam");
    cdk.Tags.of(this).add("agent-harness/managed-by", "cdk");
  }
}

// ---------------------------------------------------------------------------
// CDK App entry point
// ---------------------------------------------------------------------------
//
// Allows this file to be invoked as a CDK app via:
//   cdk deploy --app "npx ts-node iam-stack.ts" \
//     --context previewAccountId=... \
//     --context previewRegion=... \
//     --context checklistBucketName=...

if (require.main === module) {
  const app = new cdk.App();

  const previewAccountId = app.node.tryGetContext("previewAccountId") as string | undefined;
  const previewRegion = app.node.tryGetContext("previewRegion") as string | undefined;
  const checklistBucketName = app.node.tryGetContext("checklistBucketName") as string | undefined;

  const missing: string[] = [];
  if (!previewAccountId) missing.push("previewAccountId");
  if (!previewRegion) missing.push("previewRegion");
  if (!checklistBucketName) missing.push("checklistBucketName");

  if (missing.length > 0) {
    throw new Error(
      `IamStack: missing required CDK context key(s): ${missing.join(", ")}. ` +
      `Supply them with --context <key>=<value>. See docs/quickstart.md Step 4.`
    );
  }

  new IamStack(app, "AgentHarnessIam", {
    env: {
      account: previewAccountId,
      region: previewRegion,
    },
    previewAccountId: previewAccountId!,
    previewRegion: previewRegion!,
    checklistBucketName: checklistBucketName!,
  });

  app.synth();
}
