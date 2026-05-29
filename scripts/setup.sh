#!/usr/bin/env bash
# setup.sh — Automated setup for the agent-harness template (Mac/Linux)
#
# Covers quickstart Steps 3-6 with idempotency checks so it is safe to
# re-run or resume from a specific step.
#
# Steps 1 (fork/clone), 2 (config edits), 7-9 (issue/PR/review) are
# intentionally manual and not covered here.
#
# Usage:
#   ./scripts/setup.sh --account-id 123456789012 --github-repo my-org/agent-harness
#   ./scripts/setup.sh --account-id 123456789012 --github-repo my-org/agent-harness --from-step 4b
#
# Prerequisites:
#   - AWS CLI configured with credentials for your account
#   - AWS CDK v2 installed: npm install -g aws-cdk@2.1124.1
#   - GitHub CLI installed and authenticated: gh auth login
#   - Node.js 22.x active: nvm use 22
#   - Run from the repo root

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

ACCOUNT_ID=""
REGION="us-east-1"
GITHUB_REPO=""
CHECKLIST_BUCKET=""
FROM_STEP="3"
TASK_TYPE="feature"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --account-id)   ACCOUNT_ID="$2";    shift 2 ;;
    --region)       REGION="$2";        shift 2 ;;
    --github-repo)  GITHUB_REPO="$2";   shift 2 ;;
    --checklist-bucket) CHECKLIST_BUCKET="$2"; shift 2 ;;
    --from-step)    FROM_STEP="$2";     shift 2 ;;
    --task-type)    TASK_TYPE="$2";     shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [[ -z "$ACCOUNT_ID" ]]; then
  echo "Error: --account-id is required."
  echo "Usage: ./scripts/setup.sh --account-id 123456789012"
  exit 1
fi

if [[ -z "$CHECKLIST_BUCKET" ]]; then
  CHECKLIST_BUCKET="agent-harness-checklists-${ACCOUNT_ID}"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_PATH="${REPO_ROOT}/agent-harness.config.json"
INFRA_DIR="${REPO_ROOT}/infrastructure"
ARNS_FILE="${REPO_ROOT}/.setup-harness-arns.json"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

step_order=("3" "4" "4b" "4c" "5" "5b")

should_run_step() {
  local step="$1"
  local from_idx=-1
  local this_idx=-1
  local i=0
  for s in "${step_order[@]}"; do
    if [[ "$s" == "$FROM_STEP" ]]; then from_idx=$i; fi
    if [[ "$s" == "$step" ]];     then this_idx=$i; fi
    ((i++))
  done
  [[ $this_idx -ge $from_idx ]]
}

log_step()    { echo ""; echo "=== Step $1 : $2 ==="; }
log_ok()      { echo "  OK  $1"; }
log_skip()    { echo "  --  $1 (already done, skipping)"; }
log_info()    { echo "      $1"; }

cfn_output() {
  local stack="$1"
  local key="$2"
  aws cloudformation describe-stacks \
    --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" \
    --output text 2>/dev/null | tr -d '[:space:]'
}

stack_exists() {
  local stack="$1"
  local status
  status=$(aws cloudformation describe-stacks \
    --stack-name "$stack" \
    --query "Stacks[0].StackStatus" \
    --output text 2>/dev/null || true)
  [[ -n "$status" && "$status" != "DELETE_COMPLETE" ]]
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------

echo ""
echo "agent-harness setup"
echo "  Account:          $ACCOUNT_ID"
echo "  Region:           $REGION"
echo "  GitHub repo:      $GITHUB_REPO"
echo "  Checklist bucket: $CHECKLIST_BUCKET"
echo "  Starting from:    Step $FROM_STEP"

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

echo ""
echo "--- Pre-flight checks ---"

# AWS CLI
actual_account=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)
if [[ "$actual_account" != "$ACCOUNT_ID" ]]; then
  echo "Error: AWS CLI is not configured for account $ACCOUNT_ID (got: $actual_account)."
  echo "Run 'aws configure' or set credentials, then retry."
  exit 1
fi
log_ok "AWS CLI authenticated for account $ACCOUNT_ID"

# CDK
if ! cdk_ver=$(cdk --version 2>/dev/null); then
  echo "Error: AWS CDK is not installed. Run: npm install -g aws-cdk@2.1124.1"
  exit 1
fi
log_ok "CDK available: $cdk_ver"

