<#
.SYNOPSIS
    Automated setup script for the agent-harness template.
    Runs through quickstart Steps 3-6, with idempotency checks so it is
    safe to re-run or resume from a specific step.

.DESCRIPTION
    Covers:
      Step 3  - CDK bootstrap
      Step 4  - Deploy IAM stack
      Step 4b - Deploy AgentCore Managed Harnesses + orchestrator CDK stack
      Step 4c - Update agent-harness.config.json with real API Gateway endpoint
      Step 5  - Validate config and check version drift
      Step 5b - Verify orchestrator deployment (bounded loop test)

    Steps 1 (clone) and 2 (config edits) are intentionally manual.

.PARAMETER AccountId
    Your AWS account ID (12-digit number).

.PARAMETER Region
    AWS region to deploy into. Default: us-east-1

.PARAMETER GithubRepo
    GitHub repository slug in org/repo format, e.g. "my-org/agent-harness".
    Used to scope the OIDC trust policy on the runner role.

.PARAMETER ChecklistBucket
    S3 bucket name for the reviewer's Well-Architected checklists.
    Default: agent-harness-checklists-<AccountId>

.PARAMETER FromStep
    Resume from this step number. Valid values: 3, 4, 4b, 4c, 5, 5b
    Default: 3 (run all steps)

.EXAMPLE
    # Run all steps
    .\scripts\setup.ps1 -AccountId "123456789012" -GithubRepo "my-org/agent-harness"

.EXAMPLE
    # Resume from step 4b (e.g. after agentcore deploy ran manually)
    .\scripts\setup.ps1 -AccountId "123456789012" -GithubRepo "my-org/agent-harness" -FromStep 4b

.NOTES
    Prerequisites (must be done before running this script):
      - AWS CLI configured with credentials for your account
      - AWS CDK v2 installed: npm install -g aws-cdk@2.1124.1
      - GitHub CLI installed and authenticated: gh auth login
      - Node.js 22.x active: nvm use 22
      - You have forked and cloned the repo and are running from the repo root
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$AccountId,

    [Parameter(Mandatory = $false)]
    [string]$Region = "us-east-1",

    [Parameter(Mandatory = $false)]
    [string]$GithubRepo = "",

    [Parameter(Mandatory = $false)]
    [string]$ChecklistBucket = "",

    [Parameter(Mandatory = $false)]
    [ValidateSet("3", "4", "4b", "5", "5b")]
    [string]$FromStep = "3",

    [Parameter(Mandatory = $false)]
    [ValidateSet("feature", "fitness-gap", "discover")]
    [string]$TaskType = "feature"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-Step {
    param([string]$Step, [string]$Message)
    Write-Host ""
    Write-Host "=== Step $Step : $Message ===" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host "  OK  $Message" -ForegroundColor Green
}

function Write-Skip {
    param([string]$Message)
    Write-Host "  --  $Message (already done, skipping)" -ForegroundColor DarkGray
}

function Write-Info {
    param([string]$Message)
    Write-Host "      $Message" -ForegroundColor Gray
}

function Invoke-Step {
    param([string]$StepId)
    # Returns true if this step should run based on FromStep ordering
    $order = @("3", "4", "4b", "4c", "5", "5b")
    $fromIdx = [Array]::IndexOf($order, $FromStep)
    $thisIdx = [Array]::IndexOf($order, $StepId)
    return $thisIdx -ge $fromIdx
}

function Get-CfnOutput {
    param([string]$StackName, [string]$OutputKey)
    $result = aws cloudformation describe-stacks `
        --stack-name $StackName `
        --query "Stacks[0].Outputs[?OutputKey=='$OutputKey'].OutputValue" `
        --output text 2>$null
    return $result.Trim()
}

function Test-CfnStackExists {
    param([string]$StackName)
    $status = aws cloudformation describe-stacks `
        --stack-name $StackName `
        --query "Stacks[0].StackStatus" `
        --output text 2>$null
    return ($LASTEXITCODE -eq 0 -and $status -ne "" -and $status -ne "DELETE_COMPLETE")
}

# ---------------------------------------------------------------------------
# Resolve defaults
# ---------------------------------------------------------------------------

if ($ChecklistBucket -eq "") {
    $ChecklistBucket = "agent-harness-checklists-$AccountId"
}

