import * as cdk from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export interface CodeBuildOrchestratorStackProps extends cdk.StackProps {
  /** ARN of the Editor Managed Harness */
  editorHarnessArn: string;
  /** ARN of the Reviewer Managed Harness */
  reviewerHarnessArn: string;
  /** CodeBuild compute type (default: SMALL) */
  computeType?: codebuild.ComputeType;
  /** Build timeout in minutes (default: 60, max: 480) */
  timeoutMinutes?: number;
}

export class CodeBuildOrchestratorStack extends cdk.Stack {
  /** The CodeBuild project */
  public readonly project: codebuild.Project;
  /** The IAM role used by the CodeBuild project */
  public readonly codeBuildRole: iam.Role;

  constructor(scope: Construct, id: string, props: CodeBuildOrchestratorStackProps) {
    super(scope, id, props);

    const computeType = props.computeType ?? codebuild.ComputeType.SMALL;
    const timeoutMinutes = Math.min(props.timeoutMinutes ?? 60, 480);

    // IAM Role for the CodeBuild project
    this.codeBuildRole = new iam.Role(this, "CodeBuildOrchestratorRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      description: "IAM role for the CodeBuild orchestrator project",
    });

    // Permission: Invoke AgentCore Managed Harnesses
    // Using bedrock-agentcore:* scoped to the two harness ARNs because
    // the preview API's action names are not stable (InvokeHarness,
    // InvokeAgentRuntime, etc. have changed across SDK versions).
    this.codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeHarness",
        effect: iam.Effect.ALLOW,
        actions: ["bedrock-agentcore:*"],
        resources: [props.editorHarnessArn, props.reviewerHarnessArn],
      })
    );

    // Permission: CloudFormation for preview stacks only
    this.codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudFormationPreview",
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
          "cloudformation:GetTemplateSummary",
        ],
        resources: [
          `arn:aws:cloudformation:${this.region}:${this.account}:stack/FanoutPreview-*/*`,
          `arn:aws:cloudformation:${this.region}:${this.account}:stack/CDKToolkit/*`,
        ],
      })
    );

    // Permission: S3 access scoped to CDK bootstrap assets bucket
    this.codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "S3CdkAssets",
        effect: iam.Effect.ALLOW,
        actions: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:ListBucket",
          "s3:GetBucketLocation",
          "s3:DeleteObject",
        ],
        resources: [
          `arn:aws:s3:::cdk-*-assets-${this.account}-${this.region}`,
          `arn:aws:s3:::cdk-*-assets-${this.account}-${this.region}/*`,
        ],
      })
    );

    // Permission: IAM PassRole scoped to preview stack roles
    this.codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "IamPassRolePreview",
        effect: iam.Effect.ALLOW,
        actions: ["iam:PassRole"],
        resources: [
          `arn:aws:iam::${this.account}:role/cdk-*-${this.region}`,
          `arn:aws:iam::${this.account}:role/FanoutPreview-*`,
        ],
      })
    );

    // Permission: Assume CDK bootstrap roles for cdk deploy
    this.codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeBootstrapRoles",
        effect: iam.Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: [
          `arn:aws:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-${this.region}`,
        ],
      })
    );

    // Permission: SSM Parameter Store read (CDK bootstrap version check)
    this.codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "SsmBootstrapVersion",
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/*`,
        ],
      })
    );

    // Permission: CloudWatch Logs for this project's log group
    this.codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchLogs",
        effect: iam.Effect.ALLOW,
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/codebuild/agent-harness-orchestrator:*`,
        ],
      })
    );

    // Permission: API Gateway read (for retrieving API keys during post-deploy gate)
    this.codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ApiGatewayReadKeys",
        effect: iam.Effect.ALLOW,
        actions: ["apigateway:GET"],
        resources: [`arn:aws:apigateway:${this.region}::/apikeys/*`],
      })
    );

    // Inline buildspec
    const buildSpec = codebuild.BuildSpec.fromObject({
      version: "0.2",
      env: {
        variables: {
          LOCAL_MODE: "true",
        },
      },
      phases: {
        install: {
          "runtime-versions": {
            nodejs: 22,
          },
          commands: [
            "npm ci --workspace=modules/fanout --workspace=app/codebuild --workspace=harness/loop --workspace=agents/editor --workspace=agents/reviewer",
          ],
        },
        build: {
          commands: ["npx ts-node app/codebuild/main.ts"],
        },
        post_build: {
          commands: [
            "cp session-record.json $CODEBUILD_SRC_DIR/artifacts/ 2>/dev/null || true",
          ],
        },
      },
      artifacts: {
        files: ["artifacts/session-record.json"],
        "discard-paths": "no",
      },
      cache: {
        paths: ["node_modules/**/*"],
      },
    });

    // CodeBuild Project
    this.project = new codebuild.Project(this, "OrchestratorProject", {
      projectName: "agent-harness-orchestrator",
      description: "Bounded-loop orchestrator for the agent harness",
      role: this.codeBuildRole,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType,
      },
      buildSpec,
      timeout: cdk.Duration.minutes(timeoutMinutes),
      environmentVariables: {
        EDITOR_HARNESS_ARN: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: props.editorHarnessArn,
        },
        REVIEWER_HARNESS_ARN: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: props.reviewerHarnessArn,
        },
        LOCAL_MODE: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: "false",
        },
      },
    });

    // Stack outputs
    new cdk.CfnOutput(this, "ProjectName", {
      value: this.project.projectName,
      description: "CodeBuild project name",
    });

    new cdk.CfnOutput(this, "ProjectArn", {
      value: this.project.projectArn,
      description: "CodeBuild project ARN",
    });
  }
}