# ---------------------------------------------------------------------------
# Step 3 — CDK bootstrap
# ---------------------------------------------------------------------------

if should_run_step "3"; then
  log_step "3" "Bootstrap CDK"

  if stack_exists "CDKToolkit"; then
    log_skip "CDK bootstrap stack already exists"
  else
    log_info "Running cdk bootstrap aws://${ACCOUNT_ID}/${REGION} ..."
    cdk bootstrap "aws://${ACCOUNT_ID}/${REGION}"
    log_ok "CDK bootstrapped"
  fi
fi

# ---------------------------------------------------------------------------
# Step 4 — Deploy IAM stack
# ---------------------------------------------------------------------------

if should_run_step "4"; then
  log_step "4" "Deploy IAM stack"

  pushd "$INFRA_DIR" > /dev/null
  npm ci --silent
  log_info "Deploying IAM stack..."
  cdk deploy \
    --app "npx ts-node iam-stack.ts" \
    --require-approval never \
    --context "previewAccountId=${ACCOUNT_ID}" \
    --context "previewRegion=${REGION}" \
    --context "checklistBucketName=${CHECKLIST_BUCKET}"
  popd > /dev/null
  log_ok "IAM stack deployed"
fi

# ---------------------------------------------------------------------------
# Step 4b — Deploy AgentCore Managed Harnesses + orchestrator CDK stack
# ---------------------------------------------------------------------------

if should_run_step "4b"; then
  log_step "4b" "Deploy AgentCore Managed Harnesses and orchestrator stack"

  # Read the editor execution role ARN from the IAM stack output
  EDITOR_EXECUTION_ROLE_ARN=$(cfn_output "AgentHarnessIam" "EditorAgentRoleArn")
  if [[ -z "$EDITOR_EXECUTION_ROLE_ARN" || "$EDITOR_EXECUTION_ROLE_ARN" == "None" ]]; then
    echo "Error: Could not read EditorAgentRoleArn from AgentHarnessIam stack. Ensure Step 4 completed successfully."
    exit 1
  fi
  log_info "Editor execution role: $EDITOR_EXECUTION_ROLE_ARN"

  # Deploy harnesses via direct SDK script (replaces agentcore CLI)
  log_info "Running deploy-harnesses.ts..."
  npx ts-node scripts/deploy-harnesses.ts \
    --account-id "$ACCOUNT_ID" \
    --region "$REGION" \
    --execution-role "$EDITOR_EXECUTION_ROLE_ARN"
  log_ok "AgentCore Managed Harnesses deployed"

  # Read harness ARNs from the output artifact written by deploy-harnesses.ts
  EDITOR_HARNESS_ARN=$(jq -r '.editor.arn'   "$REPO_ROOT/.deployed-harnesses.json")
  REVIEWER_HARNESS_ARN=$(jq -r '.reviewer.arn' "$REPO_ROOT/.deployed-harnesses.json")

  if [[ -z "$EDITOR_HARNESS_ARN" || "$EDITOR_HARNESS_ARN" == "null" ]]; then
    echo "Error: Editor harness ARN is missing from .deployed-harnesses.json. Re-run with --from-step 4b."
    exit 1
  fi
  if [[ -z "$REVIEWER_HARNESS_ARN" || "$REVIEWER_HARNESS_ARN" == "null" ]]; then
    echo "Error: Reviewer harness ARN is missing from .deployed-harnesses.json. Re-run with --from-step 4b."
    exit 1
  fi

  # Save ARNs for later steps
  printf '{"editorHarnessArn":"%s","reviewerHarnessArn":"%s"}\n' \
    "$EDITOR_HARNESS_ARN" "$REVIEWER_HARNESS_ARN" > "$ARNS_FILE"
  log_info "Harness ARNs saved to .setup-harness-arns.json (gitignored)"

  # Deploy orchestrator CDK stack (webhook Lambda + CodeBuild project)
  log_info "Deploying orchestrator stack..."
  cd infra
  npm ci --silent
  cdk deploy --all --require-approval never \
    --context "editorHarnessArn=${EDITOR_HARNESS_ARN}" \
    --context "reviewerHarnessArn=${REVIEWER_HARNESS_ARN}"
  cd ..
  log_ok "Orchestrator stack deployed"
fi

# ---------------------------------------------------------------------------
# Step 4c — Update config with real API Gateway endpoint
# ---------------------------------------------------------------------------

