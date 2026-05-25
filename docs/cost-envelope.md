# Cost Envelope

Per-trigger cost structure for the agent harness. Measured ranges will be filled in after the live-fire smoke test is run against a real AWS account.

Requirements: 10.3

---

## Contents

1. [Cost components](#cost-components)
2. [Measured ranges (pending live-fire)](#measured-ranges-pending-live-fire)
3. [Token spend cap](#token-spend-cap)
4. [CloudWatch billing alarms](#cloudwatch-billing-alarms)
5. [Live-fire smoke test status](#live-fire-smoke-test-status)

---

## Cost components

Each trigger incurs costs across three categories:

### Preview infrastructure cost

The reference CDK module (`modules/fanout/`) deploys the following billable resources per trigger:

| Resource | Billing model |
|---|---|
| API Gateway REST API | Per-request ($3.50 / million requests) |
| Lambda (IngressFn, EgressFn) | Per-invocation + duration (free tier applies) |
| SNS topic | Per-publish ($0.50 / million publishes) |
| SQS queue + DLQ | Per-request ($0.40 / million requests) |
| KMS customer-managed key | $1.00 / key / month + $0.03 / 10,000 API calls |
| CloudWatch Logs | $0.50 / GB ingested |

For a single trigger with 5 iterations, the preview infrastructure cost is dominated by the KMS key (prorated to the session duration, typically under 1 hour) and a small number of Lambda invocations from the post-deploy harness. The expected range is **< $0.05 per trigger** for the reference module.

### Editor token cost

The editor agent (Claude Sonnet via Bedrock) is invoked once per iteration. Each invocation reads the session history, the module snapshot, and the sensor outputs, then produces an edit plan and file writes.

Approximate token budget per iteration on the reference module:
- Input: ~8,000–15,000 tokens (session history grows with iterations)
- Output: ~1,000–3,000 tokens (edit plan + file contents)

At Claude Sonnet on-demand pricing (Bedrock us-east-1), the expected range is **$0.50–$2.00 per trigger** across 1–5 iterations.

### Reviewer token cost

The reviewer agent (same Claude Sonnet model by default) is invoked once per iteration after the computational sensors pass. It reads the diff and the Well-Architected checklists.

Approximate token budget per invocation:
- Input: ~3,000–6,000 tokens (diff + checklist items)
- Output: ~500–1,500 tokens (structured findings)

The expected range is **$0.10–$0.50 per trigger** across 1–5 iterations.

### Total cost per trigger

| Iteration count | Estimated total |
|---|---|
| 1 (converges first try) | ~$0.60–$1.00 |
| 3 (typical) | ~$1.50–$3.00 |
| 5 (iteration cap) | ~$2.50–$5.00 |

These are pre-live-fire estimates based on model pricing and expected token volumes. See [Measured ranges](#measured-ranges-pending-live-fire) for actuals once the smoke test runs.

---

## Measured ranges (pending live-fire)

> **Status: not yet measured.** The live-fire smoke test (real AWS account, real AgentCore, real GitHub) has not been run in this environment. The ranges below will be filled in after the first end-to-end run.

| Metric | Measured value | Notes |
|---|---|---|
| Preview infra cost per trigger | _TBD_ | Measured from AWS Cost Explorer, filtered by `agent-harness/session` tag |
| Editor token cost per trigger (1 iteration) | _TBD_ | From AgentCore session `costs.editorTokensUSD` |
| Editor token cost per trigger (3 iterations) | _TBD_ | |
| Editor token cost per trigger (5 iterations) | _TBD_ | |
| Reviewer token cost per trigger (1 iteration) | _TBD_ | From AgentCore session `costs.reviewerTokensUSD` |
| Reviewer token cost per trigger (3 iterations) | _TBD_ | |
| Reviewer token cost per trigger (5 iterations) | _TBD_ | |
| Total cost per trigger (1 iteration) | _TBD_ | |
| Total cost per trigger (3 iterations) | _TBD_ | |
| Total cost per trigger (5 iterations) | _TBD_ | |

To fill in these values after a live-fire run:

1. Open the AgentCore session record for the trigger. The `costs` object contains `editorTokensUSD`, `reviewerTokensUSD`, and `previewInfraUSD`.
2. Cross-check `previewInfraUSD` against AWS Cost Explorer filtered by the session tag (`agent-harness/session = <session-id>`).
3. Update the table above and commit the change.

---

## Token spend cap

The loop halts with reason `token-cap` when the combined editor and reviewer token spend reaches the configured cap:

```json
"limits": {
  "tokenSpendCapUSD": 10.0
}
```

**Default: 10 USD per trigger.** This is conservative for a Claude Sonnet-class model on the reference module across five iterations with reviewer overhead. It is set to prevent runaway costs during development and should be revisited once measured ranges are available.

To adjust the cap, edit `agent-harness.config.json` at the repo root. The change takes effect on the next trigger; in-flight sessions use the cap that was active when the session started.

If the measured cost per trigger (from the table above) is significantly lower than 10 USD, consider lowering the cap to match your team's risk tolerance. If a trigger legitimately needs more than 10 USD (e.g., a large module with many iterations), raise the cap and document the rationale.

---

## CloudWatch billing alarms

Set a monthly budget alarm to catch unexpected cost spikes. The recommended alarm monitors `EstimatedCharges` for Amazon Bedrock:

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name "AgentHarness-MonthlyBudget" \
  --metric-name EstimatedCharges \
  --namespace AWS/Billing \
  --statistic Maximum \
  --period 86400 \
  --threshold 50 \
  --comparison-operator GreaterThanThreshold \
  --dimensions Name=ServiceName,Value=AmazonBedrock \
  --evaluation-periods 1 \
  --alarm-actions <your-sns-topic-arn>
```

Replace `50` with your monthly budget threshold in USD. Replace `<your-sns-topic-arn>` with an SNS topic that notifies your team (email, Slack, PagerDuty, etc.).

See `docs/runbook.md` for the full cost guardrails reference, including how to adjust the per-trigger token spend cap.

---

## Live-fire smoke test status

The live-fire smoke test (open an issue from the template with the example trigger "add a dead-letter queue to the SQS subscriber", apply `agent-task`, watch a successful PR open end-to-end against a clean preview environment, confirm teardown on PR close) **requires a real AWS account with AgentCore access and a configured GitHub repository**.

This test cannot be run in the current development environment. It is deferred to when the template is deployed to a real AWS account. Once run:

1. Record the session costs in the [Measured ranges](#measured-ranges-pending-live-fire) table above.
2. Tag the release (`git tag v1.0.0`).
3. Update the `docs/quickstart.md` with any corrections to the documented 30-minute happy path.

The `tokenSpendCapUSD` default (10 USD) will be revisited after the live-fire run. If the measured cost across iteration counts is meaningfully different (off by 2× or more), the cap is revised and both the spec and the design are updated before the release tag.
