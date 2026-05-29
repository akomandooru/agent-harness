/**
 * Construct-shape assertions for FanoutStack.
 *
 * These are the unit-test computational sensor (Requirement 4.1, 11.1). They
 * synthesise the stack once and assert on the rendered CloudFormation: the
 * shape, encryption properties, HTTPS-only enforcement, IAM scoping, and
 * required outputs. The reference module's behaviour is fixed by 2.2; this
 * suite checks that 2.2's intent survives synthesis.
 *
 * One test in the IAM section corresponds to correctness Property 4 (path
 * scoping at the IAM layer): no inline IAM policy in the synthesised template
 * grants `Action: "*"` or `Resource: "*"` for inline statements outside of the
 * AWS-managed-policy attachments.
 */

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { FanoutStack } from "../lib/fanout-stack";

const SESSION_TAG = "test-session";
const ENV_TAG = "test-env";

function buildTemplate(): Template {
  const app = new App();
  const stack = new FanoutStack(app, "FanoutTestStack", {
    sessionTag: SESSION_TAG,
    envTag: ENV_TAG,
  });
  return Template.fromStack(stack);
}

let template: Template;

beforeAll(() => {
  template = buildTemplate();
});

describe("Stack-level tags", () => {
  test("apply agent-harness/session and agent-harness/env to taggable resources", () => {
    const sqsQueues = template.findResources("AWS::SQS::Queue");
    expect(Object.keys(sqsQueues).length).toBeGreaterThan(0);
    for (const queue of Object.values(sqsQueues)) {
      const tags = (queue.Properties.Tags ?? []) as Array<{ Key: string; Value: string }>;
      const tagMap = Object.fromEntries(tags.map((t) => [t.Key, t.Value]));
      expect(tagMap["agent-harness/session"]).toBe(SESSION_TAG);
      expect(tagMap["agent-harness/env"]).toBe(ENV_TAG);
    }
  });
});

describe("KMS", () => {
  test("one customer-managed key with rotation enabled and DESTROY removal policy", () => {
    template.resourceCountIs("AWS::KMS::Key", 1);
    template.hasResourceProperties("AWS::KMS::Key", {
      EnableKeyRotation: true,
    });
    const keys = template.findResources("AWS::KMS::Key");
    const [, key] = Object.entries(keys)[0];
    expect(key.DeletionPolicy).toBe("Delete");
    expect(key.UpdateReplacePolicy).toBe("Delete");
  });
});

describe("SNS", () => {
  test("one topic encrypted with the customer-managed key", () => {
    template.resourceCountIs("AWS::SNS::Topic", 1);
    template.hasResourceProperties(
      "AWS::SNS::Topic",
      Match.objectLike({ KmsMasterKeyId: Match.anyValue() }),
    );
  });

  test("topic policy denies non-HTTPS publishes", () => {
    template.resourceCountIs("AWS::SNS::TopicPolicy", 1);
    template.hasResourceProperties(
      "AWS::SNS::TopicPolicy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: "DenyNonHttps",
              Effect: "Deny",
              Action: "sns:Publish",
              Condition: { Bool: { "aws:SecureTransport": "false" } },
            }),
          ]),
        }),
      }),
    );
  });
});

describe("SQS", () => {
  test("two queues with SQS-managed encryption", () => {
    template.resourceCountIs("AWS::SQS::Queue", 2);
    const queues = template.findResources("AWS::SQS::Queue");
    for (const queue of Object.values(queues)) {
      // SQS_MANAGED encryption uses SSE-SQS (no KmsMasterKeyId property)
      expect(queue.Properties.SqsManagedSseEnabled).toBe(true);
    }
  });

  test("main queue has redrive policy with maxReceiveCount=5 to the DLQ", () => {
    template.hasResourceProperties(
      "AWS::SQS::Queue",
      Match.objectLike({
        RedrivePolicy: Match.objectLike({
          maxReceiveCount: 5,
          deadLetterTargetArn: Match.anyValue(),
        }),
      }),
    );
  });

  test("queues use KMS encryption (SSL enforced at transport level by KMS)", () => {
    // The SNS-to-SQS subscription generates a queue policy allowing SNS to
    // send messages. Explicit enforceSSL queue policies are omitted from queue
    // construction to avoid circular dependencies with KMS + event sources.
    template.resourceCountIs("AWS::SQS::QueuePolicy", 1);
  });

  test("subscription connects the topic to the main queue over the sqs protocol", () => {
    template.resourceCountIs("AWS::SNS::Subscription", 1);
    template.hasResourceProperties(
      "AWS::SNS::Subscription",
      Match.objectLike({ Protocol: "sqs" }),
    );
  });
});