if should_run_step "4c"; then
  log_step "4c" "Update config with API Gateway endpoint"

  WEBHOOK_ENDPOINT=$(cfn_output "AgentHarnessWebhookStack" "WebhookApiEndpoint")
  if [[ -z "$WEBHOOK_ENDPOINT" || "$WEBHOOK_ENDPOINT" == "None" ]]; then
    echo "Error: Could not read WebhookApiEndpoint from AgentHarnessWebhookStack."
    exit 1
  fi

  log_info "Endpoint: $WEBHOOK_ENDPOINT"

  # Update agent-harness.config.json using node (avoids jq dependency)
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('${CONFIG_PATH}', 'utf8'));
    cfg.orchestrator.apiGatewayEndpoint = '${WEBHOOK_ENDPOINT}';
    fs.writeFileSync('${CONFIG_PATH}', JSON.stringify(cfg, null, 2));
  "
  log_ok "agent-harness.config.json updated with real endpoint"
fi

# ---------------------------------------------------------------------------
# Step 5 — Validate config and check version drift
# ---------------------------------------------------------------------------

if should_run_step "5"; then
  log_step "5" "Validate config and check version drift"

  pushd "$REPO_ROOT" > /dev/null

  log_info "Running validate-config.ts..."
  npx ts-node scripts/validate-config.ts
  log_ok "Config valid"

  log_info "Running check-version-drift.ts..."
  npx ts-node scripts/check-version-drift.ts
  log_ok "No version drift"

  log_info "Running check-terminology.ts..."
  npx ts-node scripts/check-terminology.ts
  log_ok "Terminology OK"

  popd > /dev/null
fi

# ---------------------------------------------------------------------------
# Step 5b — Verify webhook deployment
# ---------------------------------------------------------------------------

