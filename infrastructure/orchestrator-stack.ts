/**
 * OrchestratorStack — CDK stack for the orchestrator Lambda, API Gateway, and
 * execution role.
 *
 * Requirements: 5.6, 8.1, 8.2
 *
 * Creates:
 *
 * 1. OrchestratorLambda
 *    - Entry point: app/orchestrator/index.ts
 *    - Node.js 20.x runtime, 15-minute timeout, 1024 MB memory
 *    - Env vars: EDITOR_HARNESS_ARN, REVIEWER_HARNESS_ARN
 *
 * 2. OrchestratorExecutionRole
 *    - bedrock-agentcore:InvokeHarness scoped to exactly the two harness ARNs
 *      supplied as CDK context (no wildcards)
 *    - Standard CloudWatch Logs write permissions (AWSLambdaBasicExecutionRole)
 *    - sts:AssumeRole on the existing agent-harness-editor role so trust gates
 *      can use the editor role's credentials
 *
 * 3. API Gateway REST API
 *    - Single POST /orchestrate route with AWS_IAM authorization
 *    - Lambda integration
 *    - OrchestratorApiResourceArn exported as a stack output
 *
 * CDK context keys (required — synth fails with a clear error if missing):
 *   editorHarnessArn   — ARN of the deployed editor Managed Harness
 *   reviewerHarnessArn — ARN of the deployed reviewer Managed Harness
 */

import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as path from "path";
import { Construct } from "constructs";

export interface OrchestratorStackProps extends cdk.StackProps {
  /**
   * AWS account ID where the preview environments are deployed.
   * Used to scope the sts:AssumeRole on the editor role.
   */
  readonly previewAccountId: string;
}

export class OrchestratorStack extends cdk.Stack {
  /** The orchestrator Lambda function. */
  public readonly orchestratorFunction: lambda.Function;

  /** The API Gateway REST API in front of the Lambda. */
  public readonly api: apigateway.RestApi;

  /** The Lambda execution role. */
  public readonly executionRole: iam.Role;

