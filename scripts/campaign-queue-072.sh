#!/usr/bin/env bash
# Runs cells of the real campaign for NEXUS 0.7.2 one after another. Arguments: "task:arm" ... with arm 072 or
# 072-auto. The cells run in a second checkout of the 0.7.2 sources (NEXUS_CAMPAIGN_072, a plain clone with its
# own node_modules), so that this checkout can be worked on meanwhile. Evidence goes to docs/acceptance/campaign
# of the checkout this script is in; the specifications of the 072-auto arm are read from its specs-072 folder,
# where NEXUS_CAMPAIGN_COMPILE=1 put them.
#
# Before a cell, when the five-hour usage window is at NEXUS_CAMPAIGN_STOP_AT percent (default 97) or more, the
# queue waits for the window to reset and goes on: it asks the runtime for the plan windows every twenty minutes
# (no prompt is sent) until the window is below half. A mission cut off by the limit would end paused for quota,
# which is evidence of the limit and not of NEXUS.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/docs/acceptance/campaign"
LOG="${NEXUS_CAMPAIGN_LOG:-$ROOT/test-results/campaign-queue-072.log}"
STOP_AT="${NEXUS_CAMPAIGN_STOP_AT:-97}"
DIR="${NEXUS_CAMPAIGN_072:-$LOCALAPPDATA/NexusCampaign071}"
mkdir -p "$(dirname "$LOG")"
five_hour_now() {
  (cd "$DIR" && pnpm smoke:usage 2>/dev/null) | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=s.match(/\"limitType\":\s*\"five_hour\"[^}]*?\"utilizationPercent\":\s*(\d+)/)||s.match(/\"utilizationPercent\":\s*(\d+)[^}]*?\"limitType\":\s*\"five_hour\"/);console.log(m?m[1]:'')})"
}
for cell in "$@"; do
  task="${cell%%:*}"; arm="${cell##*:}"
  last=$(ls -t "$OUT"/*.json 2>/dev/null | head -1)
  if [ -n "$last" ]; then
    five=$(node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1]));const w=((r.efficiency||{}).usageWindowsAfter||[]).find(x=>x.limitType==='five_hour');console.log(w&&w.utilizationPercent!=null?w.utilizationPercent:0)" "$last")
    while [ "${five:-0}" -ge "$STOP_AT" ]; do
      echo "$(date -u +%H:%M:%S) WAIT before $cell: five-hour window at ${five}%" >> "$LOG"
      sleep 1200
      now=$(five_hour_now)
      # No answer from the runtime is not a reset: keep waiting.
      if [ -n "$now" ] && [ "$now" -lt 50 ]; then five="$now"; fi
    done
  fi
  echo "$(date -u +%H:%M:%S) start $cell" >> "$LOG"
  (cd "$DIR" && NEXUS_CAMPAIGN_OUT="$OUT" NEXUS_CAMPAIGN_SPECS="$OUT/specs-072" NEXUS_CAMPAIGN_TASK="$task" NEXUS_CAMPAIGN_ARM="$arm" pnpm exec vitest run -c vitest.campaign.config.ts > "$ROOT/test-results/campaign-072-last.log" 2>&1)
  echo "$(date -u +%H:%M:%S) end   $cell ($(grep -E "^$task \[" "$ROOT/test-results/campaign-072-last.log" | head -1 | cut -c1-160))" >> "$LOG"
done
echo "$(date -u +%H:%M:%S) DONE" >> "$LOG"