if should_run_step "5b"; then
  log_step "5b" "Verify orchestrator deployment (local-mode build)"

  # Retrieve the API key value
  API_KEY_ID=$(cfn_output "AgentHarnessWebhookStack" "WebhookApiKeyId")
  WEBHOOK_API_KEY=$(aws apigateway get-api-key --api-key "$API_KEY_ID" --include-value --query value --output text)

  # Build a concrete trigger payload so the loop has a real task to converge on
  SESSION_ID="setup-verify-$(date +%s)-$(head -c 6 /dev/urandom | xxd -p)"
  COMMIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "0000000000000000000000000000000000000000")

  # Select task payload based on --task-type
  if [[ "$TASK_TYPE" == "fitness-gap" ]]; then
    log_info "Task type: fitness-gap (simulating scheduled reviewer finding)"
    ISSUE_TITLE="[Fitness gap] SQS queue missing server-side encryption"
    ISSUE_BODY="## Finding\n\nAwsSolutions-SQS2: The main SQS queue uses SQS-managed encryption (SSE-SQS) rather than a customer-managed KMS key. The module standard documented in AGENTS.md requires customer-managed KMS for all data-at-rest encryption.\n\n## Source\n\nScheduled architecture review (cdk-nag AwsSolutions rule pack + Well-Architected Security checklist WA-SEC-03).\n\n## Suggested remediation\n\nChange the queue encryption from SQS_MANAGED back to KMS using the existing EncryptionKey construct. Ensure the Lambda execution roles have kms:Decrypt permission on the key."
  elif [[ "$TASK_TYPE" == "discover" ]]; then
    log_info "Task type: discover (running reviewer to find gaps...)"
    DISCOVER_OUTPUT=$(node "${REPO_ROOT}/scripts/discover-gaps.js" --module-root "modules/fanout" 2>/dev/null)
    if [[ -z "$DISCOVER_OUTPUT" ]]; then
      log_ok "No findings discovered — module passes review. Nothing to remediate."
      exit 0
    fi
    ISSUE_TITLE=$(echo "$DISCOVER_OUTPUT" | jq -r '.title')
    ISSUE_BODY=$(echo "$DISCOVER_OUTPUT" | jq -r '.body')
    SEVERITY=$(echo "$DISCOVER_OUTPUT" | jq -r '.severity')
    FINDING_COUNT=$(echo "$DISCOVER_OUTPUT" | jq -r '.findingCount')
    log_info "Discovered: [${SEVERITY}] ${ISSUE_TITLE}"
    log_info "Total findings: ${FINDING_COUNT}"
  else
    log_info "Task type: feature (human-initiated change)"
    ISSUE_TITLE="Increase DLQ retention to 30 days and reduce maxReceiveCount to 3"
    ISSUE_BODY="Update the dead-letter queue configuration: change retentionPeriod from 14 days to 30 days and change maxReceiveCount from 5 to 3. Update the corresponding unit test assertions to match."
  fi

  TRIGGER_PAYLOAD=$(cat <<PAYLOAD
{"issue":{"number":0,"title":"${ISSUE_TITLE}","body":"${ISSUE_BODY}"},"module":{"repository":"${GITHUB_REPO}","path":"modules/fanout","ref":"main","commitSha":"${COMMIT_SHA}"},"auth":{"githubInstallationToken":""},"session":"${SESSION_ID}"}
PAYLOAD
  )

  # Use JSON syntax for --environment-variables-override to avoid comma
  # collisions between the shorthand delimiter and JSON in the payload value.
  ENV_OVERRIDES_JSON=$(cat <<EOF
[{"name":"LOCAL_MODE","value":"true","type":"PLAINTEXT"},{"name":"TRIGGER_PAYLOAD","value":$(printf '%s' "$TRIGGER_PAYLOAD" | jq -Rs .),"type":"PLAINTEXT"},{"name":"SESSION_ID","value":"${SESSION_ID}","type":"PLAINTEXT"}]
EOF
  )

  # Determine source: try GitHub first, fall back to S3
  GITHUB_URL="https://github.com/${GITHUB_REPO}.git"

  if curl -s -o /dev/null -w "%{http_code}" "$GITHUB_URL" | grep -q "200\|301"; then
    log_info "Repo is accessible on GitHub. Using GitHub source override."
    BUILD_ID=$(aws codebuild start-build \
      --project-name agent-harness-orchestrator \
      --source-type-override GITHUB \
      --source-location-override "$GITHUB_URL" \
      --buildspec-override buildspec.yml \
      --environment-variables-override "$ENV_OVERRIDES_JSON" \
      --query 'build.id' --output text)
  else
    log_info "Repo not accessible on GitHub. Uploading to S3 and using S3 source override."
    # Use the CDK bootstrap assets bucket (always exists after step 3)
    ASSETS_BUCKET="cdk-hnb659fds-assets-${ACCOUNT_ID}-${REGION}"
    zip -r /tmp/agent-harness-source.zip . \
      -x "node_modules/*" "*/node_modules/*" "coverage/*" "cdk.out/*" > /dev/null
    aws s3 cp /tmp/agent-harness-source.zip "s3://${ASSETS_BUCKET}/agent-harness-source.zip" --quiet
    BUILD_ID=$(aws codebuild start-build \
      --project-name agent-harness-orchestrator \
      --source-type-override S3 \
      --source-location-override "${ASSETS_BUCKET}/agent-harness-source.zip" \
      --buildspec-override buildspec.yml \
      --environment-variables-override "$ENV_OVERRIDES_JSON" \
      --query 'build.id' --output text)
  fi

  log_info "Build started: $BUILD_ID"
  log_info "Waiting for build to complete (this runs the full bounded loop)..."

  # Poll build status
  while true; do
    STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" --query 'builds[0].buildStatus' --output text)
    if [[ "$STATUS" == "SUCCEEDED" ]]; then
      log_ok "Build succeeded. Orchestrator is working."
      break
    elif [[ "$STATUS" == "IN_PROGRESS" ]]; then
      sleep 15
    else
      echo "  WARN  Build finished with status: $STATUS"
      echo "        Check logs: aws logs tail /aws/codebuild/agent-harness-orchestrator --since 30m"
      break
    fi
  done

  log_info "To see full execution details:"
  log_info "  aws logs tail /aws/codebuild/agent-harness-orchestrator --since 30m"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next: set GitHub secrets (Step 6) via the GitHub UI or CLI — see docs/quickstart.md Step 6."
echo ""
echo "Then create a test issue to trigger the loop (Step 7):"
echo "  gh issue create --repo ${GITHUB_REPO} \\"
echo "    --title '[Agent task] Add a dead-letter queue' \\"
echo "    --label agent-task \\"
echo "    --body '...'"
echo ""
echo "  See docs/quickstart.md Steps 5-9 for details."
echo ""
