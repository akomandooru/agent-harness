# AGENTS.md — fan-out reference module

This file is a steering file for the agent harness. The editor agent reads it
before planning any change to this module and the editor agent's system prompt
quotes from it directly. Keep rules short, imperative, and unambiguous. If a
rule cannot be obeyed, do not edit around it; surface the conflict in the PR
description and stop.

This module implements an event-processing fan-out:
`API Gateway → Lambda (ingress) → SNS → SQS → Lambda (egress)`. The constraints
below are what makes this module pass the engineering harness (cdk-nag
`AwsSolutions`, `tsc --noEmit`, `eslint`, the `aws-cdk-lib/assertions` unit
tests, the inferential reviewer, and the synthetic post-deploy harness). They
are not stylistic preferences; the sensors will fail any change that breaks
them.

## Scope of edits

- The agent SHALL only read and write files under `modules/fanout/`. Anything
  outside this path is out of scope and the wrapper layer will reject the
  attempt.
- The agent SHALL NOT modify `agent-harness.config.json`, `package.json` lock
  files, IAM policy stacks under `infrastructure/`, or any GitHub Actions
  workflow as part of a feature change to this module.
- The stack body SHALL stay under 500 lines of TypeScript, excluding
  generated and test files (Requirement 11.4).

## Naming conventions

- The CDK stack class is `FanoutStack` and lives at
  `lib/fanout-stack.ts`. The stack is instantiated by `bin/fanout.ts` using
  the `module.stackName` value from `agent-harness.config.json` (current
  default: `FanoutPreview`).
- Construct logical ids are PascalCase and singular (`Topic`, `Queue`,
  `DeadLetterQueue`, `IngressFn`, `EgressFn`, `EncryptionKey`, `RestApi`,
  `RequestValidator`, `MessageModel`). New constructs follow the same shape:
  noun, no abbreviations, no environment suffixes.
- Lambda IAM roles are named `<FunctionId>Role` (for example `IngressFnRole`,
  `EgressFnRole`). One role per function; do not share roles across
  functions.
- Log groups are named `<ConstructId>LogGroup` and are created explicitly so
  the stack controls retention and removal policy.
- `CfnOutput` ids are stable and human-readable (`ApiEndpointUrl`,
  `QueueUrl`). The post-deploy harness reads these by name; renaming an
  output is a contract change.

## Tag policy

- Every taggable resource SHALL carry the tags `agent-harness/session` and
  `agent-harness/env`. Tag values come from `FanoutStackProps.sessionTag` and
  `FanoutStackProps.envTag` and are applied at the stack level via
  `Tags.of(this).add(...)`. Do not add per-resource overrides for these two
  keys.
- The agent SHALL NOT hardcode tag values in the stack. The values must flow
  from `bin/fanout.ts`, which reads them from CDK context keys
  `agent-harness/session` and `agent-harness/env` (defaulting to `local` for
  developer-machine `cdk synth` runs).
- Additional team tags MAY be added at the stack level. They MUST NOT
  overwrite `agent-harness/session` or `agent-harness/env`.
- Preview-environment IAM is tag-scoped: the editor agent's role only grants
  access to resources tagged with the same `agent-harness/session` value and
  `agent-harness/env = preview`. Dropping or renaming these tags will
  silently lock the agent out of its own deployment.

## SNS: HTTPS-only

- Every SNS topic in this module SHALL deny `sns:Publish` over non-HTTPS
  transport via a topic resource policy.
- The deny statement SHALL use `Sid: "DenyNonHttps"`,
  `Effect: iam.Effect.DENY`, `principals: [new iam.AnyPrincipal()]`,
  `actions: ["sns:Publish"]`, `resources: [topic.topicArn]`, and the
  condition `{ Bool: { "aws:SecureTransport": "false" } }`. The unit-test
  sensor (`test/fanout-stack.test.ts`) asserts this exact shape; deviating
  from it will fail the test even if the resulting policy is semantically
  equivalent.
- Every SNS topic SHALL be encrypted at rest with the module's
  customer-managed KMS key (`masterKey: this.key`). Default-encryption with
  an AWS-managed key is not acceptable for this module.

## SQS: encryption at rest, HTTPS-only, DLQ-backed

- Every SQS queue (the main `Queue` and the `DeadLetterQueue`) SHALL set
  `encryption: sqs.QueueEncryption.KMS` and
  `encryptionMasterKey: this.key`. SSE-SQS and unencrypted queues are not
  acceptable.
- Every SQS queue SHALL set `enforceSSL: true`. CDK renders this as a queue
  resource policy denying non-HTTPS access; the unit-test sensor asserts that
  every queue has such a deny statement.
- The main `Queue` SHALL have a `deadLetterQueue` with the dedicated
  `DeadLetterQueue` and `maxReceiveCount: 5` (the constant
  `DLQ_MAX_RECEIVE_COUNT` in `lib/fanout-stack.ts`).
- The `DeadLetterQueue` SHALL retain messages for 14 days
  (`Duration.days(14)`); the main `Queue` retains for 4 days
  (`Duration.days(4)`). If you need to change either window, update the
  constant and the related test together.