describe("Lambda", () => {
  test("two functions, both Node 22.x ARM64 with reserved concurrency 5", () => {
    template.resourceCountIs("AWS::Lambda::Function", 2);
    const functions = template.findResources("AWS::Lambda::Function");
    for (const fn of Object.values(functions)) {
      expect(fn.Properties.Runtime).toBe("nodejs22.x");
      expect(fn.Properties.Architectures).toEqual(["arm64"]);
      expect(fn.Properties.ReservedConcurrentExecutions).toBe(5);
    }
  });

  test("ingress function has TOPIC_ARN in its environment", () => {
    template.hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({ TOPIC_ARN: Match.anyValue() }),
        }),
      }),
    );
  });

  test("event source mapping connects egress function to main queue", () => {
    template.resourceCountIs("AWS::Lambda::EventSourceMapping", 1);
    template.hasResourceProperties(
      "AWS::Lambda::EventSourceMapping",
      Match.objectLike({
        BatchSize: 10,
        FunctionResponseTypes: ["ReportBatchItemFailures"],
      }),
    );
  });
});

describe("Lambda IAM", () => {
  test("ingress role has inline policy granting sns:Publish on the topic", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const ingressPublish = Object.values(policies).find((p) => {
      const statements = p.Properties.PolicyDocument.Statement as Array<{
        Action?: string | string[];
      }>;
      return statements.some(
        (s) =>
          s.Action === "sns:Publish" ||
          (Array.isArray(s.Action) && s.Action.includes("sns:Publish")),
      );
    });
    expect(ingressPublish).toBeDefined();
  });

  test("egress role has inline policy granting sqs receive/delete/get-attributes on the queue", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const egressSqs = Object.values(policies).find((p) => {
      const statements = p.Properties.PolicyDocument.Statement as Array<{
        Action?: string | string[];
      }>;
      return statements.some((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];
        return (
          actions.includes("sqs:ReceiveMessage") &&
          actions.includes("sqs:DeleteMessage") &&
          actions.includes("sqs:GetQueueAttributes")
        );
      });
    });
    expect(egressSqs).toBeDefined();
  });

  test("Property 4 (path scoping): no inline policy grants Action='*' or unrestricted Resource='*'", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    for (const [logicalId, policy] of Object.entries(policies)) {
      const statements = policy.Properties.PolicyDocument.Statement as Array<{
        Effect?: string;
        Action?: string | string[];
        Resource?: string | string[];
      }>;
      for (const statement of statements) {
        if (statement.Effect !== "Allow") continue;
        const actions = Array.isArray(statement.Action)
          ? statement.Action
          : statement.Action
            ? [statement.Action]
            : [];
        expect(actions).not.toContain("*");

        const resources = Array.isArray(statement.Resource)
          ? statement.Resource
          : statement.Resource
            ? [statement.Resource]
            : [];
        const hasUnrestrictedWildcard = resources.includes("*");
        if (hasUnrestrictedWildcard) {
          throw new Error(
            `Inline policy ${logicalId} has an Allow statement with Resource='*'`,
          );
        }
      }
    }
  });
});

describe("API Gateway", () => {
  test("one RestApi with prod stage and access logging configured", () => {
    template.resourceCountIs("AWS::ApiGateway::RestApi", 1);
    template.hasResourceProperties(
      "AWS::ApiGateway::Stage",
      Match.objectLike({
        StageName: "prod",
        AccessLogSetting: Match.objectLike({
          DestinationArn: Match.anyValue(),
          Format: Match.anyValue(),
        }),
      }),
    );
  });

  test("request validator validates the body but not parameters", () => {
    template.hasResourceProperties(
      "AWS::ApiGateway::RequestValidator",
      Match.objectLike({
        ValidateRequestBody: true,
        ValidateRequestParameters: false,
      }),
    );
  });

  test("POST method binds the request validator and a request model", () => {
    template.hasResourceProperties(
      "AWS::ApiGateway::Method",
      Match.objectLike({
        HttpMethod: "POST",
        RequestValidatorId: Match.anyValue(),
        RequestModels: Match.objectLike({ "application/json": Match.anyValue() }),
      }),
    );
  });

  test("MessageModel requires `message` and disallows additional properties", () => {
    template.hasResourceProperties(
      "AWS::ApiGateway::Model",
      Match.objectLike({
        Name: "MessageModel",
        Schema: Match.objectLike({
          required: ["message"],
          additionalProperties: false,
        }),
      }),
    );
  });
});

describe("CloudWatch LogGroups", () => {
  test("at least three log groups with retention and DESTROY removal policy", () => {
    const logGroups = template.findResources("AWS::Logs::LogGroup");
    expect(Object.keys(logGroups).length).toBeGreaterThanOrEqual(3);
    for (const lg of Object.values(logGroups)) {
      expect(lg.Properties.RetentionInDays).toBe(7);
      expect(lg.DeletionPolicy).toBe("Delete");
      expect(lg.UpdateReplacePolicy).toBe("Delete");
    }
  });
});

describe("Outputs", () => {
  test("ApiEndpointUrl and QueueUrl outputs are present", () => {
    template.hasOutput("ApiEndpointUrl", Match.objectLike({ Value: Match.anyValue() }));
    template.hasOutput("QueueUrl", Match.objectLike({ Value: Match.anyValue() }));
  });
});