$RepoRoot = $PSScriptRoot | Split-Path -Parent
$ConfigPath = Join-Path $RepoRoot "agent-harness.config.json"
$InfraDir = Join-Path $RepoRoot "infrastructure"

Write-Host ""
Write-Host "agent-harness setup" -ForegroundColor White
Write-Host "  Account:         $AccountId"
Write-Host "  Region:          $Region"
Write-Host "  GitHub repo:     $GithubRepo"
Write-Host "  Checklist bucket: $ChecklistBucket"
Write-Host "  Starting from:   Step $FromStep"

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "--- Pre-flight checks ---" -ForegroundColor Yellow

# Check AWS CLI
$awsId = aws sts get-caller-identity --query Account --output text 2>$null
if ($LASTEXITCODE -ne 0 -or $awsId.Trim() -ne $AccountId) {
    throw "AWS CLI is not configured for account $AccountId. Run 'aws configure' or set credentials, then retry."
}
Write-Success "AWS CLI authenticated for account $AccountId"

# Check CDK
$cdkVersion = cdk --version 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "AWS CDK is not installed. Run: npm install -g aws-cdk@2.1124.1"
}
Write-Success "CDK available: $cdkVersion"

# ---------------------------------------------------------------------------
# Step 3 - CDK bootstrap
# ---------------------------------------------------------------------------

if (Invoke-Step "3") {
    Write-Step "3" "Bootstrap CDK"

    $bootstrapStack = "CDKToolkit"
    if (Test-CfnStackExists $bootstrapStack) {
        Write-Skip "CDK bootstrap stack already exists"
    } else {
        Write-Info "Running cdk bootstrap aws://$AccountId/$Region ..."
        cdk bootstrap "aws://$AccountId/$Region"
        if ($LASTEXITCODE -ne 0) { throw "CDK bootstrap failed." }
        Write-Success "CDK bootstrapped"
    }
}

# ---------------------------------------------------------------------------
# Step 4 - Deploy IAM stack
# ---------------------------------------------------------------------------

