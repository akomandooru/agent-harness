---
inclusion: auto
---

# Architecture Decisions

Binding constraints for this project. Do not violate these without explicit user approval.

## Orchestrator is CodeBuild, not Lambda

The bounded loop runs in AWS CodeBuild. There is no orchestrator Lambda.
Do not introduce a Lambda-based orchestrator, `DockerImageFunction`, or `Dockerfile.orchestrator`.
See `docs/adr/001-codebuild-over-lambda.md` for full rationale.

## No SigV4 / No runner IAM role

The dispatch workflow authenticates to the webhook via an API Gateway API key (`x-api-key` header).
There is no OIDC federation, no `awscurl`, no `execute-api:Invoke` permission, and no `agent-harness-github-runner` role.
Do not reintroduce SigV4 signing or a GitHub Actions runner IAM role.

## Editor tool catalogue is exactly 3 tools

The editor agent has only: `module_readFile`, `module_writeFile`, `module_listFiles`.
Sensors, deploy, review, and post-deploy are loop gates controlled by the orchestrator — not tools the agent calls.
Do not add sensor, deploy, or PR tools to the editor's tool catalogue.

## CodeBuild source is NO_SOURCE

The CodeBuild project has no configured source. The buildspec clones the repo inline during the install phase using the installation token from the trigger payload. For local-mode testing, use `--source-type-override` (S3 or GitHub). Do not add a CodeStar Connection or permanent source configuration.

## `--github-repo` is not required for local testing

The IAM stack only creates editor and reviewer roles. There are no GitHub-specific IAM resources. GitHub integration lives entirely at the workflow level (secrets + API key). Steps 1–5b work with only an AWS account.
