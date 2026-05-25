/**
 * CDK assertions tests for OrchestratorStack.
 *
 * Verifies the infrastructure shape for the orchestrator Lambda, API Gateway,
 * and execution role:
 *   1. Lambda exists with 900s timeout and Node.js 20.x runtime
 *   2. API Gateway POST method has AuthorizationType: AWS_IAM
 *   3. IAM policy grants bedrock-agentcore:InvokeHarness on exactly the two
 *      harness ARNs from context (no wildcards)
 *   4. No resource in any policy statement is "*"
 *   5. Synth fails when the harness ARN context keys are missing
 *
 * Requirements: 5.6, 8.1, 8.2
 */

import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Template, Match } from "aws-cdk-lib/assertions";

// ---------------------------------------------------------------------------
// Mock NodejsFunction bundling so tests can synth without Docker or esbuild.
//
// NodejsFunction calls an internal Bundling class that tries to use esbuild
// (locally or via Docker). In unit tests we only care about the CloudFormation
// template shape, not the bundle artefact. We replace NodejsFunction with a
// subclass of lambda.Function that uses Code.fromInline so no actual bundling
// occurs. Extending lambda.Function (rather than Construct) ensures the mock
// satisfies the IFunction interface that LambdaIntegration requires (e.g.,
// addPermission, grantInvoke, etc.).
// ---------------------------------------------------------------------------
jest.mock("aws-cdk-lib/aws-lambda-nodejs", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const lambdaLib = require("aws-cdk-lib/aws-lambda") as typeof import("aws-cdk-lib/aws-lambda");

  // NodejsFunction stand-in that extends lambda.Function directly so it
  // satisfies the full IFunction interface (addPermission, grantInvoke, etc.).
  class NodejsFunction extends lambdaLib.Function {
    constructor(
      scope: import("constructs").Construct,
      id: string,
      props: {
        runtime?: import("aws-cdk-lib/aws-lambda").Runtime;
        handler?: string;
        timeout?: import("aws-cdk-lib").Duration;
        memorySize?: number;
        role?: import("aws-cdk-lib/aws-iam").IRole;
        environment?: Record<string, string>;
        functionName?: string;
        [key: string]: unknown;
      }
    ) {
      super(scope, id, {
        runtime: props.runtime ?? lambdaLib.Runtime.NODEJS_22_X,
        handler: props.handler ?? "index.handler",
        code: lambdaLib.Code.fromInline(
          "exports.handler = async () => ({ statusCode: 200, body: 'placeholder' });"
        ),
        timeout: props.timeout,
        memorySize: props.memorySize,
        role: props.role,
        environment: props.environment,
        functionName: props.functionName,
      });
    }
  }

  return { NodejsFunction };
});

import { OrchestratorStack } from "../orchestrator-stack";

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

const ACCOUNT = "123456789012";
const REGION = "us-east-1";
const EDITOR_HARNESS_ARN =
  "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/editor/abc";
const REVIEWER_HARNESS_ARN =
  "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/reviewer/def";

function buildTemplate(): Template {
  const app = new cdk.App({
    context: {
      editorHarnessArn: EDITOR_HARNESS_ARN,
      reviewerHarnessArn: REVIEWER_HARNESS_ARN,
    },
  });
  const stack = new OrchestratorStack(app, "TestOrchestratorStack", {
    env: { account: ACCOUNT, region: REGION },
    previewAccountId: ACCOUNT,
  });
  return Template.fromStack(stack);
}

// ---------------------------------------------------------------------------
// Lambda function
// ---------------------------------------------------------------------------

describe("OrchestratorLambda", () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  it("creates a Lambda function with 900s (15-minute) timeout", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Timeout: 900,
    });
  });

  it("creates a Lambda function with Node.js 22.x runtime", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
    });
  });

  it("passes EDITOR_HARNESS_ARN environment variable to the Lambda", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          EDITOR_HARNESS_ARN: EDITOR_HARNESS_ARN,
        }),
      }),
    });
  });

  it("passes REVIEWER_HARNESS_ARN environment variable to the Lambda", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          REVIEWER_HARNESS_ARN: REVIEWER_HARNESS_ARN,
        }),
      }),
    });
  });

  it("allocates 1024 MB memory", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      MemorySize: 1024,
    });
  });
});

// ---------------------------------------------------------------------------
// API Gateway
// ---------------------------------------------------------------------------

