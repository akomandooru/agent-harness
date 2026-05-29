# ADR-001: CodeBuild orchestrator over Lambda

**Status:** Accepted  
**Date:** 2026-05-27  
**Supersedes:** Lambda-based orchestrator (`app/orchestrator/index.ts`, `infrastructure/orchestrator-stack.ts`, `Dockerfile.orchestrator`)

## Context

The original orchestrator ran as a Docker-based Lambda (`DockerImageFunction`). This hit four hard constraints:

1. **15-minute timeout** — Multi-iteration loops with CDK deploy couldn't converge in time.
2. **Read-only filesystem** — The agent couldn't write to a real git working tree.
3. **Subprocess spawn restrictions** — Sensors (tsc, eslint, jest, cdk-nag) failed or required workarounds.
4. **No real git workflow** — PRs were synthesized from tool-use messages, not actual code diffs.

## Decision

Replace the Lambda orchestrator with AWS CodeBuild as the bounded loop runtime:

- A **thin webhook Lambda** (~50 lines) validates trigger payloads and calls `codebuild:StartBuild`.
- A **CodeBuild project** runs the full bounded loop with real subprocesses, real git, and a writable filesystem.
- The **dispatch workflow** POSTs to the webhook with an API key (no SigV4/OIDC role assumption).

## Consequences

### Removed

- `Dockerfile.orchestrator` — No container image build needed.
- `.dockerignore` — No Docker builds.
- `infrastructure/orchestrator-stack.ts` — Old Lambda + API Gateway stack.
- **GitHub Actions runner IAM role** — The workflow no longer assumes an AWS role. It sends a plain HTTPS POST with an API key. The OIDC federation, `awscurl`, and `execute-api:Invoke` permission are all gone.
- Docker/Podman as a prerequisite.

### Added

- `app/codebuild/` — CodeBuild orchestrator (main entry point, gates, tool catalogue).
- `app/webhook/` — Thin webhook Lambda.
- `infrastructure/` — CDK infrastructure (CodeBuild project).
- `buildspec.yml` — Buildspec with inline git clone (before `npm ci`).

### Key design choices to preserve

1. **No runner role / no SigV4.** The webhook is protected by an API Gateway API key. This is intentional — it eliminates the OIDC setup, the `awscurl` dependency, and the multi-step IAM scoping dance. Don't reintroduce SigV4 unless the threat model requires caller identity (it currently doesn't — there's one caller).

2. **`--github-repo` is optional.** The IAM stack only creates editor and reviewer roles. There is no GitHub-specific IAM resource. GitHub integration is purely at the workflow level (secrets + API key).

3. **CodeBuild source is `NO_SOURCE`.** The buildspec's install phase clones the repo inline using the installation token from the trigger payload. This avoids requiring a CodeStar Connection. For local-mode testing, operators use `--source-type-override` (S3 or GitHub).

4. **Editor tool catalogue is trimmed to 3 tools.** `module_readFile`, `module_writeFile`, `module_listFiles`. Sensors, deploy, review, and post-deploy are loop gates controlled by the orchestrator — not tools the agent calls. Don't add sensor/deploy tools back to the editor catalogue.

5. **The webhook endpoint is public but API-key-protected.** API key + HTTPS is sufficient for a single-purpose webhook with one known caller. Rate limiting (10 req/s, 1000/day) is configured via a usage plan.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| ECS / Fargate | More infrastructure, no buildspec-driven lifecycle, orchestration overhead |
| Step Functions | Adds state machine complexity; the loop logic is already in TypeScript |
| Keep Lambda + increase timeout | Lambda max is 15 min; not enough for multi-iteration loops with deploy |
| SigV4 on the new webhook | Adds OIDC setup + awscurl dependency for no security gain (API key is sufficient for one caller) |
| CodeStar Connection for source | Adds a manual console step; inline clone with installation token is self-contained |
