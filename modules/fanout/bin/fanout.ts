#!/usr/bin/env node
/**
 * CDK app entry point for the fan-out reference module.
 *
 * Reads stack name from `agent-harness.config.json` at the repo root, applies
 * `agent-harness/session` and `agent-harness/env` from CDK context (the Action
 * sets these per-trigger; defaults to `local` for `cdk synth` runs from a
 * developer machine), and synthesises `FanoutStack`.
 */

import * as path from "path";
import { App } from "aws-cdk-lib";
import { FanoutStack } from "../lib/fanout-stack";

const SESSION_TAG_KEY = "agent-harness/session";
const ENV_TAG_KEY = "agent-harness/env";

interface RepoConfig {
  module: { stackName: string };
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require(path.resolve(__dirname, "../../../agent-harness.config.json")) as RepoConfig;

const app = new App();

const sessionTag = (app.node.tryGetContext(SESSION_TAG_KEY) as string | undefined) ?? "local";
const envTag = (app.node.tryGetContext(ENV_TAG_KEY) as string | undefined) ?? "local";

new FanoutStack(app, config.module.stackName, {
  sessionTag,
  envTag,
  description:
    "Fan-out reference module: API Gateway -> Lambda -> SNS -> SQS -> Lambda. KMS-encrypted, HTTPS-only, DLQ-backed.",
});

app.synth();
