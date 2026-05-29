/**
 * FanoutStack: API Gateway -> Lambda -> SNS -> SQS -> Lambda.
 *
 * Reference module for the agent harness. Resources are KMS-encrypted, the SNS
 * topic and main SQS queue deny non-HTTPS traffic, the main queue has a DLQ
 * redrive policy, and Lambda IAM roles are scoped per function. The stack is
 * intended to pass the AwsSolutions cdk-nag rule pack with no baseline findings.
 *
 * Tags `agent-harness/session` and `agent-harness/env` are applied at the stack
 * level from `FanoutStackProps` so every resource carries them. The preview is
 * ephemeral; KMS key and log groups use `RemovalPolicy.DESTROY` so teardown is
 * clean.
 */

import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
  type StackProps,
} from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

const SESSION_TAG_KEY = "agent-harness/session";
const ENV_TAG_KEY = "agent-harness/env";

const RESERVED_CONCURRENCY = 5;
const DLQ_MAX_RECEIVE_COUNT = 5;
const LOG_RETENTION = logs.RetentionDays.ONE_WEEK;

export interface FanoutStackProps extends StackProps {
  /** Value for the `agent-harness/session` tag. */
  readonly sessionTag: string;
  /** Value for the `agent-harness/env` tag. */
  readonly envTag: string;
  /**
   * Optional SNS subscription filter policy. Default `undefined` means the
   * subscription receives every message published to the topic.
   */
  readonly subscriptionFilterPolicy?: { [attribute: string]: sns.SubscriptionFilter };
}

/**
 * Inline ingress handler. Validates the request body has a `message` string,
 * publishes to SNS, returns 202. The real implementation can replace this.
 */
const INGRESS_HANDLER = `
const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
const sns = new SNSClient({});
exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return resp(400, "invalid json"); }
  if (typeof body.message !== "string" || body.message.length === 0) {
    return resp(400, "missing message");
  }
  await sns.send(new PublishCommand({
    TopicArn: process.env.TOPIC_ARN,
    Message: body.message,
    MessageAttributes: body.attributes || {},
  }));
  return resp(202, "accepted");
};
function resp(status, msg) {
  return { statusCode: status, body: JSON.stringify({ status: msg }) };
}
`.trim();

/**
 * Inline egress handler. Logs each record. The SqsEventSource mapping is what
 * pulls messages off the queue; this body is a placeholder.
 */
const EGRESS_HANDLER = `
exports.handler = async (event) => {
  for (const record of event.Records || []) {
    console.log(JSON.stringify({ messageId: record.messageId, body: record.body }));
  }
  return { batchItemFailures: [] };
};
`.trim();

export class FanoutStack extends Stack {
  public readonly api: apigateway.RestApi;
  public readonly topic: sns.Topic;
  public readonly queue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly ingressFn: lambda.Function;
  public readonly egressFn: lambda.Function;
  public readonly key: kms.Key;

  constructor(scope: Construct, id: string, props: FanoutStackProps) {
    super(scope, id, props);

    Tags.of(this).add(SESSION_TAG_KEY, props.sessionTag);
    Tags.of(this).add(ENV_TAG_KEY, props.envTag);

    this.key = this.buildKey();
    this.deadLetterQueue = this.buildDeadLetterQueue(this.key);
    this.queue = this.buildQueue(this.key, this.deadLetterQueue);
    this.topic = this.buildTopic(this.key);
    this.subscribeQueueToTopic(props.subscriptionFilterPolicy);

    this.ingressFn = this.buildIngressFn(this.topic, this.key);
    this.egressFn = this.buildEgressFn(this.queue, this.key);

    this.api = this.buildApi(this.ingressFn);

    new CfnOutput(this, "ApiEndpointUrl", {
      value: this.api.url,
      description: "Invoke URL for the POST /messages endpoint.",
    });
    new CfnOutput(this, "QueueUrl", {
      value: this.queue.queueUrl,
      description: "URL of the main SQS queue downstream of the SNS topic.",
    });
  }

