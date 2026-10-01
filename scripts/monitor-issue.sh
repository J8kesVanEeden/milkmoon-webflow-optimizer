#!/usr/bin/env bash
# One GitHub issue per monitor tier — opened on failure, commented while still failing, closed when
# green again. GitHub emails the owner on open/comment. Needs GH_TOKEN with issues:write.
# Usage: bash scripts/monitor-issue.sh <live|daily|heartbeat> <exit-status> <report.md>
set -euo pipefail
MODE="$1"; STATUS="$2"; REPORT="$3"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"
LABEL=monitor
gh label create "$LABEL" --color B60205 --description "Automated monitor alert" 2>/dev/null || true

if [ "$MODE" = heartbeat ]; then
  TITLE="Monitor heartbeat"
  N=$(gh issue list --label "$LABEL" --state all --search "in:title \"Monitor:\"" --limit 200 --json number --jq length)
  RUNS=$(gh run list --workflow monitor.yml --limit 1000 --json createdAt,conclusion \
    --jq "[.[] | select(.createdAt > \"$(date -u -d '-31 days' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-31d +%Y-%m-%dT%H:%M:%SZ)\")] | \"\(length) runs, \([.[]|select(.conclusion==\"failure\")]|length) red\"")
  BODY="Monitor alive $(date -u +%Y-%m-%d). Last 31 days: $RUNS. Alert issues ever opened: $N."
  NUM=$(gh issue list --label "$LABEL" --state open --search "in:title \"$TITLE\"" --json number --jq '.[0].number // empty')
  if [ -n "$NUM" ]; then gh issue comment "$NUM" --body "$BODY"; else gh issue create --title "$TITLE" --label "$LABEL" --body "$BODY"; fi
  exit 0
fi

TITLE="Monitor: $MODE check failing"
NUM=$(gh issue list --label "$LABEL" --state open --search "in:title \"$TITLE\"" --json number --jq '.[0].number // empty')
if [ "$STATUS" != 0 ]; then
  # MONITOR_RUNBOOK (optional repo variable) is appended — e.g. who approves rollbacks for this install.
  BODY=$(printf '%s\n\nRun: %s\n\n**If the Worker is at fault**, go back to the previous version (Cloudflare dashboard → Workers → your Worker → Deployments). **Most Webflow-side changes are NOT fixed by going back** — check the details above first. %s\n' "$(cat "$REPORT")" "$RUN_URL" "${MONITOR_RUNBOOK:-}")
  if [ -n "$NUM" ]; then gh issue comment "$NUM" --body "Still failing.

$BODY"
  else gh issue create --title "$TITLE" --label "$LABEL" --body "$BODY"; fi
elif [ -n "$NUM" ]; then
  gh issue close "$NUM" --comment "✅ Green again at $(date -u '+%Y-%m-%d %H:%M UTC'). $RUN_URL"
fi