- The main `Queue` SHALL NOT itself be a dead-letter target for another
  queue. The DLQ relationship in this module is one-way.

## IAM scoping

- Each Lambda has its own IAM role; roles are not shared.
- Each role SHALL attach the AWS-managed
  `service-role/AWSLambdaBasicExecutionRole` for CloudWatch Logs and add
  inline statements only for the specific resources the function reaches.
- The ingress function role inline statements grant ONLY:
  - `sns:Publish` on the module's topic ARN.
  - `kms:GenerateDataKey` and `kms:Decrypt` on the module's KMS key ARN.
- The egress function role inline statements grant ONLY:
  - `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` on
    the main queue ARN.
  - `kms:Decrypt` on the module's KMS key ARN.
- No `Allow` statement in this module SHALL use `Action: "*"` or
  `Resource: "*"`. The unit-test sensor enforces this and treats any
  occurrence as a stack-level failure (this is correctness Property 4).
- AWS-managed policy attachments are exempt from the wildcard rule because
  their content is not authored in this module; do not introduce new
  managed-policy attachments to widen the role's surface.

## API Gateway

- The `RestApi` SHALL have `cloudWatchRole: false`. Do not enable the
  account-level CloudWatch role from this stack.
- The `prod` stage SHALL configure access logging to a stack-owned log group
  using `apigateway.AccessLogFormat.jsonWithStandardFields` with `caller` and
  `user` set to `false`.
- The `POST /messages` method SHALL bind a `RequestValidator` with
  `validateRequestBody: true` and `validateRequestParameters: false`, and a
  `MessageModel` that requires `message` (a non-empty string), allows an
  optional `attributes` object, and sets `additionalProperties: false`.
- The endpoint surface for this module is `POST /messages`. Adding routes is
  a contract change and SHALL be reflected in the post-deploy harness in the
  same PR.

## Lambda runtime and limits

- Both functions SHALL use `lambda.Runtime.NODEJS_22_X` and
  `lambda.Architecture.ARM_64`. Pin both explicitly; do not rely on CDK
  defaults.
- Both functions SHALL set `reservedConcurrentExecutions:
  RESERVED_CONCURRENCY` (currently `5`). This caps blast radius in the
  preview environment.
- Both functions SHALL have an explicitly created `LogGroup` with retention
  `logs.RetentionDays.ONE_WEEK` and `removalPolicy: RemovalPolicy.DESTROY`.
- The egress function's queue binding SHALL use `SqsEventSource` with
  `batchSize: 10` and `reportBatchItemFailures: true`.

## KMS

- The module uses ONE customer-managed `kms.Key` (`EncryptionKey`) shared by
  the topic, both queues, and the Lambdas' encryption operations.
- The key SHALL set `enableKeyRotation: true` and
  `removalPolicy: RemovalPolicy.DESTROY` (the preview environment is
  ephemeral; the key is recreated on each deploy).
- Do not introduce additional KMS keys for new resources in this module
  unless a separate trust boundary is required and explained in the PR
  description.

## Lifecycle and removal policies

- Every resource the agent introduces SHALL set
  `removalPolicy: RemovalPolicy.DESTROY` where the construct supports it.
  The preview environment is torn down on PR close and by the scheduled
  sweep; resources that survive teardown leak cost.
- Stateful changes that would require data migration (renaming the queue,
  changing the KMS key) are not in scope for an `agent-task` change. Surface
  the conflict in the PR and stop.

## Outputs and the post-deploy contract

- The stack SHALL keep the `ApiEndpointUrl` and `QueueUrl` outputs. The
  post-deploy harness reads these by name; do not rename, remove, or stop
  exporting them.
- New outputs MAY be added. Do not remove existing outputs without a
  matching change to the post-deploy harness in the same PR.

## What the agent must do before editing

1. Read this file in full. Quote the rule that justifies any change you make
   in the PR body.
2. Read `lib/fanout-stack.ts` and `test/fanout-stack.test.ts`. The test file
   is the unit-test computational sensor and pins the exact shape of every
   rule above; if a rule and the test disagree, the test wins and the rule
   should be updated in a follow-up PR.
3. Run the computational sensors (`sensor.cdkNag`, `sensor.tsc`,
   `sensor.eslint`, `sensor.unitTests`) before requesting the inferential
   reviewer.
4. After a successful `cdk.deploy`, run `postDeploy.invoke`. Do not open the
   PR until post-deploy passes or a stop condition is reached.

## What the agent must not do

- Do not weaken any rule above to make a sensor pass. If a rule blocks a
  legitimate change, document the conflict in the PR body and let the human
  reviewer decide.
- Do not introduce a new tool, agent, or subprocess. The tool catalogue is
  declared statically in `agents/editor/tools.ts`; the wrapper layer rejects
  anything outside it.
- Do not add suppressions to cdk-nag findings without a one-line rationale
  in the PR body and an entry in the suppression list referenced by
  `agent-harness.config.json`.
- Do not fan out beyond the resources listed above (extra queues, extra
  topics, extra Lambdas). The reference module is intentionally small;
  growth comes from a separate spec.
