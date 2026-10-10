#!/usr/bin/env bash
# Runs cells of the real quality campaign one after another. Arguments: "task:arm" ...
# The 0.7.0 arm runs in a checkout of v0.7.0, the others in a checkout of the 0.7.1 branch (their paths are
# NEXUS_CAMPAIGN_070 and NEXUS_CAMPAIGN_071; see docs/V0_7_1_RELEASE_REPORT.md for how they are made).
# Evidence goes to docs/acceptance/campaign of the checkout this script is in.
#
# The queue stops before a cell when the five-hour usage window is at NEXUS_CAMPAIGN_STOP_AT percent (default
# 97): a mission cut off by the limit ends paused for quota, which is evidence of the limit and not of NEXUS.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/docs/acceptance/campaign"
LOG="${NEXUS_CAMPAIGN_LOG:-$ROOT/test-results/campaign-queue.log}"
STOP_AT="${NEXUS_CAMPAIGN_STOP_AT:-97}"
D070="${NEXUS_CAMPAIGN_070:-$LOCALAPPDATA/NexusCampaign070}"
D071="${NEXUS_CAMPAIGN_071:-$LOCALAPPDATA/NexusCampaign071}"
mkdir -p "$(dirname "$LOG")"
for cell in "$@"; do
  task="${cell%%:*}"; arm="${cell##*:}"
  if [ "$arm" = "070" ]; then dir="$D070"; else dir="$D071"; fi
  last=$(ls -t "$OUT"/*.json 2>/dev/null | head -1)
  if [ -n "$last" ]; then
    five=$(node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1]));const w=(r.efficiency.usageWindowsAfter||[]).find(x=>x.limitType==='five_hour');console.log(w&&w.utilizationPercent!=null?w.utilizationPercent:0)" "$last")
    if [ "$five" -ge "$STOP_AT" ]; then echo "$(date -u +%H:%M:%S) STOP before $cell: five-hour window at ${five}%" >> "$LOG"; exit 3; fi
  fi
  echo "$(date -u +%H:%M:%S) start $cell" >> "$LOG"
  (cd "$dir" && NEXUS_CAMPAIGN_OUT="$OUT" NEXUS_CAMPAIGN_TASK="$task" NEXUS_CAMPAIGN_ARM="$arm" pnpm exec vitest run -c vitest.campaign.config.ts > /dev/null 2>&1)
  echo "$(date -u +%H:%M:%S) end   $cell" >> "$LOG"
done
echo "$(date -u +%H:%M:%S) DONE" >> "$LOG"
