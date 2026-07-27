#!/bin/zsh

# Live QScore monitor. It never submits hidden/headless model requests; it only keeps
# the machine awake and records LM Studio state so a visible-chat interruption is explicit.
set -u

log_file="${1:-/tmp/vibelm-qscore-watchdog.log}"
interval_seconds="${QscoreWatchdogInterval:-30}"

while true; do
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  caffeinate_pid="$(pgrep -f 'caffeinate -dimsu' | head -n 1)"
  if [[ -z "$caffeinate_pid" ]]; then
    caffeinate -dimsu >/dev/null 2>&1 &
    caffeinate_pid="$!"
  fi
  model_state="$(lms ps 2>&1 | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
  print -r -- "$timestamp caffeinate_pid=$caffeinate_pid $model_state" >> "$log_file"
  sleep "$interval_seconds"
done