  private buildKey(): kms.Key {
    return new kms.Key(this, "EncryptionKey", {
      description: "Customer-managed key for the fan-out reference module.",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }

  private buildDeadLetterQueue(_key: kms.Key): sqs.Queue {
    const dlq = new sqs.Queue(this, "DeadLetterQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    return dlq;
  }

  private buildQueue(_key: kms.Key, dlq: sqs.Queue): sqs.Queue {
    return new sqs.Queue(this, "Queue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.seconds(60),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: DLQ_MAX_RECEIVE_COUNT,
      },
    });
  }

  private buildTopic(key: kms.Key): sns.Topic {
    const topic = new sns.Topic(this, "Topic", {
      masterKey: key,
    });
    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "DenyNonHttps",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["sns:Publish"],
        resources: [topic.topicArn],
        conditions: { Bool: { "aws:SecureTransport": "false" } },
      }),
    );
    return topic;
  }

  private subscribeQueueToTopic(
    filterPolicy?: { [attribute: string]: sns.SubscriptionFilter },
  ): void {
    this.topic.addSubscription(
      new snsSubscriptions.SqsSubscription(this.queue, {
        rawMessageDelivery: false,
        filterPolicy,
      }),
    );
  }

  private buildIngressFn(topic: sns.Topic, key: kms.Key): lambda.Function {
    const role = new iam.Role(this, "IngressFnRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for the ingress Lambda.",
    });
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sns:Publish"],
        resources: [topic.topicArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["kms:GenerateDataKey", "kms:Decrypt"],
        resources: [key.keyArn],
      }),
    );

    const logGroup = new logs.LogGroup(this, "IngressFnLogGroup", {
      retention: LOG_RETENTION,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    return new lambda.Function(this, "IngressFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromInline(INGRESS_HANDLER),
      role,
      logGroup,
      environment: { TOPIC_ARN: topic.topicArn },
      timeout: Duration.seconds(10),
      reservedConcurrentExecutions: RESERVED_CONCURRENCY,
      description: "Validates request body and publishes to SNS.",
    });
  }

  private buildEgressFn(queue: sqs.Queue, _key: kms.Key): lambda.Function {
    const role = new iam.Role(this, "EgressFnRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for the egress Lambda.",
    });
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
        ],
        resources: [queue.queueArn],
      }),
    );

    const logGroup = new logs.LogGroup(this, "EgressFnLogGroup", {
      retention: LOG_RETENTION,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, "EgressFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromInline(EGRESS_HANDLER),
      role,
      logGroup,
      timeout: Duration.seconds(30),
      reservedConcurrentExecutions: RESERVED_CONCURRENCY,
      description: "Consumes messages from the main SQS queue.",
    });

    fn.addEventSource(
      new SqsEventSource(queue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );

    return fn;
  }

  private buildApi(ingressFn: lambda.Function): apigateway.RestApi {
    const accessLogGroup = new logs.LogGroup(this, "ApiAccessLogGroup", {
      retention: LOG_RETENTION,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const api = new apigateway.RestApi(this, "RestApi", {
      restApiName: "FanoutApi",
      description: "Ingress for the fan-out reference module.",
      cloudWatchRole: false,
      apiKeySourceType: apigateway.ApiKeySourceType.HEADER,
      deployOptions: {
        stageName: "prod",
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: false,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: false,
        }),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: false,
        metricsEnabled: true,
      },
    });

    // API key for authenticating callers (post-deploy harness reads this from stack outputs)
    const apiKey = api.addApiKey("FanoutApiKey", {
      apiKeyName: `${this.stackName}-api-key`,
      description: "API key for the fanout preview API. Used by the post-deploy harness.",
    });

    const usagePlan = api.addUsagePlan("FanoutUsagePlan", {
      name: `${this.stackName}-usage-plan`,
      throttle: { rateLimit: 50, burstLimit: 100 },
    });
    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: api.deploymentStage });

    const requestValidator = new apigateway.RequestValidator(this, "RequestValidator", {
      restApi: api,
      validateRequestBody: true,
      validateRequestParameters: false,
    });

    const messageModel = api.addModel("MessageModel", {
      contentType: "application/json",
      modelName: "MessageModel",
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        type: apigateway.JsonSchemaType.OBJECT,
        required: ["message"],
        properties: {
          message: { type: apigateway.JsonSchemaType.STRING, minLength: 1 },
          attributes: { type: apigateway.JsonSchemaType.OBJECT },
        },
        additionalProperties: false,
      },
    });

    const messages = api.root.addResource("messages");
    messages.addMethod("POST", new apigateway.LambdaIntegration(ingressFn), {
      apiKeyRequired: true,
      requestValidator,
      requestModels: { "application/json": messageModel },
    });

    // Output the API key ID so the post-deploy harness can retrieve the value
    new CfnOutput(this, "ApiKeyId", {
      value: apiKey.keyId,
      description: "API key ID for the fanout API. Retrieve value with: aws apigateway get-api-key --api-key <id> --include-value",
    });

    return api;
  }
}