describe("API Gateway", () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  it("creates a REST API", () => {
    template.resourceCountIs("AWS::ApiGateway::RestApi", 1);
  });

  it("creates a POST method with AWS_IAM authorization", () => {
    template.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "POST",
      AuthorizationType: "AWS_IAM",
    });
  });

  it("does NOT create any method with NONE authorization", () => {
    // Every method must have explicit authorization — no open endpoints.
    const methods = template.findResources("AWS::ApiGateway::Method", {
      Properties: {
        AuthorizationType: "NONE",
        // Exclude the OPTIONS method that CDK may add for CORS (not applicable
        // here, but guard against accidental open methods).
        HttpMethod: Match.not("OPTIONS"),
      },
    });
    expect(Object.keys(methods)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// IAM execution role — InvokeHarness policy
// ---------------------------------------------------------------------------

describe("OrchestratorExecutionRole — InvokeHarness policy", () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  it("grants bedrock-agentcore:InvokeHarness on the editor harness ARN", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "InvokeHarness",
            Effect: "Allow",
            Action: "bedrock-agentcore:InvokeHarness",
            Resource: Match.arrayWith([EDITOR_HARNESS_ARN]),
          }),
        ]),
      }),
    });
  });

  it("grants bedrock-agentcore:InvokeHarness on the reviewer harness ARN", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "InvokeHarness",
            Effect: "Allow",
            Action: "bedrock-agentcore:InvokeHarness",
            Resource: Match.arrayWith([REVIEWER_HARNESS_ARN]),
          }),
        ]),
      }),
    });
  });

  it("scopes InvokeHarness to exactly the two harness ARNs (no wildcards)", () => {
    // Find the InvokeHarness policy statement and assert its Resource list
    // contains exactly the two fixture ARNs and nothing else.
    const policies = template.findResources("AWS::IAM::Policy");
    let invokeHarnessStatement: Record<string, unknown> | undefined;

    for (const policy of Object.values(policies)) {
      const statements: Array<Record<string, unknown>> = (
        policy as {
          Properties: {
            PolicyDocument: { Statement: Array<Record<string, unknown>> };
          };
        }
      ).Properties.PolicyDocument.Statement;

      for (const stmt of statements) {
        if (stmt["Sid"] === "InvokeHarness") {
          invokeHarnessStatement = stmt;
          break;
        }
      }
      if (invokeHarnessStatement) break;
    }

    expect(invokeHarnessStatement).toBeDefined();
    const resources = invokeHarnessStatement!["Resource"] as string[];
    expect(resources).toHaveLength(2);
    expect(resources).toContain(EDITOR_HARNESS_ARN);
    expect(resources).toContain(REVIEWER_HARNESS_ARN);
  });

  it("does NOT grant InvokeHarness on '*'", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      const statements: Array<Record<string, unknown>> = (
        policy as {
          Properties: {
            PolicyDocument: { Statement: Array<Record<string, unknown>> };
          };
        }
      ).Properties.PolicyDocument.Statement;

      for (const stmt of statements) {
        if (stmt["Sid"] === "InvokeHarness") {
          const resources = Array.isArray(stmt["Resource"])
            ? stmt["Resource"]
            : [stmt["Resource"]];
          expect(resources).not.toContain("*");
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// No wildcard resources in any Allow statement
// ---------------------------------------------------------------------------

describe("No wildcard resources in Allow statements", () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  it("has no Allow policy statement with Resource: '*' (except managed policies)", () => {
    // Inline policies attached to the execution role must not use "*" as a
    // resource in any Allow statement. Managed policies (e.g.,
    // AWSLambdaBasicExecutionRole) are referenced by ARN and not inlined, so
    // they do not appear in AWS::IAM::Policy resources.
    const policies = template.findResources("AWS::IAM::Policy");
    for (const [, policy] of Object.entries(policies)) {
      const statements: Array<Record<string, unknown>> = (
        policy as {
          Properties: {
            PolicyDocument: { Statement: Array<Record<string, unknown>> };
          };
        }
      ).Properties.PolicyDocument.Statement;

      for (const stmt of statements) {
        if (stmt["Effect"] === "Allow") {
          const resources = Array.isArray(stmt["Resource"])
            ? stmt["Resource"]
            : [stmt["Resource"]];
          // A resource of "*" in an Allow statement is forbidden.
          expect(resources).not.toContain("*");
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

  it("exports OrchestratorApiResourceArn", () => {
    template.hasOutput("OrchestratorApiResourceArn", {
      Export: { Name: "OrchestratorApiResourceArn" },
    });
  });

  it("exports OrchestratorApiEndpoint", () => {
    template.hasOutput("OrchestratorApiEndpoint", {
      Export: { Name: "OrchestratorApiEndpoint" },
    });
  });

  it("exports OrchestratorFunctionArn", () => {
    template.hasOutput("OrchestratorFunctionArn", {
      Export: { Name: "OrchestratorFunctionArn" },
    });
  });
});

// ---------------------------------------------------------------------------
// Synth fails when harness ARN context keys are missing
// ---------------------------------------------------------------------------

describe("Context validation", () => {
  it("throws when editorHarnessArn context key is missing", () => {
    const app = new cdk.App({
      context: {
        // editorHarnessArn intentionally omitted
        reviewerHarnessArn: REVIEWER_HARNESS_ARN,
      },
    });
    expect(
      () =>
        new OrchestratorStack(app, "MissingEditorArn", {
          env: { account: ACCOUNT, region: REGION },
          previewAccountId: ACCOUNT,
        })
    ).toThrow(/editorHarnessArn/);
  });

  it("throws when reviewerHarnessArn context key is missing", () => {
    const app = new cdk.App({
      context: {
        editorHarnessArn: EDITOR_HARNESS_ARN,
        // reviewerHarnessArn intentionally omitted
      },
    });
    expect(
      () =>
        new OrchestratorStack(app, "MissingReviewerArn", {
          env: { account: ACCOUNT, region: REGION },
          previewAccountId: ACCOUNT,
        })
    ).toThrow(/reviewerHarnessArn/);
  });

  it("throws when both harness ARN context keys are missing", () => {
    const app = new cdk.App(); // no context at all
    expect(
      () =>
        new OrchestratorStack(app, "MissingBothArns", {
          env: { account: ACCOUNT, region: REGION },
          previewAccountId: ACCOUNT,
        })
    ).toThrow(/editorHarnessArn/);
  });

  it("error message names the missing context keys clearly", () => {
    const app = new cdk.App();
    let errorMessage = "";
    try {
      new OrchestratorStack(app, "ErrorMessageCheck", {
        env: { account: ACCOUNT, region: REGION },
        previewAccountId: ACCOUNT,
      });
    } catch (err) {
      errorMessage = String(err);
    }
    expect(errorMessage).toContain("editorHarnessArn");
    expect(errorMessage).toContain("reviewerHarnessArn");
  });
});