if (Invoke-Step "4") {
    Write-Step "4" "Deploy IAM stack"

    $iamStackName = "AgentHarnessIam"

    Push-Location $InfraDir
    try {
        npm ci --silent
        Write-Info "Deploying IAM stack..."
        cdk deploy `
            --app "npx ts-node iam-stack.ts" `
            --require-approval never `
            --context "previewAccountId=$AccountId" `
            --context "previewRegion=$Region" `
            --context "checklistBucketName=$ChecklistBucket"
        if ($LASTEXITCODE -ne 0) { throw "IAM stack deploy failed." }
        Write-Success "IAM stack deployed"
    } finally {
        Pop-Location
    }
}

# ---------------------------------------------------------------------------
# Step 4b - Deploy AgentCore Managed Harnesses + orchestrator CDK stack
# ---------------------------------------------------------------------------

if (Invoke-Step "4b") {
    Write-Step "4b" "Deploy AgentCore Managed Harnesses and orchestrator stack"

    # Read the editor execution role ARN from the IAM stack output
    $EditorExecutionRoleArn = Get-CfnOutput "AgentHarnessIam" "EditorAgentRoleArn"
    if ($EditorExecutionRoleArn -eq "" -or $EditorExecutionRoleArn -eq "None") {
        throw "Could not read EditorAgentRoleArn from AgentHarnessIam stack. Ensure Step 4 completed successfully."
    }
    Write-Info "Editor execution role: $EditorExecutionRoleArn"

    # Deploy harnesses via direct SDK script (replaces agentcore CLI)
    Write-Info "Running deploy-harnesses.ts..."
    npx ts-node scripts/deploy-harnesses.ts `
        --account-id $AccountId `
        --region $Region `
        --execution-role $EditorExecutionRoleArn
    if ($LASTEXITCODE -ne 0) { throw "deploy-harnesses.ts failed (exit $LASTEXITCODE)." }
    Write-Success "AgentCore Managed Harnesses deployed"

    # Read harness ARNs from the output artifact written by deploy-harnesses.ts
    $deployedHarnessesPath = Join-Path $RepoRoot ".deployed-harnesses.json"
    $deployedHarnesses = Get-Content $deployedHarnessesPath -Raw | ConvertFrom-Json
    $EditorHarnessArn = $deployedHarnesses.editor.arn
    $ReviewerHarnessArn = $deployedHarnesses.reviewer.arn

    if ($null -eq $EditorHarnessArn -or $EditorHarnessArn -eq "" -or $EditorHarnessArn -eq "null") {
        throw "Editor harness ARN is missing from .deployed-harnesses.json. Re-run with -FromStep 4b."
    }
    if ($null -eq $ReviewerHarnessArn -or $ReviewerHarnessArn -eq "" -or $ReviewerHarnessArn -eq "null") {
        throw "Reviewer harness ARN is missing from .deployed-harnesses.json. Re-run with -FromStep 4b."
    }

    # Save ARNs to a temp file so later steps can read them without re-prompting
    $arnsFile = Join-Path $RepoRoot ".setup-harness-arns.json"
    @{ editorHarnessArn = $EditorHarnessArn; reviewerHarnessArn = $ReviewerHarnessArn } `
        | ConvertTo-Json | Set-Content $arnsFile
    Write-Info "Harness ARNs saved to .setup-harness-arns.json (gitignored)"

    # Deploy orchestrator CDK stack
    Write-Info "Deploying orchestrator stack..."
    Write-Info "  editorHarnessArn=$EditorHarnessArn"
    Write-Info "  reviewerHarnessArn=$ReviewerHarnessArn"
    $InfraCdkDir = Join-Path $RepoRoot "infrastructure"
    Push-Location $InfraCdkDir
    try {
        npm ci --silent
        cdk deploy --all --require-approval never `
            --context "editorHarnessArn=$EditorHarnessArn" `
            --context "reviewerHarnessArn=$ReviewerHarnessArn"
        if ($LASTEXITCODE -ne 0) { throw "Orchestrator stack deploy failed." }
        Write-Success "Orchestrator stack deployed"
    } finally {
        Pop-Location
    }
}

# ---------------------------------------------------------------------------
# Step 5 - Validate config and check version drift
# ---------------------------------------------------------------------------

if (Invoke-Step "5") {
    Write-Step "5" "Validate config and check version drift"

    Push-Location $RepoRoot
    try {
        Write-Info "Running validate-config.ts..."
        npx ts-node scripts/validate-config.ts
        if ($LASTEXITCODE -ne 0) { throw "Config validation failed." }
        Write-Success "Config valid"

        Write-Info "Running check-version-drift.ts..."
        npx ts-node scripts/check-version-drift.ts
        if ($LASTEXITCODE -ne 0) { throw "Version drift detected. Update versions in agent-harness.config.json." }
        Write-Success "No version drift"

        Write-Info "Running check-terminology.ts..."
        npx ts-node scripts/check-terminology.ts
        if ($LASTEXITCODE -ne 0) { throw "Terminology check failed." }
        Write-Success "Terminology OK"
    } finally {
        Pop-Location
    }
}

# ---------------------------------------------------------------------------
# Step 5b - Verify webhook deployment
# ---------------------------------------------------------------------------

if (Invoke-Step "5b") {
    Write-Step "5b" "Verify orchestrator deployment (local-mode build)"

    # Build a concrete trigger payload so the loop has a real task to converge on
    $SessionId = "setup-verify-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())-$([guid]::NewGuid().ToString('N').Substring(0,12))"
    $CommitSha = (git rev-parse HEAD 2>$null)
    if (-not $CommitSha) { $CommitSha = "0000000000000000000000000000000000000000" }

    # Select task payload based on TaskType
    if ($TaskType -eq "fitness-gap") {
        $issueTitle = "[Fitness gap] SQS queue missing server-side encryption"
        $issueBody = "## Finding`n`nAwsSolutions-SQS2: The main SQS queue uses SQS-managed encryption (SSE-SQS) rather than a customer-managed KMS key. The module standard documented in AGENTS.md requires customer-managed KMS for all data-at-rest encryption.`n`n## Source`n`nScheduled architecture review (cdk-nag AwsSolutions rule pack + Well-Architected Security checklist WA-SEC-03).`n`n## Suggested remediation`n`nChange the queue encryption from SQS_MANAGED back to KMS using the existing EncryptionKey construct. Ensure the Lambda execution roles have kms:Decrypt permission on the key."
        Write-Info "Task type: fitness-gap (simulating scheduled reviewer finding)"
    } elseif ($TaskType -eq "discover") {
        Write-Info "Task type: discover (running reviewer to find gaps...)"
        $discoverResult = node "$RepoRoot/scripts/discover-gaps.js" --module-root "modules/fanout" 2>&1
        # Separate stderr (info messages) from stdout (JSON result)
        $jsonLine = ($discoverResult | Where-Object { $_ -match '^\{' }) -join ""
        if (-not $jsonLine) {
            Write-Host "  INFO  No findings discovered — module passes review. Nothing to remediate." -ForegroundColor Green
            return
        }
        $discovered = $jsonLine | ConvertFrom-Json
        $issueTitle = $discovered.title
        $issueBody = $discovered.body
        Write-Info "Discovered: [$($discovered.severity)] $($discovered.title)"
        Write-Info "Total findings: $($discovered.findingCount)"
    } else {
        $issueTitle = "Increase DLQ retention to 30 days and reduce maxReceiveCount to 3"
        $issueBody = "Update the dead-letter queue configuration: change retentionPeriod from 14 days to 30 days and change maxReceiveCount from 5 to 3. Update the corresponding unit test assertions to match."
        Write-Info "Task type: feature (human-initiated change)"
    }

    $TriggerPayload = @{
        issue = @{
            number = 0
            title  = $issueTitle
            body   = $issueBody
        }
        module = @{
            repository = $GithubRepo
            path       = "modules/fanout"
            ref        = "main"
            commitSha  = $CommitSha.Trim()
        }
        auth = @{
            githubInstallationToken = ""
        }
        session = $SessionId
    } | ConvertTo-Json -Compress -Depth 4

    # Use JSON syntax for --environment-variables-override to avoid comma
    # collisions between the shorthand delimiter and JSON in the payload value.
    $envOverridesJson = (@(
        @{ name = "LOCAL_MODE"; value = "true"; type = "PLAINTEXT" }
        @{ name = "TRIGGER_PAYLOAD"; value = $TriggerPayload; type = "PLAINTEXT" }
        @{ name = "SESSION_ID"; value = $SessionId; type = "PLAINTEXT" }
    ) | ConvertTo-Json -Compress -Depth 3)

    # Upload source to S3 and start build
    Write-Info "Uploading source to S3..."
    $assetsBucket = "cdk-hnb659fds-assets-$AccountId-$Region"
    $zipPath = Join-Path $env:TEMP "agent-harness-source.zip"
    Compress-Archive -Path (Get-ChildItem -Exclude "node_modules","coverage","cdk.out") -DestinationPath $zipPath -Force
    aws s3 cp $zipPath "s3://$assetsBucket/agent-harness-source.zip" --quiet
    $buildId = (aws codebuild start-build `
        --project-name agent-harness-orchestrator `
        --source-type-override S3 `
        --source-location-override "$assetsBucket/agent-harness-source.zip" `
        --buildspec-override buildspec.yml `
        --environment-variables-override $envOverridesJson `
        --query 'build.id' --output text).Trim()

    Write-Info "Build started: $buildId"
    Write-Info "Waiting for build to complete (this runs the full bounded loop)..."

    # Poll build status
    while ($true) {
        $status = (aws codebuild batch-get-builds --ids $buildId --query 'builds[0].buildStatus' --output text).Trim()
        if ($status -eq "SUCCEEDED") {
            Write-Success "Build succeeded. Orchestrator is working."
            break
        } elseif ($status -eq "IN_PROGRESS") {
            Start-Sleep -Seconds 15
        } else {
            Write-Host "  WARN  Build finished with status: $status" -ForegroundColor Yellow
            Write-Host "        Check logs: aws logs tail /aws/codebuild/agent-harness-orchestrator --since 30m" -ForegroundColor Yellow
            break
        }
    }

    Write-Info "To see full execution details:"
    Write-Info "  aws logs tail /aws/codebuild/agent-harness-orchestrator --since 30m"
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "=== Setup complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Run tasks:"
Write-Host "  .\scripts\setup.ps1 -AccountId $AccountId -FromStep 5b -TaskType feature    # Task 1: feature change"
Write-Host "  .\scripts\setup.ps1 -AccountId $AccountId -FromStep 5b -TaskType discover   # Task 2: autonomous discovery"
Write-Host ""
Write-Host "View logs:"
Write-Host "  aws logs tail /aws/codebuild/agent-harness-orchestrator --since 30m --format short"
Write-Host ""
