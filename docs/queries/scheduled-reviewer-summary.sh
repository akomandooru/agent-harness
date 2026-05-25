#!/usr/bin/env bash
# =============================================================================
# scheduled-reviewer-summary.sh
#
# Usage:
#   ./docs/queries/scheduled-reviewer-summary.sh [N] [--region REGION]
#
# Arguments:
#   N          Number of most-recent run records to return (default: 10)
#   --region   AWS region where the log group lives (default: us-east-1)
#
# Description:
#   Runs a CloudWatch Insights query against the /agent-harness/scheduled-reviewer
#   log group and prints a summary table of the last N ScheduledReviewerRunRecord
#   entries, including finding counts by severity and token cost totals.
#
# Prerequisites:
#   - AWS CLI v2 installed and configured (aws configure / environment credentials)
#   - Sufficient IAM permissions: logs:StartQuery, logs:GetQueryResults,
#     logs:DescribeLogGroups
#
# Examples:
#   ./docs/queries/scheduled-reviewer-summary.sh
#   ./docs/queries/scheduled-reviewer-summary.sh 20
#   ./docs/queries/scheduled-reviewer-summary.sh 5 --region eu-west-1
#
# Make this script executable:
#   chmod +x docs/queries/scheduled-reviewer-summary.sh
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
N=10
REGION="us-east-1"
LOG_GROUP="/agent-harness/scheduled-reviewer"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)
      REGION="$2"
      shift 2
      ;;
    --region=*)
      REGION="${1#*=}"
      shift
      ;;
    --help|-h)
      sed -n '/^# ====/,/^# ====/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    [0-9]*)
      N="$1"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [N] [--region REGION]" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# CloudWatch Insights query
# ---------------------------------------------------------------------------
# Query fields:
#   runId              — unique run identifier
#   timestamp          — ISO-8601 run timestamp
#   outcome            — "success" | "failure"
#   issuesOpened       — number of issues opened this run
#   duplicatesSkipped  — number of duplicate findings skipped
#   tokenCostUSD       — token spend for this run in USD
#   findingsBySeverity — JSON object with per-severity counts
#
# The query filters on schemaVersion = "1.0" to exclude any non-record log
# lines (e.g., raw stdout from the workflow steps).
# ---------------------------------------------------------------------------
QUERY='fields runId, timestamp, outcome, issuesOpened, duplicatesSkipped, tokenCostUSD, findingsBySeverity
| filter schemaVersion = "1.0"
| sort timestamp desc
| limit '"$N"

# ---------------------------------------------------------------------------
# Time range: last 90 days (covers typical scheduled-reviewer history)
# ---------------------------------------------------------------------------
END_TIME=$(date +%s)
START_TIME=$(( END_TIME - 90 * 24 * 3600 ))

echo "Querying CloudWatch Insights..."
echo "  Log group : $LOG_GROUP"
echo "  Region    : $REGION"
echo "  Limit     : $N records"
echo "  Time range: last 90 days"
echo ""

# ---------------------------------------------------------------------------
# Start the query
# ---------------------------------------------------------------------------
QUERY_ID=$(aws logs start-query \
  --region "$REGION" \
  --log-group-name "$LOG_GROUP" \
  --start-time "$START_TIME" \
  --end-time "$END_TIME" \
  --query-string "$QUERY" \
  --output text \
  --query 'queryId')

if [[ -z "$QUERY_ID" ]]; then
  echo "Error: failed to start CloudWatch Insights query." >&2
  exit 1
fi

echo "Query ID: $QUERY_ID"
echo "Waiting for results..."

# ---------------------------------------------------------------------------
# Poll until the query completes
# ---------------------------------------------------------------------------
STATUS="Running"
POLL_INTERVAL=2
MAX_WAIT=120
ELAPSED=0

while [[ "$STATUS" == "Running" || "$STATUS" == "Scheduled" ]]; do
  sleep "$POLL_INTERVAL"
  ELAPSED=$(( ELAPSED + POLL_INTERVAL ))

  RESPONSE=$(aws logs get-query-results \
    --region "$REGION" \
    --query-id "$QUERY_ID" \
    --output json)

  STATUS=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")

  if [[ $ELAPSED -ge $MAX_WAIT ]]; then
    echo "Error: query did not complete within ${MAX_WAIT}s." >&2
    exit 1
  fi
done

if [[ "$STATUS" != "Complete" ]]; then
  echo "Error: query ended with status '$STATUS'." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Parse and print results
# ---------------------------------------------------------------------------
python3 - "$RESPONSE" <<'PYTHON'
import sys
import json

response_json = sys.argv[1]
data = json.loads(response_json)
results = data.get("results", [])

if not results:
    print("No run records found in the last 90 days.")
    sys.exit(0)

def field(row, name):
    for f in row:
        if f["field"] == name:
            return f.get("value", "")
    return ""

# ---- Header ----------------------------------------------------------------
col_widths = {
    "runId":             36,
    "timestamp":         24,
    "outcome":            8,
    "issuesOpened":       7,
    "dupsSkipped":        7,
    "costUSD":            9,
    "findings":          30,
}

def pad(s, w):
    s = str(s)
    return s[:w].ljust(w)

header = (
    pad("Run ID",          col_widths["runId"])       + "  " +
    pad("Timestamp",       col_widths["timestamp"])   + "  " +
    pad("Outcome",         col_widths["outcome"])     + "  " +
    pad("Issues",          col_widths["issuesOpened"])+ "  " +
    pad("Dups",            col_widths["dupsSkipped"]) + "  " +
    pad("Cost (USD)",      col_widths["costUSD"])     + "  " +
    pad("Findings by severity", col_widths["findings"])
)
separator = "-" * len(header)

print(separator)
print(header)
print(separator)

total_issues  = 0
total_dups    = 0
total_cost    = 0.0

for row in results:
    run_id    = field(row, "runId")
    ts        = field(row, "timestamp")
    outcome   = field(row, "outcome")
    opened    = field(row, "issuesOpened")
    dups      = field(row, "duplicatesSkipped")
    cost_raw  = field(row, "tokenCostUSD")
    findings  = field(row, "findingsBySeverity")

    # Summarise findingsBySeverity JSON into a compact string
    try:
        sev = json.loads(findings) if findings else {}
        sev_str = ", ".join(
            f"{k.upper()}:{v}"
            for k, v in sorted(sev.items(), key=lambda x: ["info","low","medium","high","critical"].index(x[0].lower()) if x[0].lower() in ["info","low","medium","high","critical"] else 99, reverse=True)
        ) if sev else "—"
    except (json.JSONDecodeError, ValueError):
        sev_str = findings or "—"

    try:
        total_issues += int(opened)
    except ValueError:
        pass
    try:
        total_dups += int(dups)
    except ValueError:
        pass
    try:
        total_cost += float(cost_raw)
    except ValueError:
        pass

    cost_fmt = f"${float(cost_raw):.4f}" if cost_raw else "—"

    print(
        pad(run_id,   col_widths["runId"])       + "  " +
        pad(ts,       col_widths["timestamp"])   + "  " +
        pad(outcome,  col_widths["outcome"])     + "  " +
        pad(opened,   col_widths["issuesOpened"])+ "  " +
        pad(dups,     col_widths["dupsSkipped"]) + "  " +
        pad(cost_fmt, col_widths["costUSD"])     + "  " +
        pad(sev_str,  col_widths["findings"])
    )

print(separator)
print(f"Totals: {len(results)} run(s)  |  Issues opened: {total_issues}  |  Duplicates skipped: {total_dups}  |  Total cost: ${total_cost:.4f}")
print(separator)
PYTHON