  constructor(scope: Construct, id: string, props: OrchestratorStackProps) {
    super(scope, id, props);

    // -----------------------------------------------------------------------
    // Read and validate CDK context
    // -----------------------------------------------------------------------
    //
    // Both harness ARNs are required. If either is missing, fail synth with a
    // clear error message so the operator knows exactly what to supply.

    const editorHarnessArn = this.node.tryGetContext("editorHarnessArn") as
      | string
      | undefined;
    const reviewerHarnessArn = this.node.tryGetContext("reviewerHarnessArn") as
      | string
      | undefined;

    const missingKeys: string[] = [];
    if (!editorHarnessArn) missingKeys.push("editorHarnessArn");
    if (!reviewerHarnessArn) missingKeys.push("reviewerHarnessArn");

    if (missingKeys.length > 0) {
      throw new Error(
        `OrchestratorStack: missing required CDK context key(s): ${missingKeys.join(", ")}. ` +
          `Supply them with --context editorHarnessArn=<arn> --context reviewerHarnessArn=<arn> ` +
          `when running cdk synth or cdk deploy. ` +
          `These ARNs are produced by \`agentcore deploy\` (from @aws/agentcore@preview).`
      );
    }

    // TypeScript narrowing — both are strings at this point.
    const editorArn = editorHarnessArn as string;
    const reviewerArn = reviewerHarnessArn as string;

    // -----------------------------------------------------------------------
    // 1. Lambda execution role
    // -----------------------------------------------------------------------
    //
    // Least-privilege:
    //   a) bedrock-agentcore:InvokeHarness on exactly the two harness ARNs.
    //   b) CloudWatch Logs write (standard Lambda execution permissions).
    //   c) sts:AssumeRole on agent-harness-editor so trust gates can use the
    //      editor role's credentials for CDK deploy, sensors, post-deploy.

    this.executionRole = new iam.Role(this, "OrchestratorExecutionRole", {
      roleName: "agent-harness-orchestrator",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description:
        "Execution role for the orchestrator Lambda. " +
        "Grants InvokeHarness on the two Managed Harness ARNs and " +
        "sts:AssumeRole on the editor role for trust-gate operations.",
      // Standard Lambda managed policy for CloudWatch Logs write.
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    });

    // bedrock-agentcore:InvokeHarness scoped to exactly the two harness ARNs.
    // No wildcards — Requirement 8.1.
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeHarness",
        effect: iam.Effect.ALLOW,
        actions: ["bedrock-agentcore:InvokeHarness"],
        resources: [editorArn, reviewerArn],
      })
    );

    // sts:AssumeRole on the existing agent-harness-editor role so the
    // orchestrator's trust gates (sensors, cdk deploy, post-deploy) can
    // assume the editor role's credentials.
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeEditorRole",
        effect: iam.Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: [
          `arn:aws:iam::${props.previewAccountId}:role/agent-harness-editor`,
        ],
      })
    );

    // -----------------------------------------------------------------------
    // 2. Orchestrator Lambda function
    // -----------------------------------------------------------------------
    //
    // Entry point: app/orchestrator/index.ts (handler export named "handler").
    // Node.js 20.x runtime, 15-minute timeout (Lambda maximum), 1024 MB memory.
    // Harness ARNs are passed as environment variables.

    this.orchestratorFunction = new lambdaNodejs.NodejsFunction(
      this,
      "OrchestratorFunction",
      {
        functionName: "agent-harness-orchestrator",
        runtime: lambda.Runtime.NODEJS_20_X,
        // Path to the handler entry point relative to the CDK app root.
        // NodejsFunction resolves the entry relative to the project root.
        entry: path.join(__dirname, "..", "app", "orchestrator", "index.ts"),
        handler: "handler",
        timeout: cdk.Duration.seconds(900), // 15 minutes — Lambda maximum
        memorySize: 1024,
        role: this.executionRole,
        environment: {
          EDITOR_HARNESS_ARN: editorArn,
          REVIEWER_HARNESS_ARN: reviewerArn,
        },
        bundling: {
          // Minify for smaller deployment package; source maps for CloudWatch.
          minify: false,
          sourceMap: true,
          // Exclude aws-sdk v3 packages that are available in the Lambda runtime.
          externalModules: ["@aws-sdk/*"],
        },
      }
    );

    // -----------------------------------------------------------------------
    // 3. API Gateway REST API
    // -----------------------------------------------------------------------
    //
    // Single POST /orchestrate route with AWS_IAM authorization.
    // Lambda integration (proxy integration so the handler receives the full
    // API Gateway event and controls the response shape).

    this.api = new apigateway.RestApi(this, "OrchestratorApi", {
      restApiName: "agent-harness-orchestrator",
      description:
        "API Gateway in front of the orchestrator Lambda. " +
        "AWS_IAM authorization — callers must SigV4-sign their requests.",
      // Disable the default execute-api endpoint if a custom domain is added
      // later; for now keep it enabled so the smoke test can reach it.
      deployOptions: {
        stageName: "prod",
      },
    });

    const orchestrateResource = this.api.root.addResource("orchestrate");

    // Lambda integration — proxy mode so the handler controls the full response.
    const lambdaIntegration = new apigateway.LambdaIntegration(
      this.orchestratorFunction,
      { proxy: true }
    );

    // POST /orchestrate with AWS_IAM authorization. Requirement 8.2.
    orchestrateResource.addMethod("POST", lambdaIntegration, {
      authorizationType: apigateway.AuthorizationType.IAM,
    });

    // -----------------------------------------------------------------------
    // Stack outputs
    // -----------------------------------------------------------------------
    //
    // OrchestratorApiResourceArn is consumed by iam-stack.ts to grant
    // execute-api:Invoke on exactly this resource ARN to the runner role.

    // The resource ARN for the POST /orchestrate method has the form:
    //   arn:aws:execute-api:<region>:<account>:<api-id>/<stage>/POST/orchestrate
    const orchestratorApiResourceArn = this.formatArn({
      service: "execute-api",
      resource: this.api.restApiId,
      resourceName: `${this.api.deploymentStage.stageName}/POST/orchestrate`,
    });

    new cdk.CfnOutput(this, "OrchestratorApiResourceArn", {
      value: orchestratorApiResourceArn,
      description:
        "ARN of the POST /orchestrate API Gateway resource. " +
        "Supply this to IamStack as orchestratorApiResourceArn so the " +
        "GitHub runner role can invoke the orchestrator.",
      exportName: "OrchestratorApiResourceArn",
    });

    new cdk.CfnOutput(this, "OrchestratorApiEndpoint", {
      value: this.api.url,
      description: "Base URL of the orchestrator API Gateway (prod stage).",
      exportName: "OrchestratorApiEndpoint",
    });

    new cdk.CfnOutput(this, "OrchestratorFunctionArn", {
      value: this.orchestratorFunction.functionArn,
      description: "ARN of the orchestrator Lambda function.",
      exportName: "OrchestratorFunctionArn",
    });

    // -----------------------------------------------------------------------
    // Tags
    // -----------------------------------------------------------------------

    cdk.Tags.of(this).add("agent-harness/component", "orchestrator");
    cdk.Tags.of(this).add("agent-harness/managed-by", "cdk");
  }
}
